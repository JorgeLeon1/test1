// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

// In-memory token cache
let tokenCache = { access_token: null, exp: 0 };

function trimBase(u) {
  return (u || "").replace(/\/+$/, "");
}

// --------- TOKEN (AuthServer on secure-wms) ----------
export async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.exp - 60_000) {
    return tokenCache.access_token;
  }

  const clientId     = process.env.EXT_CLIENT_ID;
  const clientSecret = process.env.EXT_CLIENT_SECRET;

  // you may provide a precomputed Base64 via EXT_BASIC_AUTH_B64
  const basicB64 = process.env.EXT_BASIC_AUTH_B64
    || Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  if (!basicB64) throw new Error("Missing EXT_CLIENT_ID/EXT_CLIENT_SECRET or EXT_BASIC_AUTH_B64");

  // Required sandbox identifiers
  const tplGuid  = process.env.EXT_TPL_GUID;              // preferred
  const tplId    = process.env.EXT_TPL || process.env.EXT_TPL_ID || process.env.TPLID; // numeric alt
  const userId   = process.env.EXT_USER_LOGIN_ID;         // preferred (numeric)
  const userLog  = process.env.EXT_USER_LOGIN;            // alt (email)

  if (!userId && !userLog) {
    throw new Error("Missing EXT_USER_LOGIN_ID or EXT_USER_LOGIN");
  }
  if (!tplGuid && !tplId) {
    throw new Error("Missing EXT_TPL_GUID or EXT_TPL/EXT_TPL_ID");
  }

  const tokenUrl = trimBase(process.env.EXT_TOKEN_URL) || "https://secure-wms.com/AuthServer/api/Token";

  // AuthServer expects JSON body + Basic header
  const body = {
    grant_type: "client_credentials",
    ...(userId ? { user_login_id: String(userId) } : { user_login: String(userLog) }),
    ...(tplGuid ? { tplguid: String(tplGuid) } : { tpl: String(tplId) }),
  };

  try {
    const resp = await axios.post(tokenUrl, body, {
      headers: {
        "Authorization": `Basic ${basicB64}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      timeout: 20000,
    });

    const { access_token, expires_in = 1800 } = resp.data || {};
    if (!access_token) throw new Error("No access_token in token response");
    tokenCache = { access_token, exp: Date.now() + expires_in * 1000 };
    return access_token;
  } catch (e) {
    console.error("[OAuth token error]", e.response?.status, e.response?.data || e.message);
    throw e;
  }
}

// --------- HEADERS FOR RESOURCE CALLS ----------
export async function authHeaders() {
  const bearer = await getAccessToken();
  const h = {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  // Common sandbox scoping
  if (process.env.EXT_CUSTOMER_IDS) h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS; // "ALL" or "1,2,3"
  if (process.env.EXT_FACILITY_IDS) h["FacilityIds"] = process.env.EXT_FACILITY_IDS; // "ALL" or "10,20"
  // Some tenants still want 3PL headers
  if (process.env.EXT_WAREHOUSE_ID) h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID)  h["3PL-Customer-Id"]  = process.env.EXT_CUSTOMER_ID;
  return h;
}

// --------- IMPORT & UPSERT ----------
export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const pool = await getPool();

  const endpoints = [`${base}/api/v1/orders`, `${base}/orders`, `${base}/api/orders`];
  let page = 1, imported = 0;

  while (true) {
    // Fetch a page with fallback endpoints
    let list = [];
    const headers = await authHeaders();
    let lastErr = null;

    for (const url of endpoints) {
      try {
        const resp = await axios.get(url, {
          headers,
          params: {
            page, pageSize,
            ...(modifiedSince ? { modifiedDateStart: modifiedSince } : {}),
            ...(status ? { status } : {}),
          },
          timeout: 20000,
        });
        const d = resp.data;
        list = Array.isArray(d?.data) ? d.data : (Array.isArray(d) ? d : []);
        if (list.length || resp.status === 200) {
          lastErr = null;
          break;
        }
      } catch (e) {
        lastErr = e;
        // try next candidate on 404/401; throw immediately on other fatal errors
        const s = e.response?.status;
        if (![401,403,404].includes(s)) throw e;
      }
    }

    if (lastErr) {
      console.error("[Extensiv orders error]", lastErr.response?.status, lastErr.response?.data || lastErr.message);
      throw lastErr;
    }
    if (!list.length) break;

    // Upsert items into SQL
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
