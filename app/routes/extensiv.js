// src/app/routes/extensiv.js
import { Router } from "express";
import axios from "axios";
import * as extMod from "../services/extensivClient.js";
import * as dbMod from "../services/db/mssql.js";

// normalize imports (support named or default)
const ext = extMod?.default ?? extMod;
const db = dbMod?.default ?? dbMod;

const r = Router();

/* ------------------------------ helpers ------------------------------- */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const firstArray = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.ResourceList)) return data.ResourceList;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?._embedded?.["http://api.3plCentral.com/rels/orders/order"])) {
    return data._embedded["http://api.3plCentral.com/rels/orders/order"];
  }
  for (const v of Object.values(data || {})) if (Array.isArray(v)) return v;
  return [];
};

async function authHeadersSafe() {
  if (typeof ext.authHeaders === "function") return await ext.authHeaders();

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
  throw new Error("No auth configured (EXT_BASIC_AUTH_B64 or OAuth token).");
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
      SQL_SERVER: !!process.env.SQL_SERVER,
      SQL_DATABASE: !!process.env.SQL_DATABASE,
      SQL_USER: !!process.env.SQL_USER,
      SQL_PASSWORD: !!process.env.SQL_PASSWORD,
    },
    serviceExports: Object.keys(ext),
    dbExports: Object.keys(db),
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
    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com");
    const h = await authHeadersSafe();
    const resp = await axios.get(`${base}/orders`, { headers: h, timeout: 15000 });
    const data = resp.data;
    const list = firstArray(data);

    res.json({
      ok: true,
      status: resp.status,
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

    // fallback if helper not present
    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com");
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
    const body = req.body || {};
    if (typeof body.openOnly === "undefined") body.openOnly = true; // only open/unallocated by default
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

    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com");
    const o = await axios.get(`${base}/orders`, { headers, timeout: 15000 });
    const list = firstArray(o.data);
    out.steps.orders = { status: o.status, count: list.length };

    const getPool = db?.getPool; // support named or default export
    if (typeof getPool !== "function") throw new Error("DB getPool export missing.");
    const pool = await getPool();
    await pool.request().query("SELECT 1 as ok");
    out.steps.db = "connect-ok";

    // minimal table create for connectivity check
    await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
  CREATE TABLE dbo.OrderDetails (
    OrderItemID    INT          NOT NULL PRIMARY KEY,
    OrderID        INT          NULL,
    CustomerName   VARCHAR(200) NULL,
    CustomerID     INT          NULL,
    ItemID         VARCHAR(150) NULL,
    SKU            VARCHAR(150) NULL,
    UnitID         INT          NULL,
    UnitName       VARCHAR(80)  NULL,
    Qualifier      VARCHAR(80)  NULL,
    OrderedQTY     INT          NULL,
    ReferenceNum   VARCHAR(120) NULL,
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
