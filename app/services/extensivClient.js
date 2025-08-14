// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

const TIMEOUT = 20000;
const trimBase = (u) => (u || "").replace(/\/+$/, "");

/* -------------------- AUTH (Bearer with robust token fetch) -------------------- */

let tokenCache = { value: null, exp: 0 };

function basicB64() {
  return (
    process.env.EXT_BASIC_AUTH_B64 ||
    Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64")
  );
}

async function fetchOAuthToken() {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const tries = [
    process.env.EXT_TOKEN_URL,                       // preferred (set to https://secure-wms.com/oauth/token)
    "https://secure-wms.com/oauth/token",           // known good for many sandboxes
    `${base}/oauth/token`,                          // some tenants expose at their base
  ].filter(Boolean);

  const body = {
    grant_type: "client_credentials",
    user_login: process.env.EXT_USER_LOGIN || undefined,
  };

  let lastErr = null;
  for (const url of tries) {
    try {
      const r = await axios.post(url, body, {
        headers: {
          Authorization: `Basic ${basicB64()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: TIMEOUT,
        validateStatus: () => true,
      });
      if (r.status >= 400) {
        lastErr = { where: url, status: r.status, data: r.data };
        continue;
      }
      const tok = r.data?.access_token || r.data?.token || r.data?.accessToken;
      const expSec = Number(r.data?.expires_in || 300);
      if (!tok) throw new Error(`Token response missing access_token from ${url}`);
      tokenCache = { value: tok, exp: Date.now() + (expSec - 30) * 1000 };
      return tok;
    } catch (e) {
      lastErr = { where: url, status: e.response?.status, data: e.response?.data || e.message };
    }
  }
  const msg = lastErr?.status ? `OAuth ${lastErr.status} at ${lastErr.where}` : `OAuth failed`;
  const err = new Error(msg);
  err.response = lastErr;
  throw err;
}

export async function authHeaders() {
  // hard lock to bearer because EXT_AUTH_MODE=bearer
  const now = Date.now();
  const tok = tokenCache.value && tokenCache.exp > now ? tokenCache.value : await fetchOAuthToken();
  return { Authorization: `Bearer ${tok}`, Accept: "application/json" };
}

/* ----------------------------- helpers ----------------------------- */

function listify(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.ResourceList)) return data.ResourceList; // legacy list shape
  if (Array.isArray(data?.data)) return data.data;                 // some v1 shapes
  for (const v of Object.values(data || {})) if (Array.isArray(v)) return v;
  return [];
}

function extractOrderId(header) {
  return (
    header?.ReadOnly?.OrderId ??
    header?.OrderId ??
    header?.Id ??
    header?.id ??
    null
  );
}

function extractItems(detail) {
  let items = [];
  if (Array.isArray(detail?.OrderLineItems)) items = detail.OrderLineItems;
  else if (Array.isArray(detail?.Items)) items = detail.Items;
  else if (Array.isArray(detail?.Details)) items = detail.Details;
  else if (Array.isArray(detail?.Detail)) items = detail.Detail;
  else if (Array.isArray(detail?.ResourceList)) items = detail.ResourceList;
  else if (Array.isArray(detail?.data)) items = detail.data;

  return items.map((it) => ({
    orderItemId:
      it?.OrderItemID ?? it?.OrderLineId ?? it?.OrderLineID ?? it?.Id ?? it?.id ?? null,
    sku:
      it?.SKU ?? it?.Sku ?? it?.ItemCode ?? it?.ItemID ?? it?.ItemIdentifier?.ItemCode ?? "",
    qualifier: it?.Qualifier ?? it?.UOM ?? it?.UnitOfMeasure ?? "",
    qty: Number(
      it?.OrderedQty ?? it?.OrderedQuantity ?? it?.Quantity ?? it?.Qty ?? it?.QtyOrdered ?? 0
    ) || 0,
  }));
}

/* ----------------------------- API calls --------------------------- */

export async function listOrders() {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();
  const url = `${base}/orders`; // legacy listing endpoint that returned 200 for you

  const r = await axios.get(url, { headers, timeout: TIMEOUT, validateStatus: () => true });
  if (r.status >= 400) {
    const body = typeof r.data === "string" ? r.data.slice(0, 300) : JSON.stringify(r.data).slice(0, 300);
    const err = new Error(`${r.status} from ${url}`);
    err.response = { status: r.status, data: body };
    throw err;
  }
  return listify(r.data);
}

export async function fetchOneOrderDetail(orderId) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  const tries = [
    `${base}/orders/${orderId}`,          // legacy detail (often works)
    `${base}/orders/${orderId}/details`,  // legacy explicit details
    `${base}/api/v1/orders/${orderId}`,   // v1 fallback
    `${base}/api/v1/orders/${orderId}/details`,
  ];

  let last = null;
  for (const url of tries) {
    try {
      const r = await axios.get(url, { headers, timeout: TIMEOUT, validateStatus: () => true });
      if (r.status < 400) return r.data;
      last = { url, status: r.status, data: r.data };
    } catch (e) {
      last = { url, status: e.response?.status || "ERR", data: e.response?.data || e.message };
    }
  }
  const snippet = typeof last?.data === "string" ? last.data.slice(0, 300) : JSON.stringify(last?.data || "").slice(0, 300);
  const err = new Error(`Order ${orderId} detail failed at ${last?.url} (${last?.status})`);
  err.response = { status: last?.status, data: snippet };
  throw err;
}

/* ----------------------- Import (headers + items) ------------------ */

export async function fetchAndUpsertOrders({ limit } = {}) {
  const pool = await getPool();

  await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
BEGIN
  CREATE TABLE dbo.OrderDetails (
    OrderItemID INT NULL,
    OrderId     INT NULL,
    ItemID      VARCHAR(100) NULL,
    Qualifier   VARCHAR(50)  NULL,
    OrderedQTY  INT NULL
  );
END
  `);

  const headers = await listOrders();
  const slice = typeof limit === "number" ? headers.slice(0, Math.max(0, limit)) : headers;

  let importedHeaders = slice.length;
  let upsertedItems = 0;

  const tx = new sql.Transaction(await getPool());
  await tx.begin();
  try {
    const req = new sql.Request(tx);

    for (const h of slice) {
      const orderId = extractOrderId(h);
      if (!orderId) continue;

      let detail;
      try {
        detail = await fetchOneOrderDetail(orderId);
      } catch {
        continue;
      }

      const items = extractItems(detail);
      for (const it of items) {
        const hasKey = it.orderItemId != null;

        if (hasKey) {
          await req
            .input("OrderItemID", sql.Int, it.orderItemId)
            .input("OrderId", sql.Int, orderId)
            .input("ItemID", sql.VarChar(100), it.sku || "")
            .input("Qualifier", sql.VarChar(50), it.qualifier || "")
            .input("OrderedQty", sql.Int, Number(it.qty || 0))
            .query(`
MERGE dbo.OrderDetails AS t
USING (SELECT @OrderItemID AS OrderItemID) s
  ON t.OrderItemID = s.OrderItemID
WHEN MATCHED THEN UPDATE SET
  OrderId=@OrderId, ItemID=@ItemID, Qualifier=@Qualifier, OrderedQTY=@OrderedQty
WHEN NOT MATCHED THEN INSERT (OrderItemID, OrderId, ItemID, Qualifier, OrderedQTY)
  VALUES (@OrderItemID, @OrderId, @ItemID, @Qualifier, @OrderedQty);
          `);
        } else {
          await req
            .input("OrderId", sql.Int, orderId)
            .input("ItemID", sql.VarChar(100), it.sku || "")
            .input("Qualifier", sql.VarChar(50), it.qualifier || "")
            .input("OrderedQty", sql.Int, Number(it.qty || 0))
            .query(`
MERGE dbo.OrderDetails AS t
USING (SELECT @OrderId AS OrderId, @ItemID AS ItemID, @Qualifier AS Qualifier) s
  ON t.OrderId = s.OrderId AND ISNULL(t.ItemID,'') = ISNULL(s.ItemID,'') AND ISNULL(t.Qualifier,'') = ISNULL(s.Qualifier,'')
WHEN MATCHED THEN UPDATE SET
  OrderedQTY=@OrderedQty
WHEN NOT MATCHED THEN INSERT (OrderItemID, OrderId, ItemID, Qualifier, OrderedQTY)
  VALUES (NULL, @OrderId, @ItemID, @Qualifier, @OrderedQty);
          `);
        }

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
