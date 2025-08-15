// src/app/routes/orders.js (ESM)
import { Router } from "express";
import { getPool, sql } from "../services/db/mssql.js";

const r = Router();

/**
 * Flat rows for the UI fallback:
 * GET /api/unallocated-orders
 * Returns: [{ OrderItemID, OrderID, CustomerName, SKU, OrderedQTY, Qualifier }]
 *
 * "Unallocated" here = ordered qty minus any SuggAlloc already recorded > 0.
 * If you don't have SuggAlloc yet, the COALESCE will treat it as 0.
 */
r.get("/api/unallocated-orders", async (_req, res, next) => {
  try {
    const pool = await getPool();
    const q = await pool.request().query(`
      WITH alloc AS (
        SELECT OrderItemID, SUM(COALESCE(SuggAllocQty,0)) AS SumSuggAllocQty
        FROM dbo.SuggAlloc WITH (NOLOCK)
        GROUP BY OrderItemID
      )
      SELECT
        od.OrderItemID,
        od.OrderID,
        od.CustomerName,
        /* ItemID column exists in your table but your UI shows SKU, so return SKU.
           If ItemID holds the SKU in your DB, use od.ItemID AS SKU instead. */
        od.SKU,
        od.OrderedQTY,
        od.Qualifier
      FROM dbo.OrderDetails od WITH (NOLOCK)
      LEFT JOIN alloc a ON a.OrderItemID = od.OrderItemID
      WHERE od.OrderedQTY > COALESCE(a.SumSuggAllocQty, 0)
      ORDER BY od.OrderID, od.OrderItemID
    `);
    res.json(q.recordset || []);
  } catch (e) {
    next(e);
  }
});

/**
 * Nested structure for the UI primary path:
 * GET /extensiv/orders-with-lines
 * Returns: [{ orderId, customerName, lines:[{orderItemId, sku, qty, qualifier}]}]
 */
r.get("/extensiv/orders-with-lines", async (_req, res, next) => {
  try {
    const pool = await getPool();
    const q = await pool.request().query(`
      WITH alloc AS (
        SELECT OrderItemID, SUM(COALESCE(SuggAllocQty,0)) AS SumSuggAllocQty
        FROM dbo.SuggAlloc WITH (NOLOCK)
        GROUP BY OrderItemID
      )
      SELECT
        od.OrderItemID,
        od.OrderID,
        od.CustomerName,
        od.SKU,              -- if your SKU is actually in ItemID, swap to od.ItemID
        od.OrderedQTY,
        od.Qualifier
      FROM dbo.OrderDetails od WITH (NOLOCK)
      LEFT JOIN alloc a ON a.OrderItemID = od.OrderItemID
      WHERE od.OrderedQTY > COALESCE(a.SumSuggAllocQty, 0)
      ORDER BY od.OrderID, od.OrderItemID
    `);

    // group into nested shape
    const byOrder = new Map();
    for (const r of q.recordset || []) {
      if (!byOrder.has(r.OrderID)) {
        byOrder.set(r.OrderID, {
          orderId: r.OrderID,
          customerName: r.CustomerName || "",
          lines: [],
        });
      }
      byOrder.get(r.OrderID).lines.push({
        orderItemId: r.OrderItemID,
        sku: r.SKU,                 // or r.ItemID if that's your real SKU column
        qty: r.OrderedQTY,
        qualifier: r.Qualifier || "",
      });
    }
    res.json(Array.from(byOrder.values()));
  } catch (e) {
    next(e);
  }
});

export default r;
