// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

const TIMEOUT = 20000;

// ---------- helpers ----------
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const nowMs = () => Date.now();

/**
 * Convert a payload into a list of orders.
 * Handles many shapes, including your legacy shape with `ResourceList`.
 */
const listify = (data) => {
  if (Array.isArray(data)) return data;
  const candidates = [
    "ResourceList", // <== your tenant
    "data",
    "results", "Results",
    "items", "Items",
    "orders", "Orders",
    "records", "Records",
    "value", "Value",
    "list", "List",
  ];
  for (const k of candidates) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
};

/**
 * Try to locate line items within an order object across common shapes.
 * Returns an array (possibly empty).
 */
function extractItems(order) {
  if (!order || typeof order !== "object") return [];
  const candidates = [
    order.items,
    order.Items,
    order.OrderLineItems,
    order.Lines,
    order.OrderDetails,
    order.Details?.OrderLineItems,
    order.Detail?.OrderLineItems,
  ].filter(Boolean);

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * Normalize an item into fields our SQL expects.
 */
function mapItemForSql(it) {
  const orderItemId =
    it?.id ??
    it?.orderItemId ??
    it?.OrderLineItemId ??
    it?.OrderItemID ??
    it?.OrderItemId ??
    null;

  const sku =
    it?.sku ??
    it?.SKU ??
    it?.ItemId ??
    it?.ItemID ??
    it?.ItemCode ??
    it?.ItemIdentifier?.Sku ??
    it?.ItemIdentifier?.SKU ??
    it?.ItemIdentifier?.ItemCode ??
    "";

  const orderedQty = Number(
    it?.quantity ?? it?.Quantity ?? it?.Qty ?? it?.OrderedQty ?? 0
  );

  const qualifier =
    it?.qualifier ??
    it?.Qualifier ??
    it?.UOM ??
    (it?.UnitOfMeasure?.Name || it?.UnitOfMeasure) ??
    "";

  return { orderItemId, sku, orderedQty, qualifier };
}

// ---------------- AUTH (Basic or Bearer) ----------------
let tokenCache = { token: null, exp: 0, winner: null };

export async function getAccessToken() {
  if (tokenCache.token && nowMs() < tokenCache.exp - 60_000) return tokenCache.token;

  const b64 =
    process.env.EXT_BASIC_AUTH_B64 ||
    (process.env.EXT_CLIENT_ID && process.env.EXT_CLIENT_SECRET
      ? Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64")
      : null);

  if (!b64) throw new Error("Bearer mode: missing EXT_BASIC_AUTH_B64 or EXT_CLIENT_ID/EXT_CLIENT_SECRET");

  const userLogin   = process.env.EXT_USER_LOGIN || "";
  const userLoginId = process.env.EXT_USER_LOGIN_ID;
  const tplguid     = process.env.EXT_TPL_GUID;
  const tpl         = process.env.EXT_TPL || process.env.EXT_TPL_ID;

  const endpoints = [];
  if (process.env.EXT_TOKEN_URL) endpoints.push({ url: trimBase(process.env.EXT_TOKEN_URL), style: "form" });
  endpoints.push(
    { url: "https://box.secure-wms.com/oauth/token", style: "form" },
    { url: "https://secure-wms.com/oauth/token",     style: "form" },
    { url: "https://secure-wms.com/AuthServer/api/Token", style: "json" },
    { url: "https://box.secure-wms.com/AuthServer/api/Token", style: "json" }
  );

  const userKeys = userLoginId ? [["user_login_id", String(userLoginId)], ["user_login", String(userLogin)]] 
                               : [["user_login", String(userLogin)]];
  const tplKeys  = tplguid ? [["tplguid", String(tplguid)], ...(tpl ? [["tpl", String(tpl)]] : [])]
                           : (tpl ? [["tpl", String(tpl)]] : [["tpl", ""]]);

  const attempts = [];
  for (const ep of endpoints) {
    for (const [uKey, uVal] of userKeys) {
      for (const [tKey, tVal] of tplKeys) {
        try {
          let data, headers;
          if (ep.style === "form") {
            const form = new URLSearchParams({ grant_type: "client_credentials", [uKey]: uVal });
            if (tVal) form.append(tKey, tVal);
            data = form;
            headers = { "Content-Type": "application/x-www-form-urlencoded" };
          } else {
            const body = { grant_type: "client_credentials", [uKey]: uVal };
            if (tVal) body[tKey] = tVal;
            data = body;
            headers = { "Content-Type": "application/json" };
          }

          const r = await axios.post(ep.url, data, {
            headers: { ...headers, Accept: "application/json", Authorization: `Basic ${b64}` },
            timeout: TIMEOUT,
          });
          const { access_token, expires_in = 1800 } = r.data || {};
          if (!access_token) throw new Error(`No access_token from ${ep.url}`);
          tokenCache = { token: access_token, exp: nowMs() + expires_in * 1000, winner: { ...ep, uKey, tKey } };
          if (process.env.LOG_TOKEN_DEBUG === "true") console.log("[OAuth winner]", tokenCache.winner);
          return access_token;
        } catch (e) {
          attempts.push({ url: ep.url, style: ep.style, uKey, tKey, status: e.response?.status || null, data: e.response?.data || String(e.message) });
        }
      }
    }
  }
  throw new Error("All token endpoints failed: " + JSON.stringify(attempts.slice(0, 6), null, 2));
}

export async function authHeaders() {
  const mode = (process.env.EXT_AUTH_MODE || "basic").toLowerCase();
  const h = { Accept: "application/json", "Content-Type": "application/json" };

  if (mode === "bearer") {
    const token = await getAccessToken();
    h.Authorization = `Bearer ${token}`;
  } else {
    const b64 =
      process.env.EXT_BASIC_AUTH_B64 ||
      Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64");
    h.Authorization = `Basic ${b64}`;
  }

  // Scoping preferred via headers on legacy
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

// ---------------- Fetch orders and upsert to SQL ----------------
export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const pool = await getPool();

  // Use legacy first (no query params), then fallbacks (with params if ever needed)
  const endpoints = [
    { url: `${base}/orders`, isLegacy: true },
    { url: `${base}/api/v1/orders`, isLegacy: false },
    { url: `${base}/api/orders`, isLegacy: false },
  ];

  let importedHeaders = 0;
  let upsertedItems = 0;

  // One pass for legacy (no paging supported / allowed). If it fails, fall back to others.
  let orders = [];
  let lastErr = null;

  const headers = await authHeaders();
  for (const ep of endpoints) {
    try {
      const resp = await axios.get(ep.url, {
        headers,
        ...(ep.isLegacy
          ? {}
          : {
              params: {
                page: 1,
                pageSize,
                ...(modifiedSince ? { modifiedDateStart: modifiedSince } : {}),
                ...(status ? { status } : {}),
              },
            }),
        timeout: TIMEOUT,
      });
      orders = listify(resp.data);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const s = e.response?.status;
      if (![400, 401, 403, 404].includes(s)) throw e;
    }
  }

  if (lastErr) {
    console.error("[Extensiv /orders error]", lastErr.response?.status, lastErr.response?.data || lastErr.message);
    throw lastErr;
  }
  importedHeaders = Array.isArray(orders) ? orders.length : 0;
  if (!importedHeaders) return { importedHeaders: 0, upsertedItems: 0 };

  // Upsert line items if present
  const tx = new sql.Transaction(await getPool());
  await tx.begin();
  try {
    const req = new sql.Request(tx);
    for (const o of orders) {
      const items = extractItems(o);
      if (!items.length) continue;

      for (const it of items) {
        const { orderItemId, sku, orderedQty, qualifier } = mapItemForSql(it);
        if (orderItemId == null && !sku) continue; // nothing to index

        await req
          .input("OrderItemID", sql.Int, orderItemId)
          .input("ItemID", sql.VarChar(100), sku)
          .input("Qualifier", sql.VarChar(50), qualifier)
          .input("OrderedQty", sql.Int, orderedQty)
          .query(`
            MERGE [dbo].[OrderDetails] AS t
            USING (SELECT @OrderItemID AS OrderItemID) s
            ON t.OrderItemID = s.OrderItemID
            WHEN MATCHED THEN 
              UPDATE SET ItemID=@ItemID, Qualifier=@Qualifier, OrderedQTY=@OrderedQty
            WHEN NOT MATCHED THEN 
              INSERT (OrderItemID, ItemID, Qualifier, OrderedQTY)
              VALUES (@OrderItemID, @ItemID, @Qualifier, @OrderedQty);
          `);
        upsertedItems++;
      }
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    console.error("[SQL upsert error]", e);
    throw e;
  }

  return { importedHeaders, upsertedItems };
}
