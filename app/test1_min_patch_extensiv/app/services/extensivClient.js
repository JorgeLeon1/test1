import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

function authHeaders() {
  const basic = Buffer.from(`${process.env.EXT_API_KEY}:${process.env.EXT_API_SECRET}`).toString("base64");
  return { Authorization: `Basic ${basic}`, Accept: "application/json" };
}

export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  let page = 1, imported = 0;
  const pool = await getPool();

  while (true) {
    const { data } = await axios.get(`${process.env.EXT_BASE_URL}/orders`, {
      headers: authHeaders(),
      params: { modifiedDateStart: modifiedSince, status, page, pageSize }
    });
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
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
      throw e;
    }

    imported += list.length;
    if (list.length < pageSize) break;
    page++;
  }

  return { imported };
}
