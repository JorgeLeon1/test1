// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

const TIMEOUT = 20000;
const trimBase = (u) => (u || "").replace(/\/+$/, "");

/* ------------------------ AUTH: BASIC-ONLY ------------------------ */
export async function authHeaders() {
  const b64 =
    process.env.EXT_BASIC_AUTH_B64 ||
    Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64");

  if (!b64) throw new Error("Missing EXT_BASIC_AUTH_B64 or CLIENT_ID/CLIENT_SECRET");
  return { Authorization: `Basic ${b64}`, Accept: "application/json" };
}

/* -------------------------- HELPERS ------------------------------ */
function listify(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.ResourceList)) return data.ResourceList; // legacy
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
    qty: Number(
      it?.OrderedQty ??
      it?.OrderedQuantity ??
      it?.Quantity ??
      it?.Qty ??
      it?.QtyOrdered ??
      0
    ) || 0,
  }));
}

/* --------------------------- API CALLS --------------------------- */
export async function listOrders() {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();
  const url = `${base}/orders`;

  const r = await axios.get(url, { headers, timeout: TIMEOUT, validateStatus: () => true });
  if (r.status === 401) {
    throw new Error(`401 from ${url} — check EXT_BASIC_AUTH_B64 (base64(clientId:clientSecret))`);
  }
  if (r.status >= 400) {
    const body = typeof r.data === "string" ? r.data.slice(0, 300) : JSON.stringify(r.data).slice(0, 300);
    throw new Error(`${r.status} from ${url} — ${body}`);
  }
  return listify(r.data);
}

export async function fetchOneOrderDetail(orderId) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  const tries = [
    `${base}/orders/${orderId}`,          // legacy detail
    `${base}/orders/${orderId}/details`,  // legacy explicit
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
  throw new Error(`Order ${orderId} detail failed — last tried ${last?.url} (${last?.status}): ${snippet}`);
}

/* ---------------- IMPORT (headers + line items) ------------------ */
export async function fetchAndUpsertOrders({ limit } = {}) {
  const pool = await getPool();

  // Ensure table exists
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

  // 1) headers
  const headers = await listOrders();
  const slice = typeof limit === "number" ? headers.slice(0, Math.max(0, limit)) : headers;

  let importedHeaders = slice.length;
  let upsertedItems = 0;

  // 2) details -> upsert
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
      } catch (e) {
        // Keep going; report after commit
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
