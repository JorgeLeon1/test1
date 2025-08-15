// src/app/routes/alloc.js (ESM)
import { Router } from "express";
import axios from "axios";
import { getPool, sql } from "../services/db/mssql.js";
import * as ext from "../services/extensivClient.js";

const r = Router();

/**
 * GET /alloc/by-order/:orderId
 * Returns per-line allocation status + raw SuggAlloc rows for a single order.
 */
r.get("/by-order/:orderId", async (req, res, next) => {
  const orderId = Number(req.params.orderId || 0);
  if (!orderId) return res.status(400).json({ ok: false, message: "orderId required" });

  try {
    const pool = await getPool();

    // Ordered vs Allocated vs Remaining for each line on this OrderID
    const linesQ = await pool.request()
      .input("OrderId", sql.Int, orderId)
      .query(`
        WITH line_alloc AS (
          SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS AllocQty
          FROM dbo.SuggAlloc WITH (NOLOCK)
          GROUP BY OrderItemID
        )
        SELECT
          od.OrderItemID,
          od.OrderID,
          od.CustomerName,
          od.SKU,              -- if your SKU is actually in ItemID, change to od.ItemID
          od.Qualifier,
          od.OrderedQTY,
          ISNULL(la.AllocQty, 0) AS AllocatedQTY,
          od.OrderedQTY - ISNULL(la.AllocQty, 0) AS RemainingQTY
        FROM dbo.OrderDetails od WITH (NOLOCK)
        LEFT JOIN line_alloc la ON la.OrderItemID = od.OrderItemID
        WHERE od.OrderID = @OrderId
        ORDER BY od.OrderItemID;
      `);

    // Raw suggestion rows for this order
    const suggQ = await pool.request()
      .input("OrderId", sql.Int, orderId)
      .query(`
        SELECT s.OrderItemID, s.ReceiveItemID, s.SuggAllocQty
        FROM dbo.SuggAlloc s WITH (NOLOCK)
        INNER JOIN dbo.OrderDetails od WITH (NOLOCK)
                ON od.OrderItemID = s.OrderItemID
        WHERE od.OrderID = @OrderId
        ORDER BY s.OrderItemID, s.ReceiveItemID;
      `);

    res.json({
      ok: true,
      orderId,
      lines: linesQ.recordset || [],
      allocations: suggQ.recordset || []
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /alloc/push
 * Body: { orderId: number }
 * Reads SuggAlloc for that order and pushes to Extensiv allocator endpoint.
 */
r.post("/push", async (req, res, next) => {
  const orderId = Number(req.body?.orderId || 0);
  if (!orderId) return res.status(400).json({ ok: false, message: "orderId required in body" });

  try {
    const pool = await getPool();

    // Collect allocations for the given OrderID
    const q = await pool.request()
      .input("OrderId", sql.Int, orderId)
      .query(`
        SELECT od.OrderID, s.OrderItemID, s.ReceiveItemID, s.SuggAllocQty
        FROM dbo.SuggAlloc s WITH (NOLOCK)
        INNER JOIN dbo.OrderDetails od WITH (NOLOCK)
                ON od.OrderItemID = s.OrderItemID
        WHERE od.OrderID = @OrderId
        ORDER BY s.OrderItemID, s.ReceiveItemID;
      `);

    const rows = q.recordset || [];
    if (!rows.length) {
      return res.json({ ok: false, message: "No SuggAlloc rows for this order." });
    }

    // Shape payload per Extensiv allocator expectations.
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.OrderItemID)) map.set(r.OrderItemID, []);
      map.get(r.OrderItemID).push({
        receiveItemId: r.ReceiveItemID, // adjust key name if your tenant expects something else
        qty: Number(r.SuggAllocQty) || 0
      });
    }
    const orderItems = Array.from(map.entries()).map(([orderItemId, allocations]) => ({
      orderItemId,
      allocations
    }));

    const headers = await ext.authHeaders();
    const base = (process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com").replace(/\/+$/, "");

    // PUT /orders/{orderId}/allocator
    const payload = { orderItems };
    const resp = await axios.put(`${base}/orders/${orderId}/allocator`, payload, {
      headers,
      timeout: 30000,
      validateStatus: () => true
    });

    if (resp.status >= 200 && resp.status < 300) {
      return res.json({
        ok: true,
        status: resp.status,
        pushedItems: orderItems.length,
        response: resp.data
      });
    }
    return res.status(502).json({ ok: false, status: resp.status, data: resp.data });
  } catch (e) {
    next(e);
  }
});

export default r;
