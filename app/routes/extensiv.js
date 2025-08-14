// src/app/routes/extensiv.js
import { Router } from "express";
import axios from "axios";
import { authHeaders, fetchAndUpsertOrders, fetchOneOrderDetail } from "../services/extensivClient.js";
import { getPool } from "../services/db/mssql.js";
import {
  getOrderWithItems,
  buildAllocationPlan,
  allocateOrderById,
} from "../services/extensivClient.js";

// Dry-run: build the plan but DO NOT post to Extensiv
r.post("/plan-order", async (req, res, next) => {
  try {
    const orderId = Number(req.body?.orderId);
    if (!orderId) return res.status(400).json({ ok: false, message: "Provide { orderId }" });

    const order = await getOrderWithItems(orderId);
    const { plan, debug } = await buildAllocationPlan(order);

    res.json({
      ok: true,
      orderId,
      itemsPlanned: plan.length,
      previewPayload: { proposedAllocations: plan },
      debug,
    });
  } catch (e) {
    next(e);
  }
});

// Live allocate: build plan and POST /orders/{id}/allocator
r.post("/allocate-order", async (req, res, next) => {
  try {
    const orderId = Number(req.body?.orderId);
    if (!orderId) return res.status(400).json({ ok: false, message: "Provide { orderId }" });

    const result = await allocateOrderById(orderId);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    next(e);
  }
});



const r = Router();

const trimBase = (u) => (u || "").replace(/\/+$/, "");
const firstArray = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.ResourceList)) return data.ResourceList;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?._embedded?.["http://api.3plCentral.com/rels/orders/order"]))
    return data._embedded["http://api.3plCentral.com/rels/orders/order"];
  for (const v of Object.values(data || {})) if (Array.isArray(v)) return v;
  return [];
};

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
  });
});

r.get("/token", async (_req, res, next) => {
  try {
    const h = await authHeaders();
    const bearer = h.Authorization?.startsWith("Bearer ") ? h.Authorization.slice(7) : "";
    res.json({ ok: true, tokenLen: bearer.length, head: bearer.slice(0, 12), tail: bearer.slice(-8) });
  } catch (e) {
    next(e);
  }
});

r.get("/peek", async (_req, res, next) => {
  try {
    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
    const h = await authHeaders();
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
    const payload = await fetchOneOrderDetail(id);
    const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];
    res.json({ ok: true, orderId: id, keys, sample: payload });
  } catch (e) {
    next(e);
  }
});

r.post("/import", async (req, res, next) => {
  try {
    const result = await fetchAndUpsertOrders(req.body || {});
    res.json(result);
  } catch (e) {
    next(e);
  }
});

r.get("/selftest", async (_req, res) => {
  const out = { ok: false, steps: {} };
  try {
    const headers = await authHeaders();
    out.steps.auth = "ok";

    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
    const o = await axios.get(`${base}/orders`, { headers, timeout: 15000 });
    const list = firstArray(o.data);
    out.steps.orders = { status: o.status, count: list.length };

    const pool = await getPool();
    await pool.request().query("SELECT 1 as ok");
    out.steps.db = "connect-ok";

    await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
  CREATE TABLE dbo.OrderDetails (
    OrderItemID INT NULL,
    OrderId     INT NULL,
    ItemID      VARCHAR(100) NULL,
    Qualifier   VARCHAR(50) NULL,
    OrderedQTY  INT NULL
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
