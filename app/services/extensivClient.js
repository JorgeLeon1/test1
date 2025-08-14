// src/app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

/* --------------------------- auth helpers --------------------------- */

const trimBase = (u) => (u || "").replace(/\/+$/, "");

function basicHeaderFromEnv() {
  const b64 = process.env.EXT_BASIC_AUTH_B64 || "";
  return b64 ? `Basic ${b64}` : null;
}

async function getBearerViaOAuth() {
  const tokenUrl = process.env.EXT_TOKEN_URL;
  if (!tokenUrl) return null;

  try {
    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");
    if (process.env.EXT_USER_LOGIN)     form.set("user_login",     process.env.EXT_USER_LOGIN);
    if (process.env.EXT_USER_LOGIN_ID)  form.set("user_login_id",  process.env.EXT_USER_LOGIN_ID);
    if (process.env.EXT_TPL_GUID)       form.set("tplguid",        process.env.EXT_TPL_GUID);

    const auth = basicHeaderFromEnv(); // base64(clientId:clientSecret)
    const resp = await axios.post(tokenUrl, form, {
      headers: {
        Authorization: auth || "",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (resp.status >= 200 && resp.status < 300 && resp.data?.access_token) {
      return `Bearer ${resp.data.access_token}`;
    }
    return null;
  } catch {
    return null;
  }
}

export async function authHeaders() {
  const mode = (process.env.EXT_AUTH_MODE || "").toLowerCase();
  if (mode === "bearer") {
    const bearer = await getBearerViaOAuth();
    if (bearer) {
      return {
        Authorization: bearer,
        Accept: "application/hal+json, application/json",
        "Content-Type": "application/hal+json; charset=utf-8",
      };
    }
    // fall back to basic if bearer failed
  }

  const basic = basicHeaderFromEnv();
  if (!basic) {
    throw new Error("No auth configured: set EXT_BASIC_AUTH_B64 or EXT_TOKEN_URL (+ client id/secret).");
  }
  return {
    Authorization: basic,
    Accept: "application/hal+json, application/json",
    "Content-Type": "application/hal+json; charset=utf-8",
  };
}

/* --------------------------- API primitives -------------------------- */

function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj?.ResourceList)) return obj.ResourceList;
  if (Array.isArray(obj?._embedded?.["http://api.3plCentral.com/rels/orders/order"])) {
    return obj._embedded["http://api.3plCentral.com/rels/orders/order"];
  }
  if (Array.isArray(obj?.data)) return obj.data;
  for (const v of Object.values(obj || {})) if (Array.isArray(v)) return v;
  return [];
}

function extractOrderItems(order) {
  // HAL list of items
  const em = order?._embedded;
  if (em && Array.isArray(em["http://api.3plCentral.com/rels/orders/item"])) {
    return em["http://api.3plCentral.com/rels/orders/item"];
  }
  // other shapes we’ve seen
  if (Array.isArray(order?.OrderItems)) return order.OrderItems;
  if (Array.isArray(order?.Items)) return order.Items;
  return [];
}

function readOnly(o) { return o?.readOnly || o?.ReadOnly || {}; }

/* 
  Legacy list:
  GET {base}/orders?pgsiz=100&pgnum=1&detail=OrderItems&itemdetail=All
*/
async function legacyListOrders({ pgsiz = 100, pgnum = 1 } = {}) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  const resp = await axios.get(`${base}/orders`, {
    headers,
    params: {
      pgsiz,
      pgnum,
      detail: "OrderItems",   // include items so we can upsert details in one pass
      itemdetail: "All",
    },
    timeout: 30000,
  });
  return resp.data;
}

/* Fetch one order (best-effort) */
export async function fetchOneOrderDetail(orderId) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  // Preferred: RQL filter by readOnly.orderId
  try {
    const { data } = await axios.get(`${base}/orders`, {
      headers,
      params: { pgsiz: 1, pgnum: 1, detail: "OrderItems", itemdetail: "All", rql: `readOnly.orderId==${orderId}` },
      timeout: 20000,
    });
    const list = firstArray(data);
    return list[0] || null;
  } catch {
    const page = await legacyListOrders({ pgsiz: 100, pgnum: 1 });
    const list = firstArray(page);
    return list.find(o => readOnly(o).orderId === orderId || readOnly(o).OrderId === orderId) || null;
  }
}

/* ------------------------------ DB setup ------------------------------ */

async function ensureTables(pool) {
  await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
BEGIN
  CREATE TABLE dbo.OrderDetails (
    OrderItemID INT NOT NULL,
    OrderId     INT NULL,
    ItemID      VARCHAR(100) NULL,
    Qualifier   VARCHAR(50)  NULL,
    OrderedQTY  INT          NULL,
    CONSTRAINT PK_OrderDetails PRIMARY KEY (OrderItemID)
  );
END
`);
}

/* ----------------------------- Main import ---------------------------- */
/**
 * Pull orders with items and upsert into dbo.OrderDetails
 * Robust: dedupes by OrderItemID, upserts without MERGE, chunked transactions, returns errors.
 */
export async function fetchAndUpsertOrders({ maxPages = 10, pageSize = 200 } = {}) {
  const pool = await getPool();
  await ensureTables(pool);

  let importedHeaders = 0;
  let upsertedItems = 0;
  const errors = [];

  for (let page = 1; page <= maxPages; page++) {
    // 1) fetch a page with items
    let payload;
    try {
      payload = await legacyListOrders({ pgsiz: pageSize, pgnum: page });
    } catch (e) {
      const st = e.response?.status;
      const dt = e.response?.data;
      throw new Error(`Orders GET failed (status ${st}) ${typeof dt === 'string' ? dt : JSON.stringify(dt)}`);
    }

    const orders = firstArray(payload);
    if (!orders.length) break;
    importedHeaders += orders.length;

    // 2) flatten items
    const flatItems = [];
    for (const ord of orders) {
      const ro = readOnly(ord);
      const orderId = ro.OrderId ?? ro.orderId ?? ord.OrderId ?? ord.orderId ?? null;

      for (const it of extractOrderItems(ord)) {
        const iro = readOnly(it);
        const orderItemId =
          iro.orderItemId ?? it.orderItemId ?? it.OrderItemId ?? it.id ?? null;

        const sku =
          it?.itemIdentifier?.sku ??
          it?.ItemIdentifier?.Sku ??
          it?.sku ??
          it?.SKU ?? null;

        const qualifier = it?.qualifier ?? it?.Qualifier ?? "";
        const qty = Number(it?.qty ?? it?.Qty ?? it?.OrderedQty ?? it?.orderedQty ?? 0) || 0;

        if (orderItemId && sku) {
          flatItems.push({ orderItemId, orderId, sku, qualifier, qty });
        }
      }
    }

    // 3) dedupe by OrderItemID
    const map = new Map();
    for (const x of flatItems) if (!map.has(x.orderItemId)) map.set(x.orderItemId, x);
    const deduped = Array.from(map.values());

    // 4) chunked upsert
    const chunkSize = 200;
    for (let i = 0; i < deduped.length; i += chunkSize) {
      const chunk = deduped.slice(i, i + chunkSize);
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const req = new sql.Request(tx);
        for (const it of chunk) {
          await req
            .input("OrderItemID", sql.Int, it.orderItemId)
            .input("OrderId",     sql.Int, it.orderId ?? null)
            .input("ItemID",      sql.VarChar(100), it.sku)
            .input("Qualifier",   sql.VarChar(50),  it.qualifier ?? "")
            .input("OrderedQTY",  sql.Int, it.qty ?? 0)
            .query(`
IF EXISTS (SELECT 1 FROM dbo.OrderDetails WITH (UPDLOCK, HOLDLOCK) WHERE OrderItemID=@OrderItemID)
  UPDATE dbo.OrderDetails
     SET OrderId=@OrderId, ItemID=@ItemID, Qualifier=@Qualifier, OrderedQTY=@OrderedQTY
   WHERE OrderItemID=@OrderItemID;
ELSE
  INSERT INTO dbo.OrderDetails (OrderItemID, OrderId, ItemID, Qualifier, OrderedQTY)
  VALUES (@OrderItemID, @OrderId, @ItemID, @Qualifier, @OrderedQTY);
            `);
          upsertedItems++;
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        errors.push({
          page,
          chunkStart: i,
          message: e.message,
          number: e.number,
          code: e.code
        });
      }
    }

    if (orders.length < pageSize) break; // last page
  }

  if (errors.length) {
    return { ok: false, importedHeaders, upsertedItems, errors };
  }
  return { importedHeaders, upsertedItems };
}
