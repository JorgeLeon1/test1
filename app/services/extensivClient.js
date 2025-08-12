// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

// Simple in-memory token cache
let tokenCache = { access_token: null, exp: 0 };

const trimBase = (u) => (u || "").replace(/\/+$/, "");

// -------- TOKEN: Basic -> Bearer (Postman flow you confirmed) --------
export async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.exp - 60_000) {
    return tokenCache.access_token;
  }

  // Prefer your precomputed Base64 if provided; else compute from id:secret
  const basicB64 =
    process.env.EXT_BASIC_AUTH_B64 ||
    Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64");

  if (!basicB64) throw new Error("Missing EXT_BASIC_AUTH_B64 or EXT_CLIENT_ID/EXT_CLIENT_SECRET");

  const tokenUrl = trimBase(process.env.EXT_TOKEN_URL) || "https://box.secure-wms.com/oauth/token";

  // Body exactly like your working Postman call
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    // prefer explicit login id if you want, but your sandbox worked with user_login
    ...(process.env.EXT_USER_LOGIN_ID
      ? { user_login_id: String(process.env.EXT_USER_LOGIN_ID) }
      : { user_login: String(process.env.EXT_USER_LOGIN || "") })
  });

  // Optional: if your tenant demands it, you can set EXT_TPL_GUID or EXT_TPL to include here.
  if (process.env.EXT_TPL_GUID) form.append("tplguid", String(process.env.EXT_TPL_GUID));
  if (process.env.EXT_TPL)      form.append("tpl", String(process.env.EXT_TPL));

  const resp = await axios.post(tokenUrl, form, {
    headers: {
      "Authorization": `Basic ${basicB64}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    timeout: 20000
  });

  const { access_token, expires_in = 1800 } = resp.data || {};
  if (!access_token) throw new Error("No access_token in token response");
  tokenCache = { access_token, exp: Date.now() + expires_in * 1000 };
  if (process.env.LOG_TOKEN_DEBUG === "true") {
    console.log("[token ok] len=", access_token.length, "expIn=", expires_in);
  }
  return access_token;
}

// -------- Headers for resource calls (Bearer + optional scoping) --------
export async function authHeaders() {
  const bearer = await getAccessToken();
  const h = {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  // Only include scoping headers if you’ve set them
  if (process.env.EXT_CUSTOMER_IDS) { h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS; h["CustomerIDs"] = process.env.EXT_CUSTOMER_IDS; }
  if (process.env.EXT_FACILITY_IDS) { h["FacilityIds"] = process.env.EXT_FACILITY_IDS; h["FacilityIDs"] = process.env.EXT_FACILITY_IDS; }
  if (process.env.EXT_WAREHOUSE_ID)  h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID)   h["3PL-Customer-Id"]  = process.env.EXT_CUSTOMER_ID;
  return h;
}

// -------- Import from Extensiv & upsert to SQL --------
export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  const base = trimBase(process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const pool = await getPool();

  // Try modern path first, then legacy fallbacks
  const candidates = [`${base}/api/v1/orders`, `${base}/orders`, `${base}/api/orders`];

  let page = 1, imported = 0;

  while (true) {
    let list = [];
    const headers = await authHeaders();
    let lastErr = null;

    for (const url of candidates) {
      try {
        const resp = await axios.get(url, {
          headers,
          params: {
            page,
            pageSize,
            ...(modifiedSince ? { modifiedDateStart: modifiedSince } : {}),
            ...(status ? { status } : {}),
          },
          timeout: 20000,
        });
        const d = resp.data;
        list = Array.isArray(d?.data) ? d.data : (Array.isArray(d) ? d : []);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const s = e.response?.status;
        // Only keep trying on typical auth/path issues; throw on others
        if (![401, 403, 404].includes(s)) throw e;
      }
    }

    if (lastErr) {
      console.error("[Extensiv orders error]", lastErr.response?.status, lastErr.response?.data || lastErr.message);
      throw lastErr;
    }
    if (!list.length) break;

    // Upsert each item to your SQL table
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
