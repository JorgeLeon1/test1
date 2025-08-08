// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

export function authHeaders() {
  const basic = Buffer.from(`${process.env.EXT_API_KEY}:${process.env.EXT_API_SECRET}`).toString("base64");
  const h = {
    Authorization: `Basic ${basic}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  // If your tenant requires these, keep; otherwise keep as blank strings or remove.
  if (process.env.EXT_WAREHOUSE_ID) h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID) h["3PL-Customer-Id"] = process.env.EXT_CUSTOMER_ID;
  return h;
}

export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  let page = 1, imported = 0;
  const pool = await getPool();

  while (true) {
    let list = [];
    try {
      const resp = await axios.get(`${process.env.EXT_BASE_URL}/orders`, {
        headers: authHeaders(),
        params: { modifiedDateStart: modifiedSince, status, page, pageSize }
      });
      const data = resp.data;
      list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("[Extensiv import] HTTP error",
        err.response?.status, err.response?.data || err.message);
      throw err;
    }

    if (!list.length) break;

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const req = new sql.Request(tx);
      for (const o of list) {
        for (const it of (o.items || [])) {
          await req
            .input("OrderItemID", sql.Int, it.id || it.orderItemId)
            .input("ItemID", sql.VarChar(100), it.sku)
            .input("Qualifier", sql.VarChar(50), it.qualifier || "")
            .input("OrderedQty", sql.Int, Number(it.quantity || 0))
            .query(`
              MERGE [dbo].[OrderDetails] AS t
              USING (SELECT @OrderItemID AS OrderItemID) s
              ON t.OrderItemID = s.OrderItemID
              WHEN MATCHED THEN UPDATE SET ItemID=@ItemID, Qualifier=@Qualifier, OrderedQTY=@OrderedQty
              WHEN NOT MATCHED THEN INSERT (OrderItemID, ItemID, Qualifier, OrderedQTY)
              VALUES (@OrderItemID, @ItemID, @Qualifier, @OrderedQty);
            `);
        }
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      console.error("[SQL upsert error]", e);
      throw e;
    }

    imported += list.length;
    if (list.length < pageSize) break;
    page++;
  }

  return { imported };
}
