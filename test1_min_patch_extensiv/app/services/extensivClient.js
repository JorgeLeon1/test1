// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

// ---- OAuth token cache ----
let tokenCache = { access_token: null, exp: 0 };

async function getAccessToken() {
  // reuse a valid token if not close to expiry
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.exp - 60_000) return tokenCache.access_token;

  // prefer client-credentials flow (most common on api.scoutsft.com)
  // required envs: EXT_CLIENT_ID, EXT_CLIENT_SECRET
  const cid = process.env.EXT_CLIENT_ID;
  const csec = process.env.EXT_CLIENT_SECRET;
  if (!cid || !csec) {
    throw new Error("Missing EXT_CLIENT_ID / EXT_CLIENT_SECRET for Extensiv OAuth.");
  }
  const basic = Buffer.from(`${cid}:${csec}`).toString("base64");

  try {
    const resp = await axios.post(
      `${process.env.EXT_BASE_URL}/oauth/token`,
      new URLSearchParams({ grant_type: "client_credentials" }),
      { headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const { access_token, expires_in = 3600 } = resp.data || {};
    if (!access_token) throw new Error("No access_token in OAuth response");
    tokenCache = { access_token, exp: Date.now() + expires_in * 1000 };
    return access_token;
  } catch (e) {
    // show the real reason in logs
    console.error("[Extensiv OAuth error]", e.response?.status, e.response?.data || e.message);
    throw e;
  }
}

export async function authHeaders() {
  // Prefer Bearer token
  const bearer = await getAccessToken();
  const h = {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  // Tenant-scoping headers (often required)
  if (process.env.EXT_WAREHOUSE_ID) h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID) h["3PL-Customer-Id"] = process.env.EXT_CUSTOMER_ID;
  return h;
}

export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  let page = 1, imported = 0;
  const pool = await getPool();

  while (true) {
    // ----- fetch a page from Extensiv -----
    let list = [];
    try {
      const headers = await authHeaders();
      const resp = await axios.get(`${process.env.EXT_BASE_URL}/orders`, {
        headers,
        params: { modifiedDateStart: modifiedSince, status, page, pageSize }
      });
      const data = resp.data;
      list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("[Extensiv import] HTTP error", err.response?.status, err.response?.data || err.message);
      throw err;
    }
    if (!list.length) break;

    // ----- upsert into SQL -----
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const req = new sql.Request(tx);
      for (const o of list) {
        for (const it of (o.items || [])) {
          await req
            .input("OrderItemID", sql.Int, it.id ?? it.orderItemId ?? null)
            .input("ItemID", sql.VarChar(100), it.sku ?? "")
            .input("Qualifier", sql.VarChar(50), it.qualifier ?? "")
            .input("OrderedQty", sql.Int, Number(it.quantity ?? 0))
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
