// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

const TIMEOUT = 20000;

// ---------------- helpers ----------------
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const nowMs = () => Date.now();
function pickList(data) {
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
}

// --------------- AUTH: BASIC or BEARER ---------------
let tokenCache = { token: null, exp: 0, winner: null };

/**
 * Bearer token fetch (only used if EXT_AUTH_MODE=bearer).
 * Tries box oauth/form, secure-wms oauth/form, and AuthServer JSON
 * with both user_login vs user_login_id and tplguid vs tpl. Caches winner.
 */
export async function getAccessToken() {
  if (tokenCache.token && nowMs() < tokenCache.exp - 60_000) return tokenCache.token;

  const basicB64 =
    process.env.EXT_BASIC_AUTH_B64 ||
    (process.env.EXT_CLIENT_ID && process.env.EXT_CLIENT_SECRET
      ? Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64")
      : null);
  if (!basicB64) throw new Error("Bearer mode: missing EXT_BASIC_AUTH_B64 or EXT_CLIENT_ID/EXT_CLIENT_SECRET");

  const userLogin    = process.env.EXT_USER_LOGIN || "";
  const userLoginId  = process.env.EXT_USER_LOGIN_ID;
  const tplguid      = process.env.EXT_TPL_GUID;
  const tpl          = process.env.EXT_TPL || process.env.EXT_TPL_ID;

  // Build endpoint candidates (EXT_TOKEN_URL override first if present)
  const endpoints = [];
  if (process.env.EXT_TOKEN_URL) endpoints.push({ url: trimBase(process.env.EXT_TOKEN_URL), style: "form" });
  endpoints.push(
    { url: "https://box.secure-wms.com/oauth/token", style: "form" },
    { url: "https://secure-wms.com/oauth/token",     style: "form" },
    { url: "https://secure-wms.com/AuthServer/api/Token", style: "json" },
    { url: "https://box.secure-wms.com/AuthServer/api/Token", style: "json" }, // some tenants mirror here
  );

  // Try field variants
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
            headers: { ...headers, Accept: "application/json", Authorization: `Basic ${basicB64}` },
            timeout: TIMEOUT,
          });
          const { access_token, expires_in = 1800 } = r.data || {};
          if (!access_token) throw new Error(`No access_token from ${ep.url}`);
          tokenCache = { token: access_token, exp: nowMs() + expires_in * 1000, winner: { ...ep, uKey, tKey } };
          if (process.env.LOG_TOKEN_DEBUG === "true") console.log("[OAuth winner]", tokenCache.winner);
          return access_token;
        } catch (e) {
          attempts.push({
            url: ep.url, style: ep.style, uKey, tKey,
            status: e.response?.status || null,
            data: e.response?.data || String(e.message),
          });
        }
      }
    }
  }
  throw new Error("All token endpoints failed: " + JSON.stringify(attempts.slice(0, 6), null, 2));
}

/**
 * Build headers depending on mode.
 * BASIC (default): Authorization: Basic <base64>
 * BEARER: Authorization: Bearer <token>
 */
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

  // Scoping headers (set in Render env)
  if (process.env.EXT_CUSTOMER_IDS) {
    h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS;
    h["CustomerIDs"] = process.env.EXT_CUSTOMER_IDS; // alt casing
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

// --------------- ORDERS -> SQL upsert ---------------
export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const pool = await getPool();

  // Prefer legacy path first on many box tenants, then fallbacks
  const endpoints = [
    `${base}/orders`,
    `${base}/api/v1/orders`,
    `${base}/api/orders`,
  ];

  let page = 1;
  let imported = 0;

  while (true) {
    let list = [];
    let lastErr = null;
    const headers = await authHeaders();

    for (const url of endpoints) {
      try {
        const r = await axios.get(url, {
          headers,
          params: {
            page,
            pageSize,
            // filters
            ...(modifiedSince ? { modifiedDateStart: modifiedSince } : {}),
            ...(status ? { status } : {}),
            // scoping as query params (cover common casings)
            ...(process.env.EXT_CUSTOMER_IDS
              ? { customerIds: process.env.EXT_CUSTOMER_IDS, customerIDs: process.env.EXT_CUSTOMER_IDS }
              : {}),
            ...(process.env.EXT_FACILITY_IDS
              ? { facilityIds: process.env.EXT_FACILITY_IDS, facilityIDs: process.env.EXT_FACILITY_IDS }
              : {}),
          },
          timeout: TIMEOUT,
        });
        list = pickList(r.data);
        lastErr = null;
        break; // success on this endpoint
      } catch (e) {
        lastErr = e;
        const s = e.response?.status;
        if (![401, 403, 404].includes(s)) throw e; // only continue on typical auth/path issues
      }
    }

    if (lastErr) {
      console.error("[Extensiv /orders error]", lastErr.response?.status, lastErr.response?.data || lastErr.message);
      throw lastErr;
    }
    if (!list.length) break;

    // Upsert items to SQL
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
    if (list.length < pageSize) break; // last page
    page++;
  }

  return { imported };
}
