// src/app/routes/extensiv.js
import { Router } from "express";
import axios from "axios";

import {
  authHeaders,
  fetchAndUpsertOrders,
  fetchOneOrderDetail,
} from "../services/extensivClient.js";

import { getPool, sql } from "../services/db/mssql.js";

/* --------------------------- init router FIRST --------------------------- */
const r = Router();

/* -------------------------------- helpers -------------------------------- */
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

/* -------------------------------- DEBUG ---------------------------------- */

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

/* --------------------------------- PEEK ---------------------------------- */

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

/* --------------------------- IMPORT (orders -> SQL) ---------------------- */

r.post("/import", async (req, res, next) => {
  try {
    const result = await fetchAndUpsertOrders(req.body || {});
    res.json(result);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- SELFTEST -------------------------------- */

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
    OrderItemID INT NOT NULL PRIMARY KEY,
    OrderId     INT NULL,
    ItemID      VARCHAR(150) NULL, -- SKU
    Qualifier   VARCHAR(80)  NULL,
    OrderedQTY  INT          NULL
  );

IF OBJECT_ID('dbo.Inventory','U') IS NULL
  CREATE TABLE dbo.Inventory (
    ReceiveItemID INT NOT NULL PRIMARY KEY,
    ItemID        VARCHAR(150) NOT NULL,  -- SKU
    Qualifier     VARCHAR(80)  NULL,
    ReceivedQty   INT          NULL,
    AvailableQty  INT          NULL,
    LocationName  VARCHAR(120) NULL
  );

IF OBJECT_ID('dbo.SuggAlloc','U') IS NULL
  CREATE TABLE dbo.SuggAlloc (
    Id            INT IDENTITY(1,1) PRIMARY KEY,
    OrderId       INT NOT NULL,
    OrderItemID   INT NOT NULL,
    ReceiveItemID INT NOT NULL,
    SuggAllocQty  INT NOT NULL,
    CreatedAt     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
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

/* ====================== SEARCH + SQL ALLOCATION TOOLS ===================== */

/**
 * Find rows for one OrderId in dbo.OrderDetails (for your search bar).
 * GET /extensiv/search-order?orderId=205417
 */
r.get("/search-order", async (req, res, next) => {
  try {
    const orderId = Number(req.query.orderId);
    if (!orderId) return res.status(400).json({ ok: false, message: "Provide ?orderId=<number>" });

    const pool = await getPool();
    const items = await pool.request()
      .input("OrderId", sql.Int, orderId)
      .query(`
SELECT OrderItemID, OrderId, ItemID AS SKU, Qualifier, OrderedQTY
FROM dbo.OrderDetails
WHERE OrderId = @OrderId
ORDER BY OrderItemID;
    `);

    const summary = await pool.request()
      .input("OrderId", sql.Int, orderId)
      .query(`
SELECT COUNT(*) AS lineCount, SUM(OrderedQTY) AS totalQty
FROM dbo.OrderDetails WHERE OrderId = @OrderId;
    `);

    res.json({
      ok: true,
      orderId,
      lines: items.recordset,
      summary: summary.recordset?.[0] || { lineCount: 0, totalQty: 0 },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Run your SuggAlloc loop for a single order.
 * POST /extensiv/allocate-sql  { "orderId": 205417 }
 */
r.post("/allocate-sql", async (req, res, next) => {
  try {
    const orderId = Number(req.body?.orderId);
    if (!orderId) return res.status(400).json({ ok: false, message: "Body must include { orderId:number }" });

    const pool = await getPool();

    // Ensure table exists
    await pool.request().batch(`
IF OBJECT_ID('dbo.SuggAlloc','U') IS NULL
  CREATE TABLE dbo.SuggAlloc (
    Id            INT IDENTITY(1,1) PRIMARY KEY,
    OrderId       INT NOT NULL,
    OrderItemID   INT NOT NULL,
    ReceiveItemID INT NOT NULL,
    SuggAllocQty  INT NOT NULL,
    CreatedAt     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
    `);

    // Clear previous suggestions for this order (optional; comment out if you want to append)
    await pool.request()
      .input("OrderId", sql.Int, orderId)
      .query(`DELETE FROM dbo.SuggAlloc WHERE OrderId = @OrderId;`);

    // Batch that follows your sequence logic, but scoped to a single order id.
    const allocationBatch = `
DECLARE @OrderId INT = @pOrderId;

WHILE EXISTS (
  SELECT 1
  FROM dbo.OrderDetails a
  LEFT JOIN (
    SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
    FROM dbo.SuggAlloc WHERE OrderId = @OrderId
    GROUP BY OrderItemID
  ) c ON a.OrderItemID = c.OrderItemID
  WHERE a.OrderId = @OrderId
    AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) > 0
)
BEGIN
  INSERT INTO dbo.SuggAlloc (OrderId, OrderItemID, ReceiveItemID, SuggAllocQty)
  SELECT TOP 1
    @OrderId AS OrderId,
    a.OrderItemID,
    b.ReceiveItemID,
    CASE WHEN (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY
         THEN b.AvailableQTY ELSE (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) END AS AllocQty
  FROM dbo.OrderDetails a
  LEFT JOIN (
    SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
    FROM dbo.SuggAlloc WHERE OrderId = @OrderId
    GROUP BY OrderItemID
  ) c ON a.OrderItemID = c.OrderItemID
  INNER JOIN dbo.Inventory b
    ON a.ItemID = b.ItemID
    AND ISNULL(a.Qualifier,'') = ISNULL(b.Qualifier,'')
  WHERE a.OrderId = @OrderId
    AND b.ReceiveItemId NOT IN (SELECT ReceiveItemID FROM dbo.SuggAlloc WHERE OrderId = @OrderId)
    AND b.AvailableQTY > 0
    AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) > 0
  ORDER BY
    a.OrderItemID,
    -- Your Seq logic
    CASE
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A'
           AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) = b.AvailableQty THEN 1
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A'
           AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) = b.AvailableQty THEN 2
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A'
           AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) > b.AvailableQty  THEN 3
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A'
           AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) > b.AvailableQty  THEN 4
      WHEN b.ReceivedQty > b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A'
           AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQty THEN 5
      WHEN b.ReceivedQty > b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A'
           AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQty THEN 6
      WHEN SUBSTRING(b.LocationName,4,1) = 'A'
           AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) <= b.AvailableQty THEN 7
      WHEN SUBSTRING(b.LocationName,4,1) <> 'A'
           AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) <= b.AvailableQty THEN 8
      ELSE 999
    END ASC,
    -- Secondary sort like your comment: prefer bigger available for seq 1-6; otherwise smaller
    CASE
      WHEN b.ReceivedQty = b.AvailableQty THEN b.AvailableQty
      ELSE (999999 - b.AvailableQty)
    END DESC;
END;
    `;

    await pool.request()
      .input("pOrderId", sql.Int, orderId)
      .batch(allocationBatch);

    // Return suggestions for this order
    const rows = await pool.request()
      .input("OrderId", sql.Int, orderId)
      .query(`
SELECT sa.OrderItemID, sa.ReceiveItemID, sa.SuggAllocQty,
       inv.LocationName, inv.AvailableQty AS AvailableAtTime
FROM dbo.SuggAlloc sa
LEFT JOIN dbo.Inventory inv ON sa.ReceiveItemID = inv.ReceiveItemID
WHERE sa.OrderId = @OrderId
ORDER BY sa.OrderItemID, sa.Id;
      `);

    res.json({ ok: true, orderId, suggestions: rows.recordset });
  } catch (e) {
    next(e);
  }
});

/**
 * Export the suggestions in Extensiv payload shape (for /orders/{id}/allocator).
 * GET /extensiv/allocations/payload?orderId=205417
 */
r.get("/allocations/payload", async (req, res, next) => {
  try {
    const orderId = Number(req.query.orderId);
    if (!orderId) return res.status(400).json({ ok: false, message: "Provide ?orderId=<number>" });

    const pool = await getPool();
    const rs = await pool.request()
      .input("OrderId", sql.Int, orderId)
      .query(`
SELECT OrderItemID, ReceiveItemID, SuggAllocQty
FROM dbo.SuggAlloc
WHERE OrderId = @OrderId
ORDER BY OrderItemID, Id;
      `);

    // Group by orderItemId into the payload expected by Extensiv
    const byItem = new Map();
    for (const r of rs.recordset) {
      if (!byItem.has(r.OrderItemID)) byItem.set(r.OrderItemID, []);
      byItem.get(r.OrderItemID).push({ receiveItemId: r.ReceiveItemID, qty: r.SuggAllocQty });
    }
    const proposedAllocations = Array.from(byItem.entries()).map(([orderItemId, allocations]) => ({
      orderItemId,
      proposedAllocations: allocations,
    }));

    res.json({ ok: true, orderId, proposedAllocations });
  } catch (e) {
    next(e);
  }
});

/* -------------------------------- EXPORT --------------------------------- */
export default r;
