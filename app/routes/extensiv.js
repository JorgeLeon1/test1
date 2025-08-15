// src/app/routes/extensiv.js
import { Router } from "express";
import axios from "axios";
import * as extMod from "../services/extensivClient.js";
import { getPool } from "../services/db/mssql.js";

/* --------------------------- module + router --------------------------- */
const ext = extMod?.default ?? extMod; // works whether the service uses default or named exports
const r = Router();

/* ------------------------------ helpers ------------------------------- */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const firstArray = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.ResourceList)) return data.ResourceList;
  if (Array.isArray(data?._embedded?.["http://api.3plCentral.com/rels/orders/order"])) {
    return data._embedded["http://api.3plCentral.com/rels/orders/order"];
  }
  if (Array.isArray(data?.data)) return data.data;
  for (const v of Object.values(data || {})) if (Array.isArray(v)) return v;
  return [];
};

/* Build auth headers here in case the service module doesn’t export authHeaders() */
async function authHeadersSafe() {
  // If the service provides it, use that.
  if (typeof ext.authHeaders === "function") return await ext.authHeaders();

  // Minimal local fallback
  const b64 = process.env.EXT_BASIC_AUTH_B64 || "";
  if (b64) {
    return {
      Authorization: `Basic ${b64}`,
      Accept: "application/hal+json, application/json",
      "Content-Type": "application/hal+json; charset=utf-8",
    };
  }

  const tokenUrl = process.env.EXT_TOKEN_URL;
  if (tokenUrl) {
    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");
    if (process.env.EXT_USER_LOGIN) form.set("user_login", process.env.EXT_USER_LOGIN);
    if (process.env.EXT_USER_LOGIN_ID) form.set("user_login_id", process.env.EXT_USER_LOGIN_ID);
    if (process.env.EXT_TPL_GUID) form.set("tplguid", process.env.EXT_TPL_GUID);

    const basic = process.env.EXT_BASIC_AUTH_B64 ? `Basic ${process.env.EXT_BASIC_AUTH_B64}` : "";
    const resp = await axios.post(tokenUrl, form, {
      headers: {
        Authorization: basic,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (resp.status >= 200 && resp.status < 300 && resp.data?.access_token) {
      return {
        Authorization: `Bearer ${resp.data.access_token}`,
        Accept: "application/hal+json, application/json",
        "Content-Type": "application/hal+json; charset=utf-8",
      };
    }
  }

  throw new Error("No auth configured (missing EXT_BASIC_AUTH_B64 or OAuth token config).");
}

/* -------------------------------- DEBUG -------------------------------- */
r.get("/_debug", (_req, res) => {
  res.json({
    routeMounted: true,
    envPresent: {
      EXT_API_BASE: !!process.env.EXT_API_BASE,
      EXT_BASE_URL: !!process.env.EXT_BASE_URL,
      EXT_AUTH_MODE: process.env.EXT_AUTH_MODE || null,
      EXT_CLIENT_ID: !!process.env.EXT_CLIENT_ID,
      EXT_CLIENT_SECRET: !!process.env.EXT_CLIENT_SECRET,
      EXT_BASIC_AUTH_B64: !!process.env.EXT_BASIC_AUTH_B64,
      EXT_TOKEN_URL: !!process.env.EXT_TOKEN_URL,
      EXT_TPL_GUID: !!process.env.EXT_TPL_GUID,
      EXT_USER_LOGIN: !!process.env.EXT_USER_LOGIN,
      EXT_USER_LOGIN_ID: !!process.env.EXT_USER_LOGIN_ID,
      EXT_CUSTOMER_IDS: !!process.env.EXT_CUSTOMER_IDS,
      EXT_FACILITY_IDS: !!process.env.EXT_FACILITY_IDS,
      SQL_SERVER: !!process.env.SQL_SERVER,
      SQL_DATABASE: !!process.env.SQL_DATABASE,
      SQL_USER: !!process.env.SQL_USER,
      SQL_PASSWORD: !!process.env.SQL_PASSWORD,
    },
    serviceExports: {
      hasAuthHeaders: typeof ext.authHeaders === "function",
      hasFetchAndUpsertOrders: typeof ext.fetchAndUpsertOrders === "function",
      hasFetchOneOrderDetail: typeof ext.fetchOneOrderDetail === "function",
    },
  });
});

r.get("/token", async (_req, res, next) => {
  try {
    const h = await authHeadersSafe();
    const bearer = h.Authorization?.startsWith("Bearer ") ? h.Authorization.slice(7) : "";
    res.json({
      ok: true,
      mode: h.Authorization?.startsWith("Bearer ") ? "bearer" : "basic",
      tokenLen: bearer.length,
      head: bearer.slice(0, 12),
      tail: bearer.slice(-8),
    });
  } catch (e) {
    next(e);
  }
});

/* -------------------------------- PEEK --------------------------------- */
r.get("/peek", async (_req, res, next) => {
  try {
    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
    const h = await authHeadersSafe();
    const resp = await axios.get(`${base}/orders`, { headers: h, timeout: 15000 });
    const data = resp.data;
    const list = firstArray(data);

    res.json({
      ok: true,
      status: resp.status,
      topLevelType: Array.isArray(data) ? "array" : "object",
      keys: data && typeof data === "object" ? Object.keys(data) : [],
      firstArrayKey: Array.isArray(data?.ResourceList)
        ? "ResourceList"
        : Array.isArray(data?.data)
        ? "data"
        : Array.isArray(data?._embedded?.["http://api.3plCentral.com/rels/orders/order"])
        ? "_embedded/orders/order"
        : Array.isArray(data)
        ? "(root)"
        : "none",
      firstArrayLen: list.length,
      sample: list[0] || data,
    });
  } catch (e) {
    next(e);
  }
});

r.get("/peekOrder", async (req, res, next) => {
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ ok: false, message: "Provide ?id=<OrderId>" });

    if (typeof ext.fetchOneOrderDetail === "function") {
      const payload = await ext.fetchOneOrderDetail(id);
      return res.json({ ok: true, orderId: id, payload });
    }

    // Fallback if service didn’t export helper
    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
    const headers = await authHeadersSafe();
    const { data } = await axios.get(`${base}/orders`, {
      headers,
      params: { pgsiz: 1, pgnum: 1, detail: "OrderItems", itemdetail: "All", rql: `readOnly.orderId==${id}` },
      timeout: 20000,
    });
    const list = firstArray(data);
    res.json({ ok: true, orderId: id, payload: list[0] || null });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- ACTIONS ------------------------------- */
r.post("/import", async (req, res, next) => {
  try {
    if (typeof ext.fetchAndUpsertOrders !== "function") {
      return res
        .status(500)
        .json({ ok: false, message: "extensivClient.fetchAndUpsertOrders() is not available." });
    }
    // Default to open/unallocated only unless caller overrides
    const body = req.body || {};
    if (typeof body.openOnly === "undefined") body.openOnly = true;

    const result = await ext.fetchAndUpsertOrders(body);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- SELFTEST ------------------------------ */
r.get("/selftest", async (_req, res) => {
  const out = { ok: false, steps: {} };
  try {
    const headers = await authHeadersSafe();
    out.steps.auth = "ok";

    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
    const o = await axios.get(`${base}/orders`, { headers, timeout: 15000 });
    const list = firstArray(o.data);
    out.steps.orders = { status: o.status, count: list.length };

    const pool = await getPool();
    await pool.request().query("SELECT 1 as ok");
    out.steps.db = "connect-ok";

    // Create a minimal OrderDetails table if it doesn’t exist (for connectivity)
    await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
  CREATE TABLE dbo.OrderDetails (
    OrderItemID   INT          NOT NULL PRIMARY KEY,
    OrderID       INT          NULL,
    CustomerName  VARCHAR(200) NULL,
    CustomerID    INT          NULL,
    ItemID        VARCHAR(150) NULL,
    SKU           VARCHAR(150) NULL,
    UnitID        INT          NULL,
    UnitName      VARCHAR(80)  NULL,
    Qualifier     VARCHAR(80)  NULL,
    OrderedQTY    INT          NULL,
    ReferenceNum  VARCHAR(120) NULL,
    ShipToAddress1 VARCHAR(255) NULL
  );
    `);

    out.steps.tables = "ok";
    out.ok = true;
    res.json(out);
  } catch (e) {
    res.status(500).json({
      ok: false,
      where: out.steps.auth ? (out.steps.orders ? (out.steps.db ? "tables" : "db") : "orders") : "auth",
      status: e.response?.status || 500,
      message: e.message,
      data: e.response?.data,
    });
  }
});

export default r;
