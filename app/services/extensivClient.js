// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

const TIMEOUT = 20000;
const CONCURRENCY = Number(process.env.EXT_FETCH_DETAILS_CONCURRENCY || 5);

const trimBase = (u) => (u || "").replace(/\/+$/, "");
const nowMs = () => Date.now();

// -------- list helpers --------
const listify = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.ResourceList)) return data.ResourceList; // legacy list
  if (Array.isArray(data?.data)) return data.data;
  // try any first array value as last resort
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  }
  return [];
};

const getOrderId = (o) =>
  o?.ReadOnly?.OrderId ?? o?.OrderId ?? o?.orderId ?? o?.Id ?? o?.ID ?? o?.id ?? null;

// -------- item helpers --------
function extractItems(payload) {
  if (!payload || typeof payload !== "object") return [];
  const cands = [
    payload.items, payload.Items,
    payload.OrderLineItems, payload.Lines,
    payload.OrderDetails, payload.Details?.OrderLineItems,
    payload.Detail?.OrderLineItems
  ].filter(Boolean);
  for (const c of cands) if (Array.isArray(c)) return c;
  // sometimes items wrapped under ResourceList for detail endpoint
  if (Array.isArray(payload?.ResourceList)) return payload.ResourceList;
  return [];
}

function mapItemForSql(it) {
  const orderItemId =
    it?.OrderLineItemId ?? it?.OrderItemID ?? it?.OrderItemId ?? it?.orderItemId ?? it?.id ?? null;

  const sku =
    it?.SKU ?? it?.sku ?? it?.ItemID ?? it?.ItemId ?? it?.ItemCode ??
    it?.ItemIdentifier?.Sku ?? it?.ItemIdentifier?.SKU ?? it?.ItemIdentifier?.ItemCode ?? "";

  const orderedQty = Number(
    it?.OrderedQty ?? it?.Quantity ?? it?.Qty ?? it?.quantity ?? 0
  );

  const qualifier =
    it?.Qualifier ?? it?.qualifier ?? it?.UOM ??
    (it?.UnitOfMeasure?.Name || it?.UnitOfMeasure) ?? "";

  return { orderItemId, sku, orderedQty, qualifier };
}

// -------- auth --------
let tokenCache = { token: null, exp: 0 };

async function getAccessToken() {
  if (tokenCache.token && nowMs() < tokenCache.exp - 60_000) return tokenCache.token;

  // Basic (client_id:client_secret) → Bearer token
  const b64 =
    process.env.EXT_BASIC_AUTH_B64 ||
    (process.env.EXT_CLIENT_ID && process.env.EXT_CLIENT_SECRET
      ? Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64")
      : null);

  if (!b64) throw new Error("Bearer mode: missing EXT_BASIC_AUTH_B64 or EXT_CLIENT_ID/EXT_CLIENT_SECRET");

  const tokenEndpoints = [
    process.env.EXT_TOKEN_URL,
    "https://box.secure-wms.com/oauth/token",
    "https://secure-wms.com/oauth/token",
    "https://secure-wms.com/AuthServer/api/Token",
    "https://box.secure-wms.com/AuthServer/api/Token"
  ].filter(Boolean);

  const userLogin   = process.env.EXT_USER_LOGIN || "";
  const userLoginId = process.env.EXT_USER_LOGIN_ID;
  const tplguid     = process.env.EXT_TPL_GUID;
  const bodyBase = { grant_type: "client_credentials" };
  if (userLoginId) bodyBase.user_login_id = String(userLoginId); else bodyBase.user_login = userLogin;
  if (tplguid) bodyBase.tplguid = String(tplguid);

  let lastErr;
  for (const url of tokenEndpoints) {
    try {
      const isJson = /AuthServer\/api\/Token$/.test(url);
      const data = isJson ? bodyBase : new URLSearchParams(bodyBase);
      const headers = {
        Accept: "application/json",
        Authorization: `Basic ${b64}`,
        "Content-Type": isJson ? "application/json" : "application/x-www-form-urlencoded",
      };
      const r = await axios.post(url, data, { headers, timeout: TIMEOUT });
      const { access_token, expires_in = 1800 } = r.data || {};
      if (!access_token) throw new Error(`No access_token from ${url}`);
      tokenCache = { token: access_token, exp: nowMs() + expires_in * 1000 };
      return access_token;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("OAuth token failed (no endpoints worked)");
}

export async function authHeaders() {
  const mode = (process.env.EXT_AUTH_MODE || "basic").toLowerCase();
  const h = { Accept: "application/json" };

  if (mode === "bearer") {
    const token = await getAccessToken();
    h.Authorization = `Bearer ${token}`;
  } else {
    const b64 =
      process.env.EXT_BASIC_AUTH_B64 ||
      Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64");
    h.Authorization = `Basic ${b64}`;
  }

  // legacy scoping prefers headers
  if (process.env.EXT_CUSTOMER_IDS) {
    h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS;
    h["CustomerIDs"] = process.env.EXT_CUSTOMER_IDS;
  }
  if (process.env.EXT_FACILITY_IDS) {
    h["FacilityIds"] = process.env.EXT_FACILITY_IDS;
    h["FacilityIDs"] = process.env.EXT_FACILITY_IDS;
  }
  if (process.env.EXT_WAREHOUSE_ID) h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID)  h["3PL-Customer-Id"]  = process.env.EXT_CUSTOMER_ID;
  if (process.env.EXT_USER_LOGIN)   h["User-Login"]       = process.env.EXT_USER_LOGIN;
  if (process.env.EXT_USER_LOGIN_ID)h["User-Login-Id"]    = process.env.EXT_USER_LOGIN_ID;

  return h;
}

// -------- detail fetcher (tries several URLs/expansions) --------
async function fetchOrderDetails(base, headers, orderId) {
  const urls = [
    `${base}/orders/${orderId}`,
    `${base}/orders/${orderId}/details`,
    `${base}/orders/${orderId}/items`,
    `${base}/api/v1/orders/${orderId}`,
    `${base}/api/v1/orders/${orderId}/items`,
  ];
  const paramsList = [
    undefined,
    { expand: "OrderLineItems,Items,Details" },
  ];

  for (const url of urls) {
    for (const params of paramsList) {
      try {
        const r = await axios.get(url, { headers, params, timeout: TIMEOUT });
        return r.data;
      } catch (_e) { /* try next */ }
    }
  }
  return null;
}

async function runPool(ids, worker) {
  const q = [...ids];
  const running = new Set();
  const results = [];
  while (q.length || running.size) {
    while (q.length && running.size < CONCURRENCY) {
      const id = q.shift();
      const p = Promise.resolve().then(() => worker(id))
        .then((r) => { results.push(r); running.delete(p); })
        .catch((_e) => { running.delete(p); });
      running.add(p);
    }
    if (running.size) await Promise.race(running);
  }
  return results;
}

// -------- main: fetch headers → details → upsert items --------
export async function fetchAndUpsertOrders({ pageSize = 100, modifiedSince, status } = {}) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();
  const pool = await getPool();

  // ensure table exists & has OrderId
  await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
BEGIN
  CREATE TABLE dbo.OrderDetails (
    OrderItemID INT NULL,
    OrderId     INT NULL,
    ItemID      VARCHAR(100) NULL,
    Qualifier   VARCHAR(50) NULL,
    OrderedQTY  INT NULL
  );
END
ELSE
BEGIN
  IF COL_LENGTH('dbo.OrderDetails','OrderId') IS NULL
    ALTER TABLE dbo.OrderDetails ADD OrderId INT NULL;
END
  `);

  // 1) Headers (legacy first; no pagination params)
  const listUrls = [
    { url: `${base}/orders`, legacy: true },
    { url: `${base}/api/v1/orders`, legacy: false },
    { url: `${base}/api/orders`, legacy: false },
  ];
  let orders = [];
  for (const u of listUrls) {
    try {
      const resp = await axios.get(u.url, {
        headers,
        ...(u.legacy ? {} : { params: { page: 1, pageSize, ...(modifiedSince ? { modifiedDateStart: modifiedSince } : {}), ...(status ? { status } : {}) } }),
        timeout: TIMEOUT,
      });
      orders = listify(resp.data);
      if (orders.length) break;
    } catch (_e) { /* try next */ }
  }
  const importedHeaders = orders.length;

  if (!importedHeaders) return { importedHeaders: 0, upsertedItems: 0 };

  // 2) Details (to get items)
  const headerIds = orders.map(getOrderId).filter((x) => x != null);
  const detailPayloads = await runPool(headerIds, (id) => fetchOrderDetails(base, headers, id));

  // 3) Upsert items (supports null OrderItemID via composite key)
  let upsertedItems = 0;
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const req = new sql.Request(tx);

    for (let i = 0; i < detailPayloads.length; i++) {
      const p = detailPayloads[i];
      if (!p) continue;

      const orderId = getOrderId(p) ?? headerIds[i];
      const items = extractItems(p);
      if (!items.length) continue;

      for (const it of items) {
        const { orderItemId, sku, orderedQty, qualifier } = mapItemForSql(it);
        if (!sku) continue;

        await req
          .input("OrderItemID", sql.Int, orderItemId)
          .input("OrderId",     sql.Int, orderId ?? null)
          .input("ItemID",      sql.VarChar(100), sku)
          .input("Qualifier",   sql.VarChar(50), qualifier || "")
          .input("OrderedQty",  sql.Int, orderedQty)
          .query(`
IF @OrderItemID IS NOT NULL
BEGIN
  MERGE dbo.OrderDetails AS t
  USING (SELECT @OrderItemID AS OrderItemID) s
  ON (t.OrderItemID = s.OrderItemID)
  WHEN MATCHED THEN
    UPDATE SET ItemID=@ItemID, Qualifier=@Qualifier, OrderedQTY=@OrderedQty, OrderId = @OrderId
  WHEN NOT MATCHED THEN
    INSERT (OrderItemID, OrderId, ItemID, Qualifier, OrderedQTY)
    VALUES (@OrderItemID, @OrderId, @ItemID, @Qualifier, @OrderedQty);
END
ELSE
BEGIN
  UPDATE dbo.OrderDetails
     SET OrderedQTY=@OrderedQty, OrderId = @OrderId
   WHERE ISNULL(OrderId,-1)=ISNULL(@OrderId,-1)
     AND ItemID=@ItemID
     AND ISNULL(Qualifier,'')=ISNULL(@Qualifier,'');
  IF @@ROWCOUNT = 0
    INSERT (OrderItemID, OrderId, ItemID, Qualifier, OrderedQTY)
    VALUES (NULL, @OrderId, @ItemID, @Qualifier, @OrderedQty);
END
          `);

        upsertedItems++;
      }
    }

    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }

  return { importedHeaders, upsertedItems };
}

// --- optional: expose a single-order detail fetcher for debugging routes ---
export async function fetchOneOrderDetail(orderId) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();
  return await fetchOrderDetails(base, headers, orderId);
}
