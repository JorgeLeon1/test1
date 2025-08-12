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
let tokenCache = { token: null, exp: 0 };

/**
 * Bearer token fetch (only used if EXT_AUTH_MODE=bearer).
 * Uses the exact Postman flow you confirmed:
 *   POST https://box.secure-wms.com/oauth/token
 *   Authorization: Basic <base64(clientId:clientSecret)>
 *   Body (x-www-form-urlencoded): grant_type=client_credentials, user_login or user_login_id
 */
export async function getAccessToken() {
  const fresh = tokenCache.token && nowMs() < tokenCache.exp - 60_000;
  if (fresh) return tokenCache.token;

  const b64 =
    process.env.EXT_BASIC_AUTH_B64 ||
    (process.env.EXT_CLIENT_ID && process.env.EXT_CLIENT_SECRET
      ? Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64")
      : null);

  if (!b64) {
    throw new Error("Bearer mode: missing EXT_BASIC_AUTH_B64 or EXT_CLIENT_ID/EXT_CLIENT_SECRET");
  }

  const tokenUrl = trimBase(process.env.EXT_TOKEN_URL) || "https://box.secure-wms.com/oauth/token";
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    ...(process.env.EXT_USER_LOGIN_ID
      ? { user_login_id: String(process.env.EXT_USER_LOGIN_ID) }
      : { user_login: String(process.env.EXT_USER_LOGIN || "") })
  });
  // Optional, only if tenant requires:
  if (process.env.EXT_TPL_GUID) form.append("tplguid", String(process.env.EXT_TPL_GUID));
  if (process.env.EXT_TPL) form.append("tpl", String(process.env.EXT_TPL));

  const r = await axios.post(tokenUrl, form, {
    headers: {
      Authorization: `Basic ${b64}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    timeout: TIMEOUT
  });

  const { access_token, expires_in = 1800 } = r.data || {};
  if (!access_token) throw new Error("No access_token in token response");
  tokenCache = { token: access_token, exp: nowMs() + expires_in * 1000 };
  return access_token;
}

/**
 * Build headers depending on mode.
 * BASIC (default): Authorization: Basic <base64>
 * BEARER: Authorization: Bearer <token>
 */
export async function authHeaders() {
  const mode = (process.env.EXT_AUTH_MODE || "basic").toLowerCase();
  const h = {
    Accept: "application/json",
    "Content-Type": "application/json"
  };

  if (mode === "bearer") {
    const token = await getAccessToken();
    h.Authorization = `Bearer ${token}`;
  } else {
    const b64 =
      process.env.EXT_BASIC_AUTH_B64 ||
      Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64");
    h.Authorization = `Basic ${b64}`;
  }

  // Scoping headers (set these in Render if your tenant requires them)
  if (process.env.EXT_CUSTOMER_IDS) {
    h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS;
    h["CustomerIDs"] = process.env.EXT_CUSTOMER_IDS; // alternate casing
  }
  if (process.env.EXT_FACILITY_IDS) {
    h["FacilityIds"] = process.env.EXT_FACILITY_IDS;
    h["FacilityIDs"] = process.env.EXT_FACILITY_IDS;
  }
  if (process.env.EXT_WAREHOUSE_ID) h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID) h["3PL-Customer-Id"] = process.env.EXT_CUSTOMER_ID;
  if (process.env.EXT_USER_LOGIN) h["User-Login"] = process.env.EXT_USER_LOGIN;
  if (process.env.EXT_USER_LOGIN_ID) h["User-Login-Id"] = process.env.EXT_USER_LOGIN_ID;

  return h;
}

// --------------- ORDERS -> SQL upsert ---------------
export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const pool = await getPool();

  const endpoints = [
    `${base}/api/v1/orders`, // modern
    `${base}/orders`,        // legacy
    `${base}/api/orders`     // alt
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
            ...(modifiedSince ? { modifiedDateStart: modifiedSince } : {}),
            ...(status ? { status } : {})
          },
          timeout: TIMEOUT
        });
        list = pickList(r.data);
        lastErr = null;
        break; // got a valid response from this endpoint
      } catch (e) {
        lastErr = e;
        const s = e.response?.status;
        // Try the next candidate on typical auth/path issues; otherwise surface the error
        if (![401, 403, 404].includes(s)) throw e;
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
