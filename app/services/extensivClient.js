import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

const TIMEOUT = 20000;

// helpers
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const nowMs = () => Date.now();
const listify = (data) => (Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []));

// ---------------- AUTH (Basic or Bearer) ----------------
let tokenCache = { token: null, exp: 0, winner: null };

export async function getAccessToken() {
  if (tokenCache.token && nowMs() < tokenCache.exp - 60_000) return tokenCache.token;

  const b64 =
    process.env.EXT_BASIC_AUTH_B64 ||
    (process.env.EXT_CLIENT_ID && process.env.EXT_CLIENT_SECRET
      ? Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64")
      : null);

  if (!b64) throw new Error("Bearer mode: missing EXT_BASIC_AUTH_B64 or EXT_CLIENT_ID/EXT_CLIENT_SECRET");

  const userLogin   = process.env.EXT_USER_LOGIN || "";
  const userLoginId = process.env.EXT_USER_LOGIN_ID;
  const tplguid     = process.env.EXT_TPL_GUID;
  const tpl         = process.env.EXT_TPL || process.env.EXT_TPL_ID;

  const endpoints = [];
  if (process.env.EXT_TOKEN_URL) endpoints.push({ url: trimBase(process.env.EXT_TOKEN_URL), style: "form" });
  endpoints.push(
    { url: "https://box.secure-wms.com/oauth/token", style: "form" },
    { url: "https://secure-wms.com/oauth/token",     style: "form" },
    { url: "https://secure-wms.com/AuthServer/api/Token", style: "json" },
    { url: "https://box.secure-wms.com/AuthServer/api/Token", style: "json" }
  );

  const userKeys = userLoginId ? [["user_login_id", String(userLoginId)], ["user_login", String(userLogin)]] 
                               : [["user_login", String(userLogin)]];
  const tplKeys  = tplguid ? [["tplguid", String(tplguid)], ...(tpl ? [["tpl", String(tpl)]] : [])]
                           : (tpl ? [["tpl", String(tpl)]] : [["tpl", ""]]);

  const attempts = [];
  for (const ep of endpoints) {
    for (const [uKey, uVal] of userKeys) {
      for (const [tKey, tVal] of tplKeys) {
        try {
          let data, headers;
          if (ep.style === "form") {
            const form = new URLSearchParams({ grant_type: "client_credentials", [uKey]: uVal });
            if (tVal) form.append(tKey, tVal);
            data = form;
            headers = { "Content-Type": "application/x-www-form-urlencoded" };
          } else {
            const body = { grant_type: "client_credentials", [uKey]: uVal };
            if (tVal) body[tKey] = tVal;
            data = body;
            headers = { "Content-Type": "application/json" };
          }

          const r = await axios.post(ep.url, data, {
            headers: { ...headers, Accept: "application/json", Authorization: `Basic ${b64}` },
            timeout: TIMEOUT,
          });
          const { access_token, expires_in = 1800 } = r.data || {};
          if (!access_token) throw new Error(`No access_token from ${ep.url}`);
          tokenCache = { token: access_token, exp: nowMs() + expires_in * 1000, winner: { ...ep, uKey, tKey } };
          if (process.env.LOG_TOKEN_DEBUG === "true") console.log("[OAuth winner]", tokenCache.winner);
          return access_token;
        } catch (e) {
          attempts.push({ url: ep.url, style: ep.style, uKey, tKey, status: e.response?.status || null, data: e.response?.data || String(e.message) });
        }
      }
    }
  }
  throw new Error("All token endpoints failed: " + JSON.stringify(attempts.slice(0, 6), null, 2));
}

export async function authHeaders() {
  const mode = (process.env.EXT_AUTH_MODE || "basic").toLowerCase();
  const h = { Accept: "application/json", "Content-Type": "application/json" };

  if (mode === "bearer") {
    const token = await getAccessToken();
    h.Authorization = `Bearer ${token}`;
  } else {
    const b64 =
      process.env.EXT_BASIC_AUTH_B64 ||
      Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64");
    h.Authorization = `Basic ${b64}`;
  }

  // Scoping via headers (legacy /orders prefers headers over query params)
  if (process.env.EXT_CUSTOMER_IDS) {
    h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS;
    h["CustomerIDs"] = process.env.EXT_CUSTOMER_IDS; // alternate casing
  }
  if (process.env.EXT_FACILITY_IDS) {
    h["FacilityIds"] = process.env.EXT_FACILITY_IDS;
    h["FacilityIDs"] = process.env.EXT_FACILITY_IDS;
  }
  if (process.env.EXT_WAREHOUSE_ID) h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID)  h["3PL-Customer-Id"]  = process.env.EXT_CUSTOMER_ID;
  if (process.env.EXT_USER_LOGIN)   h["User-Login"]       = process.env.EXT_USER_LOGIN;
  if (process.env.EXT_USER_LOGIN_ID)h["User-Login-Id"]    = process.env.EXT_USER_LOGIN_ID;

  return h;
}

// ---------------- Fetch orders and upsert to SQL ----------------
export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const pool = await getPool();

  // Try legacy first; if that fails, try v1/api
  const endpoints = [
    `${base}/orders`,         // legacy — NO query params
    `${base}/api/v1/orders`,  // fallback
    `${base}/api/orders`,     // alt fallback
  ];

  let page = 1;
  let imported = 0;

  while (true) {
    let list = [];
    let lastErr = null;
    const headers = await authHeaders();

    for (const url of endpoints) {
      const isLegacy = url.endsWith("/orders");

      try {
        const resp = await axios.get(url, {
          headers,
          // Only send params for non-legacy endpoints
          ...(isLegacy ? {} : {
            params: {
              page,
              pageSize,
              ...(modifiedSince ? { modifiedDateStart: modifiedSince } : {}),
              ...(status ? { status } : {}),
            }
          }),
          timeout: TIMEOUT,
        });

        list = listify(resp.data);
        lastErr = null;
        break; // stop at first endpoint that responds
      } catch (e) {
        lastErr = e;
        const s = e.response?.status;
        if (![400, 401, 403, 404].includes(s)) throw e; // only fall through on common path/auth errors
      }
    }

    if (lastErr) {
      console.error("[Extensiv /orders error]", lastErr.response?.status, lastErr.response?.data || lastErr.message);
      throw lastErr;
    }
    if (!list.length) break;

    // Upsert items -> SQL
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

    // Legacy has no supported paging → stop after first batch
    break;
  }

  return { imported };
}
