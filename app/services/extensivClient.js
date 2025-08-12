// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

const TIMEOUT = 20000;

// ----------------------------- helpers -----------------------------
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const nowMs = () => Date.now();

function pickList(data) {
  // API may return an array or an object with { data: [] }
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
}

// ----------------------------- AUTH: BASIC or BEARER -----------------------------
let tokenCache = { token: null, exp: 0, winner: null };

/**
 * Builds headers based on EXT_AUTH_MODE.
 * BASIC (default): Authorization: Basic <base64(clientId:clientSecret)>
 * BEARER: Acquire token then set Authorization: Bearer <token>
 */
export async function authHeaders() {
  const mode = (process.env.EXT_AUTH_MODE || "basic").toLowerCase();
  const h = { Accept: "application/json", "Content-Type": "application/json" };

  if (mode === "bearer") {
    const token = await getAccessToken();
    h.Authorization = `Bearer ${token}`;
  } else {
    // BASIC by default (matches your working Postman flow)
    const b64 =
      process.env.EXT_BASIC_AUTH_B64 ||
      Buffer.from(`${process.env.EXT_CLIENT_ID}:${process.env.EXT_CLIENT_SECRET}`).toString("base64");
    h.Authorization = `Basic ${b64}`;
  }

  // scoping headers (set in Render env)
  if (process.env.EXT_CUSTOMER_IDS) {
    h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS;
    h["CustomerIDs"] = process.env.EXT_CUSTOMER_IDS; // some tenants prefer this casing
  }
  if (process.env.EXT_FACILITY_IDS) {
    h["FacilityIds"] = process.env.EXT_FACILITY_IDS;
    h["FacilityIDs"] = process.env.EXT_FACILITY_IDS;
  }
  if (process.env.EXT_WAREHOUSE_ID) h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID)  h["3PL-Customer-Id"]  = process.env.EXT_CUSTOMER_ID;
  if (process.env.EXT_USER_LOGIN)   h["User-Login"]       = process.env.EXT_USER_LOGIN;
  if (process.env.EXT_USER_LOGIN_ID) h["User-Login-Id"]   = process.env.EXT_USER_LOGIN_ID;

  return h;
}

/**
 * Token fetcher (only used if EXT_AUTH_MODE=bearer).
 * Tries the exact Postman flow you confirmed, then falls back to AuthServer.
 */
export async function getAccessToken() {
  const fresh = tokenCache.token && nowMs() < tokenCache.exp - 60_000;
  if (fresh) return tokenCache.token;

  const clientId = process.env.EXT_CLIENT_ID;
  const clientSecret = process.env.EXT_CLIENT_SECRET;
  const b64 =
    process.env.EXT_BASIC_AUTH_B64 ||
    (clientId && clientSecret ? Buffer.from(`${clientId}:${clientSecret}`).toString("base64") : null);

  if (!b64) {
    throw new Error("Bearer mode: missing EXT_BASIC_AUTH_B64 or EXT_CLIENT_ID / EXT_CLIENT_SECRET");
  }

  // Postman-confirmed token style (Box OAuth)
  const boxTokenUrl = trimBase(process.env.EXT_TOKEN_URL) || "https://box.secure-wms.com/oauth/token";
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    ...(process.env.EXT_USER_LOGIN_ID
      ? { user_login_id: String(process.env.EXT_USER_LOGIN_ID) }
      : { user_login: String(process.env.EXT_USER_LOGIN || "") }),
  });
  if (process.env.EXT_TPL_GUID) form.append("tplguid", String(process.env.EXT_TPL_GUID));
  if (process.env.EXT_TPL)      form.append("tpl", String(process.env.EXT_TPL));

  const attempts = [];

  // Attempt A: Box OAuth (x-www-form-urlencoded + Basic)
  try {
    const r = await axios.post(boxTokenUrl, form, {
      headers: {
        Authorization: `Basic ${b64}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: TIMEOUT,
    });
    const { access_token, expires_in = 1800 } = r.data || {};
    if (!access_token) throw new Error("No access_token in Box token response");
    tokenCache = { token: access_token, exp: nowMs() + expires_in * 1000, winner: { url: boxTokenUrl, mode: "box" } };
    return
