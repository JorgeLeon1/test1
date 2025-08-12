import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

// ---- Token cache (memory) ----
let tokenCache = { access_token: null, exp: 0 };

function baseUrl() {
  const b = (process.env.EXT_BASE_URL || "").replace(/\/+$/, "");
  if (!b) throw new Error("Missing EXT_BASE_URL");
  return b;
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.exp - 60_000) {
    return tokenCache.access_token;
  }

  const clientId = process.env.EXT_CLIENT_ID;
  const clientSecret = process.env.EXT_CLIENT_SECRET;
  const userLogin = process.env.EXT_USER_LOGIN;
  const tplguid   = process.env.EXT_TPL_GUID;

  if (!clientId || !clientSecret) {
    throw new Error("Missing EXT_CLIENT_ID / EXT_CLIENT_SECRET");
  }
  if (!userLogin || !tplguid) {
    throw new Error("Missing EXT_USER_LOGIN / EXT_TPL_GUID");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    user_login: userLogin,
    tplguid: tplguid
  });
  if (process.env.EXT_USER_LOGIN_ID) {
    form.append("user_login_id", process.env.EXT_USER_LOGIN_ID);
  }

  try {
    const resp = await axios.post(
      `${baseUrl()}/api/v1/oauth/token`,
      form,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${basic}` // <-- Basic for token exchange
        },
        timeout: 20000
      }
    );
    const { access_token, expires_in = 3600 } = resp.data || {};
    if (!access_token) throw new Error("No access_token in OAuth response");
    tokenCache = { access_token, exp: Date.now() + expires_in * 1000 };
    return access_token;
  } catch (e) {
    console.error("[OAuth token error]",
      e.response?.status,
      e.response?.data || e.message
    );
    throw e;
  }
}

// Exported: used by routes & diagnostics
export async function authHeaders() {
  const bearer = await getAccessToken();
  const h = {
    Authorization: `Bearer ${bearer}`, // <-- Bearer for resource calls
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  // Common sandbox scoping
  if (process.env.EXT_CUSTOMER_IDS) h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS; // "ALL" or "1,2,3"
  if (process.env.EXT_FACILITY_IDS) h["FacilityIds"] = process.env.EXT_FACILITY_IDS; // "ALL" or "10,20"
  // Some tenants still require 3PL headers
  if (process.env.EXT_WAREHOUSE_ID) h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID)  h["3PL-Customer-Id"]  = process.env.EXT_CUSTOMER_ID;
  return h;
}

// Exported: your import action
export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  const pool = await getPool();
  const base = baseUrl();
  let page = 1;
  let imported = 0;

  while (true) {
    // ----- call orders API (v1 path on box) -----
    let list = [];
    try {
      const headers = await authHeaders();
      const resp = await axios.get(`${base}/api/v1/orders`, {
        headers,
        params: {
          page,
          pageSize,
          // optional filters — include only if provided
          ...(modifiedSince ? { modifiedDateStart: modifiedSince } : {}),
          ...(status ? { status } : {})
        },
        timeout: 20000
      });
      const data = resp.data;
      list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("[Extensiv /orders error]",
        err.response?.status,
        err.response?.data || err.message
      );
      throw err;
    }

    if (!list.length) break;

    // ----- upsert into SQL -----
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const req = new sql.Request(tx);
      for (const o of list) {
        const items = Array.isArray(o.items) ? o.items : [];
        for (const it of items) {
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
