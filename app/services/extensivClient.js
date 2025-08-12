// app/services/extensivClient.js (ESM)
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

// Cache token + which token endpoint/mode worked
let tokenCache = { access_token: null, exp: 0, winner: null };

function baseUrl() {
  const b = (process.env.EXT_BASE_URL || "").replace(/\/+$/, "");
  if (!b) throw new Error("Missing EXT_BASE_URL");
  return b;
}

// Try several common OAuth endpoints + param styles, cache the winner
export async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.exp - 60_000) {
    return tokenCache.access_token;
  }

  const base = baseUrl();
  const clientId     = process.env.EXT_CLIENT_ID;
  const clientSecret = process.env.EXT_CLIENT_SECRET;
  const userLogin    = process.env.EXT_USER_LOGIN;
  const tplguid      = process.env.EXT_TPL_GUID;
  const userLoginId  = process.env.EXT_USER_LOGIN_ID;

  if (!clientId || !clientSecret) throw new Error("Missing EXT_CLIENT_ID / EXT_CLIENT_SECRET");
  if (!userLogin || !tplguid)     throw new Error("Missing EXT_USER_LOGIN / EXT_TPL_GUID");

  // Candidate endpoints seen on box/secure-wms tenants
  const urls = [
    `${base}/api/v1/oauth/token`,
    `${base}/oauth/token`,
    `${base}/api/oauth/token`,
  ];

  // Modes:
  //  A) Basic header with id:secret ; body has grant + user_login + tpl*
  //  B) No Basic header; id/secret go in the body
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const authModes = [
    {
      name: "basic+body",
      headers: { "Content-Type":"application/x-www-form-urlencoded", "Authorization": `Basic ${basic}` },
      bodyMaker: (tplKey, uliKey) => {
        const p = new URLSearchParams({ grant_type:"client_credentials", user_login:userLogin });
        p.append(tplKey, tplguid);
        if (userLoginId) p.append(uliKey, userLoginId);
        return p;
      }
    },
    {
      name: "body-only",
      headers: { "Content-Type":"application/x-www-form-urlencoded" },
      bodyMaker: (tplKey, uliKey) => {
        const p = new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
          user_login: userLogin
        });
        p.append(tplKey, tplguid);
        if (userLoginId) p.append(uliKey, userLoginId);
        return p;
      }
    }
  ];

  // Some tenants use tplguid vs tpl ; user_login_id vs userLoginId
  const tplKeys = ["tplguid", "tpl"];
  const uliKeys = ["user_login_id", "userLoginId"];

  const attempts = [];
  for (const url of urls) {
    for (const mode of authModes) {
      for (const tplKey of tplKeys) {
        for (const uliKey of uliKeys) {
          try {
            const resp = await axios.post(url, mode.bodyMaker(tplKey, uliKey), {
              headers: mode.headers,
              timeout: 20000
            });
            const { access_token, expires_in = 3600 } = resp.data || {};
            if (!access_token) throw new Error(`No access_token at ${url} (${mode.name}/${tplKey}/${uliKey})`);
            tokenCache = {
              access_token,
              exp: Date.now() + expires_in * 1000,
              winner: { url, mode: mode.name, tplKey, uliKey }
            };
            if (process.env.LOG_TOKEN_DEBUG === "true") {
              console.log("[OAuth winner]", tokenCache.winner);
            }
            return access_token;
          } catch (e) {
            attempts.push({
              url, mode: mode.name, tplKey, uliKey,
              status: e.response?.status ?? null,
              data: e.response?.data ?? String(e.message)
            });
          }
        }
      }
    }
  }

  throw new Error("OAuth token failed. First attempts:\n" + JSON.stringify(attempts.slice(0,4), null, 2));
}

// ✅ Named export that routes import: { authHeaders }
export async function authHeaders() {
  const bearer = await getAccessToken();
  const h = {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  // Common sandbox scoping
  if (process.env.EXT_CUSTOMER_IDS) h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS; // "ALL" or "123,456"
  if (process.env.EXT_FACILITY_IDS) h["FacilityIds"] = process.env.EXT_FACILITY_IDS; // "ALL" or "10,20"
  // Some tenants still require 3PL headers
  if (process.env.EXT_WAREHOUSE_ID) h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID)  h["3PL-Customer-Id"]  = process.env.EXT_CUSTOMER_ID;
  return h;
}

// ✅ Named export that routes import: { fetchAndUpsertOrders }
export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  const base = baseUrl();
  const pool = await getPool();
  let page = 1;
  let imported = 0;

  while (true) {
    // ----- call orders API (prefer v1 path; fallback to legacy) -----
    let list = [];
    try {
      const headers = await authHeaders();
      let resp;
      try {
        resp = await axios.get(`${base}/api/v1/orders`, {
          headers,
          params: { page, pageSize, ...(modifiedSince ? { modifiedDateStart: modifiedSince } : {}), ...(status ? { status } : {}) },
          timeout: 20000
        });
      } catch (e1) {
        if (e1.response?.status === 404) {
          resp = await axios.get(`${base}/orders`, {
            headers,
            params: { page, pageSize, ...(modifiedSince ? { modifiedDateStart: modifiedSince } : {}), ...(status ? { status } : {}) },
            timeout: 20000
          });
        } else {
          throw e1;
        }
      }
      const data = resp.data;
      list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("[Extensiv /orders error]", err.response?.status, err.response?.data || err.message);
      throw err;
    }

    if (!list.length) break;

    // ----- upsert items into SQL -----
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
