// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

const TIMEOUT = 20000;
const trimBase = (u) => (u || "").replace(/\/+$/, "");

// -------------------- TOKEN (Bearer) --------------------
let tokenCache = { value: null, exp: 0 };

async function fetchOAuthToken() {
  const base  = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const url   = process.env.EXT_TOKEN_URL || `${base}/oauth/token`;

  // Basic auth header from clientId:clientSecret
  const basic =
    process.env.EXT_BASIC_AUTH_B64 ||
    Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64");

  const body = {
    grant_type: "client_credentials",
    user_login: process.env.EXT_USER_LOGIN || undefined,
  };

  const r = await axios.post(url, body, {
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: TIMEOUT,
    validateStatus: () => true,
  });

  if (r.status >= 400) {
    throw Object.assign(new Error(`OAuth ${r.status}`), { response: r });
  }
  const tok = r.data?.access_token || r.data?.token || r.data?.accessToken;
  const expSec = Number(r.data?.expires_in || 300);
  if (!tok) throw new Error("OAuth response missing access_token");
  tokenCache = { value: tok, exp: Date.now() + (expSec - 30) * 1000 };
  return tok;
}

export async function authHeaders() {
  if (process.env.EXT_AUTH_MODE === "basic" && process.env.EXT_BASIC_AUTH_B64) {
    return { Authorization: `Basic ${process.env.EXT_BASIC_AUTH_B64}`, Accept: "application/json" };
  }
  const now = Date.now();
  const token = tokenCache.value && tokenCache.exp > now ? tokenCache.value : await fetchOAuthToken();
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

// -------------------- HELPERS --------------------
function listify(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.ResourceList)) return data.ResourceList; // legacy list
  if (Array.isArray(data?.data)) return data.data;
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

function extractItemsFromDetail(detail) {
  // Try common locations for line items
  let items = [];
  if (Array.isArray(detail?.OrderLineItems)) items = detail.OrderLineItems;
  else if (Array.isArray(detail?.Items)) items = detail.Items;
  else if (Array.isArray(detail?.Details)) items = detail.Details;
  else if (Array.isArray(detail?.Detail)) items = detail.Detail;
  else if (Array.isArray(detail?.ResourceList)) items = detail.ResourceList;
  else if (Array.isArray(detail?.data)) items = detail.data;

  // Normalize fields used in MERGE
  return items.map((it) => ({
    orderItemId:
      it?.OrderItemID ??
      it?.OrderLineId ??
      it?.OrderLineID ??
      it?.Id ??
      it?.id ??
      null,
    sku:
      it?.SKU ??
      it?.Sku ??
      it?.ItemCode ??
      it?.ItemID ??
      it?.ItemIdentifier?.ItemCode ??
      "",
    qualifier: it?.Qualifier ?? it?.UOM ?? it?.UnitOfMeasure ?? "",
    qty:
      Number(
        it?.OrderedQty ??
          it?.OrderedQuantity ??
          it?.Quantity ??
          it?.Qty ??
          it?.QtyOrdered ??
          0
      ) || 0,
  }));
}

// -------------------- API CALLS --------------------
export async function listOrders() {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();
  // Legacy list known to return { ResourceList: [...] }
  const resp = await axios.get(`${base}/orders`, { headers, timeout: TIMEOUT });
  return listify(resp.data);
}

export async function fetchOneOrderDetail(orderId) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  const tries = [
    `${base}/orders/${orderId}`,           // legacy detail
    `${base}/orders/${orderId}/details`,   // legacy explicit details
    `${base}/api/v1/orders/${orderId}`,    // v1 fallback
    `${base}/api/v1/orders/${orderId}/details`,
  ];

  let lastErr = null;
  for (const url of tries) {
    try {
      const r = await axios.get(url, { headers, timeout: TIMEOUT, validateStatus: () => true });
      if (r.status >= 400) { lastErr = r; continue; }
      return r.data;
    } catch (e) {
      lastErr = e.response || e;
    }
  }
  const msg = lastErr?.status ? `Order ${orderId} detail failed (HTTP ${lastErr.status})` : `Order ${orderId} detail failed`;
  throw Object.assign(new Error(msg), { response: lastErr });
}

// -------------------- IMPORT (headers + line items) --------------------
export async function fetchAndUpsertOrders({ limit } = {}) {
  const pool = await getPool();

  // Ensure table exists / columns present
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
ELSE
BEGIN
  IF COL_LENGTH('dbo.OrderDetails','OrderId')   IS NULL ALTER TABLE dbo.OrderDetails ADD OrderId INT NULL;
  IF COL_LENGTH('dbo.OrderDetails','ItemID')    IS NULL ALTER TABLE dbo.OrderDetails ADD ItemID VARCHAR(100) NULL;
  IF COL_LENGTH('dbo.OrderDetails','Qualifier') IS NULL ALTER TABLE dbo.OrderDetails ADD Qualifier VARCHAR(50) NULL;
  IF COL_LENGTH('dbo.OrderDetails','OrderedQTY')IS NULL ALTER TABLE dbo.OrderDetails ADD OrderedQTY INT NULL;
END
  `);

  // 1) Pull headers
  const headers = await listOrders();
  const headerSlice = typeof limit === "number" ? headers.slice(0, Math.max(0, limit)) : headers;
  let importedHeaders = headerSlice.length;
  let upsertedItems = 0;

  // 2) For each header, fetch details and upsert items
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const req = new sql.Request(tx);

    for (const h of headerSlice) {
      const orderId = extractOrderId(h);
      if (!orderId) continue;

      let detail;
      try {
        detail = await fetchOneOrderDetail(orderId);
      } catch {
        continue; // skip on detail failure
      }

      const items = extractItemsFromDetail(detail);

      for (const it of items) {
        // Some tenants don’t expose a stable OrderItemID; allow null merge on OrderId+ItemID+Qualifier
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
