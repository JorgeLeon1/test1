// src/app/routes/singleAllocApi.js
import { Router } from "express";
import axios from "axios";
import { getPool, sql } from "../services/db/mssql.js";
import { authHeaders } from "../services/extensivClient.js";

const r = Router();

/* ----------------------- helpers ----------------------- */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const toInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const s = (v, max = 255) => (v == null ? "" : String(v).normalize("NFC").slice(0, max));

async function fetchSingleOrderFromExtensiv(orderId) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  const { data, status } = await axios.get(`${base}/orders/${orderId}`, {
    headers,
    params: { detail: "All", itemdetail: "All" },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (status >= 200 && status < 300) return data;
  const msg = (data && (data.message || data.error)) || `Extensiv returned ${status}`;
  const err = new Error(msg);
  err.status = status;
  err.data = data;
  throw err;
}

function linesFromOrderPayload(ord) {
  const emb = ord?._embedded;
  if (emb?.["http://api.3plCentral.com/rels/orders/item"]) {
    return emb["http://api.3plCentral.com/rels/orders/item"];
  }
  if (Array.isArray(ord?.OrderItems)) return ord.OrderItems;
  if (Array.isArray(ord?.Items)) return ord.Items;
  return [];
}

/* ------- upsert into dbo.OrderDetails (only existing columns) ------- */
async function getExistingCols(pool) {
  const q = await pool
    .request()
    .query("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OrderDetails')");
  return new Set(q.recordset.map((r) => r.name));
}

async function upsertOrderDetail(pool, cols, rec) {
  if (!rec.OrderItemID) return;

  const req = pool.request();
  req.input("OrderItemID", sql.Int, rec.OrderItemID);

  // Only bind what exists in your table
 const defs = [
  ["OrderID", "OrderID", sql.Int, toInt(rec.OrderID, 0)],
  ["CustomerID", "CustomerID", sql.Int, toInt(rec.CustomerID, 0)],
  ["CustomerName", "CustomerName", sql.VarChar(200), s(rec.CustomerName, 200)],
  ["SKU", "SKU", sql.VarChar(150), s(rec.SKU, 150)],
  ["ItemID", "ItemID", sql.VarChar(150), s(rec.ItemID, 150)],   // <-- now real item id
  ["Qualifier", "Qualifier", sql.VarChar(80), s(rec.Qualifier, 80)],
  ["OrderedQTY", "OrderedQTY", sql.Int, toInt(rec.OrderedQTY, 0)],
  ["UnitID", "UnitID", sql.Int, toInt(rec.UnitID, 0)],
  ["UnitName", "UnitName", sql.VarChar(80), s(rec.UnitName, 80)],
  ["ReferenceNum", "ReferenceNum", sql.VarChar(120), s(rec.ReferenceNum, 120)],
];


  const active = defs.filter(([col]) => cols.has(col));
  active.forEach(([col, param, type, val]) => req.input(param, type, val));

  const setClause = active.map(([col, param]) => `${col}=@${param}`).join(", ");
  const insertCols = ["OrderItemID", ...active.map(([col]) => col)].join(", ");
  const insertVals = ["@OrderItemID", ...active.map(([, p]) => `@${p}`)].join(", ");

  const sqlText = `
IF EXISTS (SELECT 1 FROM dbo.OrderDetails WITH (UPDLOCK, HOLDLOCK) WHERE OrderItemID=@OrderItemID)
  UPDATE dbo.OrderDetails SET ${setClause} WHERE OrderItemID=@OrderItemID;
ELSE
  INSERT INTO dbo.OrderDetails (${insertCols}) VALUES (${insertVals});
`;
  await req.query(sqlText);
}

/* -------------------------- Routes -------------------------- */

// sanity
r.get("/ping", (_req, res) => res.json({ ok: true, where: "single-alloc" }));

/**
 * GET /api/single-alloc/order/:id
 * - pulls one order (detail=All&itemdetail=All), upserts lines into dbo.OrderDetails, returns header+lines
 */
r.get("/order/:id", async (req, res) => {
  try {
    const orderId = toInt(req.params.id, 0);
    if (!orderId) return res.status(400).json({ ok: false, message: "Invalid orderId" });

    const raw = await fetchSingleOrderFromExtensiv(orderId);

    const ro = raw?.readOnly || raw?.ReadOnly || {};
    const orderHeader = {
      orderId: toInt(ro.orderId ?? ro.OrderId ?? raw.orderId ?? raw.OrderId ?? orderId, orderId),
      customerId: toInt(raw?.customerIdentifier?.id, 0),
      customerName: s(raw?.customerIdentifier?.name, 200),
      referenceNum: s(raw?.referenceNum, 120),
    };

    const pool = await getPool();
    const cols = await getExistingCols(pool);

    const linesRaw = linesFromOrderPayload(raw);
    const lines = [];

    for (const it of linesRaw) {
      const iro = it?.readOnly || it?.ReadOnly || {};
      // AFTER – grab a real itemId and a robust SKU
const rawItemId = toInt(
  it?.itemIdentifier?.id ??
  it?.ItemIdentifier?.Id ??
  it?.itemIdentifierId ??
  it?.ItemId, 0);

const sku = s(
  it?.itemIdentifier?.sku ??
  it?.ItemIdentifier?.Sku ??
  it?.sku ??
  it?.SKU ??
  it?.itemIdentifier?.nameKey?.name ??   // last-ditch fallbacks
  it?.itemIdentifier?.name ??
  "", 150
);

const line = {
  OrderItemID: toInt(iro.orderItemId ?? iro.OrderItemId ?? it.orderItemId ?? it.OrderItemId, 0),
  OrderID: orderHeader.orderId,
  CustomerID: orderHeader.customerId,
  CustomerName: orderHeader.customerName,
  ItemID: rawItemId ? String(rawItemId) : "",    // store true item id (string ok)
  SKU: sku,
  Qualifier: s(it?.qualifier ?? it?.Qualifier ?? "", 80),
  OrderedQTY: toInt(it?.qty ?? it?.orderedQty ?? it?.Qty ?? it?.OrderedQty ?? 0, 0),
  UnitID: toInt(iro?.unitIdentifier?.id ?? iro?.UnitIdentifier?.Id, 0),
  UnitName: s(iro?.unitIdentifier?.name ?? iro?.UnitIdentifier?.Name ?? "", 80),
  ReferenceNum: orderHeader.referenceNum,
};

      if (!line.OrderItemID) continue;
      await upsertOrderDetail(pool, cols, line);
      lines.push(line);
    }

    res.json({ ok: true, order: orderHeader, lines });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, message: e.message, data: e.data });
  }
});

/**
 * GET /api/single-alloc/lines/:orderId
 * - convenience: read the lines you stored for this order
 */
r.get("/lines/:orderId", async (req, res) => {
  try {
    const orderId = toInt(req.params.orderId, 0);
    if (!orderId) return res.status(400).json({ ok: false, message: "Invalid orderId" });

    const pool = await getPool();
    const q = await pool
      .request()
      .input("OrderID", sql.Int, orderId)
      .query(`
        SELECT OrderItemID, OrderID, CustomerID, CustomerName, ItemID, SKU, Qualifier,
               OrderedQTY, UnitID, UnitName, ReferenceNum
        FROM dbo.OrderDetails
        WHERE OrderID=@OrderID
        ORDER BY OrderItemID
      `);

    res.json({ ok: true, orderId, lines: q.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * POST /api/single-alloc/allocate
 * body: { orderId: number, lineIds: number[] }
 */
r.post("/allocate", async (req, res) => {
  try {
    const { orderId, lineIds } = req.body || {};
    const oid = Number.parseInt(orderId, 10) || 0;
    if (!oid) return res.status(400).json({ ok: false, message: "orderId required" });
    if (!Array.isArray(lineIds) || !lineIds.length) {
      return res.status(400).json({ ok: false, message: "lineIds required" });
    }

    const ids = lineIds.map((n) => Number.parseInt(n, 10)).filter(Boolean);
    if (!ids.length) return res.status(400).json({ ok: false, message: "no valid lineIds" });

    const pool = await getPool();

    // Clear old suggestions for these specific lines
    await pool.request().query(`
      DELETE SuggAlloc WHERE OrderItemID IN (${ids.join(",")});
    `);

    // Safe terminating allocation loop using CTEs (no "c.SumSuggAllocQty" binding issues)
    await pool.request().batch(`
DECLARE @iters INT = 0;
DECLARE @maxIters INT = 10000; -- safety cap

WHILE (1=1)
BEGIN
  ;WITH x AS (
    SELECT
      od.OrderItemID,
      od.OrderedQTY,
      ISNULL(sa.SumSuggAllocQty,0) AS SumSuggAllocQty,
      (od.OrderedQTY - ISNULL(sa.SumSuggAllocQty,0)) AS RemainingOpenQty
    FROM OrderDetails od
    LEFT JOIN (
      SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
      FROM SuggAlloc
      GROUP BY OrderItemID
    ) sa ON sa.OrderItemID = od.OrderItemID
    WHERE od.OrderItemID IN (${ids.join(",")})
  ),
  cand AS (
    SELECT
      x.OrderItemID,
      x.OrderedQTY,
      x.SumSuggAllocQty,
      x.RemainingOpenQty,
      inv.ReceiveItemID,
      inv.AvailableQTY,
      inv.ReceivedQty,
      inv.LocationName,
      CASE
        WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)='A'  AND x.RemainingOpenQty = inv.AvailableQTY THEN 1
        WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)<>'A' AND x.RemainingOpenQty = inv.AvailableQTY THEN 2
        WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)<>'A' AND x.RemainingOpenQty >  inv.AvailableQTY THEN 3
        WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)='A'  AND x.RemainingOpenQty >  inv.AvailableQTY THEN 4
        WHEN inv.ReceivedQty >  inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)='A'  AND x.RemainingOpenQty >= inv.AvailableQTY THEN 5
        WHEN inv.ReceivedQty >  inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)<>'A' AND x.RemainingOpenQty >= inv.AvailableQTY THEN 6
        WHEN SUBSTRING(inv.LocationName,4,1)='A'  AND x.RemainingOpenQty <= inv.AvailableQTY THEN 7
        WHEN SUBSTRING(inv.LocationName,4,1)<>'A' AND x.RemainingOpenQty <= inv.AvailableQTY THEN 8
      END AS Seq
    FROM x
    JOIN OrderDetails od ON od.OrderItemID = x.OrderItemID
    JOIN Inventory inv
      ON inv.ItemID = od.ItemID
     AND inv.Qualifier = od.Qualifier
    WHERE
      x.RemainingOpenQty > 0
      AND inv.AvailableQTY > 0
      AND inv.ReceiveItemID NOT IN (SELECT DISTINCT ReceiveItemID FROM SuggAlloc)
  ),
  pick AS (
    SELECT TOP (1)
      c.OrderItemID,
      c.ReceiveItemID,
      CASE
        WHEN c.RemainingOpenQty >= c.AvailableQTY THEN c.AvailableQTY
        ELSE c.RemainingOpenQty
      END AS AllocQty,
      c.Seq,
      c.AvailableQTY
    FROM cand c
    ORDER BY c.OrderItemID, c.Seq ASC,
      CASE WHEN c.Seq IN (1,2,3,4,5,6) THEN c.AvailableQTY+0
           WHEN c.Seq IN (7,9)        THEN 999999-c.AvailableQTY
      END DESC
  )
  INSERT INTO SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
  SELECT OrderItemID, ReceiveItemID, AllocQty
  FROM pick;

  IF @@ROWCOUNT = 0 BREAK;
  SET @iters += 1;
  IF @iters >= @maxIters BREAK;

  IF NOT EXISTS (
    SELECT 1
    FROM OrderDetails od
    OUTER APPLY (
      SELECT SUM(ISNULL(sa.SuggAllocQty,0)) AS SumSuggAllocQty
      FROM SuggAlloc sa
      WHERE sa.OrderItemID = od.OrderItemID
    ) z
    WHERE od.OrderItemID IN (${ids.join(",")})
      AND (od.OrderedQTY - ISNULL(z.SumSuggAllocQty,0)) > 0
  )
    BREAK;
END;
    `);

    const summary = await pool.request().query(`
      SELECT od.OrderItemID, od.SKU, od.OrderedQTY,
             ISNULL(x.Alloc,0) AS Allocated,
             (od.OrderedQTY - ISNULL(x.Alloc,0)) AS Remaining
      FROM OrderDetails od
      LEFT JOIN (
        SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS Alloc
        FROM SuggAlloc GROUP BY OrderItemID
      ) x ON x.OrderItemID = od.OrderItemID
      WHERE od.OrderItemID IN (${ids.join(",")})
      ORDER BY od.OrderItemID;
    `);

    res.json({ ok: true, orderId: oid, summary: summary.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * GET /api/single-alloc/sugg/:orderId
 * - read current SuggAlloc for this order (for UI preview)
 */
r.get("/sugg/:orderId", async (req, res) => {
  try {
    const orderId = toInt(req.params.orderId, 0);
    if (!orderId) return res.status(400).json({ ok: false, message: "Invalid orderId" });

    const pool = await getPool();
    const q = await pool.request().input("OrderID", sql.Int, orderId).query(`
      SELECT sa.OrderItemID, sa.ReceiveItemID, sa.SuggAllocQty
      FROM SuggAlloc sa
      WHERE sa.OrderItemID IN (SELECT OrderItemID FROM OrderDetails WHERE OrderID=@OrderID)
      ORDER BY sa.OrderItemID, sa.ReceiveItemID
    `);

    res.json({ ok: true, orderId, allocations: q.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * POST /api/single-alloc/push
 * body: { orderId: number }
 */
r.post("/push", async (req, res) => {
  try {
    const oid = toInt(req.body?.orderId, 0);
    if (!oid) return res.status(400).json({ ok: false, message: "orderId required" });

    const pool = await getPool();
    const allocs = await pool.request().input("OrderID", sql.Int, oid).query(`
      SELECT OrderItemID, ReceiveItemID, SuggAllocQty
      FROM SuggAlloc
      WHERE OrderItemID IN (SELECT OrderItemID FROM OrderDetails WHERE OrderID=@OrderID)
        AND ISNULL(SuggAllocQty,0) > 0
    `);

    const payload = {
      allocations: allocs.recordset.map((a) => ({
        orderItemId: a.OrderItemID,
        receiveItemId: a.ReceiveItemID,
        qty: a.SuggAllocQty,
      })),
    };

    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
    const headers = await authHeaders();
    const resp = await axios.put(`${base}/orders/${oid}/allocator`, payload, {
      headers,
      timeout: 30000,
      validateStatus: () => true,
    });

    if (resp.status >= 200 && resp.status < 300) {
      return res.json({ ok: true, status: resp.status, sent: payload.allocations.length });
    }
    res.status(resp.status || 500).json({ ok: false, status: resp.status, data: resp.data });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message, data: e.response?.data });
  }
});

export default r;
