// src/app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

/* ============== helpers ============== */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const safeStr = (v, max) => (v == null ? null : String(v).normalize("NFC").slice(0, max));
const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const readOnly = (o) => o?.readOnly || o?.ReadOnly || {};

function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj?.ResourceList)) return obj.ResourceList;
  const hal = obj?._embedded?.["http://api.3plCentral.com/rels/orders/order"];
  if (Array.isArray(hal)) return hal;
  if (Array.isArray(obj?.data)) return obj.data;
  for (const v of Object.values(obj || {})) if (Array.isArray(v)) return v;
  return [];
}
function itemsFromOrder(ord) {
  const em = ord?._embedded;
  if (em && Array.isArray(em["http://api.3plCentral.com/rels/orders/item"])) {
    return em["http://api.3plCentral.com/rels/orders/item"];
  }
  if (Array.isArray(ord?.OrderItems)) return ord.OrderItems;
  if (Array.isArray(ord?.Items)) return ord.Items;
  return [];
}

/* ============== auth (basic or oauth) ============== */
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
    if (process.env.EXT_USER_LOGIN)     form.set("user_login",    process.env.EXT_USER_LOGIN);
    if (process.env.EXT_USER_LOGIN_ID)  form.set("user_login_id", process.env.EXT_USER_LOGIN_ID);
    if (process.env.EXT_TPL_GUID)       form.set("tplguid",       process.env.EXT_TPL_GUID);

    const auth = basicHeaderFromEnv();
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
  }
  const basic = basicHeaderFromEnv();
  if (!basic) throw new Error("No auth configured: set EXT_BASIC_AUTH_B64 or EXT_TOKEN_URL (+ client id/secret).");
  return {
    Authorization: basic,
    Accept: "application/hal+json, application/json",
    "Content-Type": "application/hal+json; charset=utf-8",
  };
}

/* ============== API calls ============== */
async function listOrdersPage({ base, headers, pgsiz = 100, pgnum = 1, rql = "" }) {
  const params = { pgsiz, pgnum, detail: "OrderItems", itemdetail: "All" };
  if (rql) params.rql = rql;
  const { data } = await axios.get(`${base}/orders`, { headers, params, timeout: 30000 });
  return data;
}
export async function fetchOneOrderDetail(orderId) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  try {
    const { data } = await axios.get(`${base}/orders`, {
      headers,
      params: { pgsiz: 1, pgnum: 1, detail: "OrderItems", itemdetail: "All", rql: `readOnly.orderId==${orderId}` },
      timeout: 20000,
    });
    const list = firstArray(data);
    if (list?.[0]) return list[0];
  } catch {}

  try {
    const page = await listOrdersPage({ base, headers, pgsiz: 100, pgnum: 1 });
    const list = firstArray(page);
    return list.find(o => (readOnly(o).OrderId ?? o.OrderId ?? o.orderId) === orderId) || null;
  } catch {
    return null;
  }
}

/* ============== DB bootstrap ============== */
async function ensureTables(pool) {
  await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
  CREATE TABLE dbo.OrderDetails (
    OrderItemID INT NOT NULL PRIMARY KEY,
    OrderId     INT NULL,
    ItemID      VARCHAR(150) NULL, -- SKU
    Qualifier   VARCHAR(80)  NULL,
    OrderedQTY  INT          NULL
  );
IF COL_LENGTH('dbo.OrderDetails','ItemID') IS NOT NULL AND COL_LENGTH('dbo.OrderDetails','ItemID') < 150
  ALTER TABLE dbo.OrderDetails ALTER COLUMN ItemID VARCHAR(150) NULL;
IF COL_LENGTH('dbo.OrderDetails','Qualifier') IS NOT NULL AND COL_LENGTH('dbo.OrderDetails','Qualifier') < 80
  ALTER TABLE dbo.OrderDetails ALTER COLUMN Qualifier VARCHAR(80) NULL;
`);
}

/* ============== MAIN IMPORT (now filters unallocated+open) ============== */
export async function fetchAndUpsertOrders({
  maxPages = 10,
  pageSize = 200,
  unallocatedOnly = true,   // <— default to only unallocated
  statusOpenOnly = true     // <— default to only open (status==0)
} = {}) {
  const pool = await getPool();
  await ensureTables(pool);

  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  // Compose RQL
  const rqlParts = [];
  if (unallocatedOnly) rqlParts.push("readOnly.fullyAllocated==false");
  if (statusOpenOnly)  rqlParts.push("readOnly.status==0");
  const rql = rqlParts.join(";");

  let importedHeaders = 0;
  let upsertedItems   = 0;
  const errors        = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    let pageData;
    try {
      pageData = await listOrdersPage({ base, headers, pgsiz: pageSize, pgnum: pg, rql });
    } catch (e) {
      const st = e.response?.status;
      const dt = e.response?.data;
      return { ok: false, status: st || 500, message: `Orders GET failed (page ${pg})`, data: typeof dt === "string" ? dt : dt || String(e.message) };
    }

    const orders = firstArray(pageData);
    if (!orders.length) break;
    importedHeaders += orders.length;

    const flat = [];
    for (const ord of orders) {
      const ro = readOnly(ord);
      const orderId = ro.orderId ?? ro.OrderId ?? ord.orderId ?? ord.OrderId ?? null;
      for (const it of itemsFromOrder(ord)) {
        const iro = readOnly(it);
        const orderItemId = iro.orderItemId ?? iro.OrderItemId ?? it.orderItemId ?? it.OrderItemId ?? it.id ?? null;
        const sku = it?.itemIdentifier?.sku ?? it?.ItemIdentifier?.Sku ?? it?.sku ?? it?.SKU ?? null;
        const qualifier = it?.qualifier ?? it?.Qualifier ?? "";
        const qty = toInt(it?.qty ?? it?.Qty ?? it?.OrderedQty ?? it?.orderedQty ?? 0, 0);
        if (orderItemId && sku) {
          flat.push({
            orderItemId: toInt(orderItemId, null),
            orderId:     toInt(orderId, null),
            sku:         safeStr(sku, 150),
            qualifier:   safeStr(qualifier, 80) || "",
            qty,
          });
        }
      }
    }

    // de-dupe by OrderItemID
    const byId = new Map();
    for (const x of flat) if (!byId.has(x.orderItemId)) byId.set(x.orderItemId, x);
    const items = Array.from(byId.values());

    // row-by-row upsert (no transaction so one bad row doesn’t kill the batch)
    for (const it of items) {
      try {
        await pool.request()
          .input("OrderItemID", sql.Int, it.orderItemId)
          .input("OrderId",     sql.Int, it.orderId ?? null)
          .input("ItemID",      sql.VarChar(150), it.sku)
          .input("Qualifier",   sql.VarChar(80),  it.qualifier)
          .input("OrderedQTY",  sql.Int, it.qty)
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
      } catch (e) {
        errors.push({
          orderItemId: it.orderItemId,
          message: e.message,
          number: e.number,
          code: e.code,
          state: e.state,
          class: e.class,
          lineNumber: e.lineNumber,
        });
      }
    }

    if (orders.length < pageSize) break;
  }

  return errors.length
    ? { ok: false, importedHeaders, upsertedItems, errors }
    : { ok: true, importedHeaders, upsertedItems };
}
