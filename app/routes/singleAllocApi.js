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
  const base = trimBase(
    process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com"
  );
  const headers = await authHeaders();

  // Get one order with all details and item details
  const { data } = await axios.get(`${base}/orders/${orderId}`, {
    headers,
    params: { detail: "All", itemdetail: "All" },
    timeout: 30000,
  });
  return data; // raw order payload
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

  const defs = [
    ["OrderID", "OrderID", sql.Int, toInt(rec.OrderID, 0)],
    ["CustomerID", "CustomerID", sql.Int, toInt(rec.CustomerID, 0)],
    ["CustomerName", "CustomerName", sql.VarChar(200), s(rec.CustomerName, 200)],
    ["SKU", "SKU", sql.VarChar(150), s(rec.SKU, 150)],
    // mirror SKU into ItemID if that column exists
    ["ItemID", "ItemID", sql.VarChar(150), s(rec.SKU, 150)],
    ["Qualifier", "Qualifier", sql.VarChar(80), s(rec.Qualifier, 80)],
    ["OrderedQTY", "OrderedQTY", sql.Int, toInt(rec.OrderedQTY, 0)],
    ["UnitID", "UnitID", sql.Int, toInt(rec.UnitID, 0)],
    ["UnitName", "UnitName", sql.VarChar(80), s(rec.UnitName, 80)],
    ["ReferenceNum", "ReferenceNum", sql.VarChar(120), s(rec.ReferenceNum, 120)],
  ];
  const active = defs.filter(([c]) => cols.has(c));
  active.forEach(([c, p, type, val]) => req.input(p, type, val));

  const setClause = active.map(([c, p]) => `${c}=@${p}`).join(", ");
  const insertCols = ["OrderItemID", ...active.map(([c]) => c)].join(", ");
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

// sanity check
r.get("/ping", (_req, res) => res.json({ ok: true, where: "single-alloc" }));

/**
 * GET /api/single-alloc/order/:id
 * - fetch one order from Extensiv with detail=All&itemdetail=All
 * - upsert lines into dbo.OrderDetails
 * - return { order, lines, inventory }
 */
r.get("/order/:id", async (req, res) => {
  try {
    const orderId = toInt(req.params.id, 0);
    if (!orderId) return res.status(400).json({ ok: false, message: "Invalid orderId" });

    const raw = await fetchSingleOrderFromExtensiv(orderId);

    const ro = raw?.readOnly || raw?.ReadOnly || {};
    const orderHeader = {
      orderId: toInt(ro.orderId ?? ro.OrderId ?? raw.orderId ?? raw.OrderId, orderId),
      customerId: toInt(raw?.customerIdentifier?.id, 0),
      customerName: s(raw?.customerIdentifier?.name, 200),
      referenceNum: s(raw?.referenceNum, 120),
    };

    const pool = await getPool();
    const cols = await getExistingCols(pool);

    const linesRaw = linesFromOrderPayload(raw);
    const normLines = [];

    for (const it of linesRaw) {
      const iro = it?.readOnly || it?.ReadOnly || {};
      const sku =
        it?.itemIdentifier?.sku ??
        it?.ItemIdentifier?.Sku ??
        it?.sku ??
        it?.SKU ??
        "";
      const line = {
        OrderItemID: toInt(iro.orderItemId ?? iro.OrderItemId ?? it.orderItemId ?? it.OrderItemId, 0),
        OrderID: orderHeader.orderId,
        CustomerID: orderHeader.customerId,
        CustomerName: orderHeader.customerName,
        SKU: s(sku, 150),
        Qualifier: s(it?.qualifier ?? it?.Qualifier ?? "", 80),
        OrderedQTY: toInt(it?.qty ?? it?.orderedQty ?? it?.Qty ?? 0, 0),
        // unitIdentifier is usually on the readOnly block of the LINE
        UnitID: toInt(iro?.unitIdentifier?.id ?? it?.unitIdentifier?.id, 0),
        UnitName: s(iro?.unitIdentifier?.name ?? it?.unitIdentifier?.name ?? "", 80),
        ReferenceNum: orderHeader.referenceNum,
      };
      if (!line.OrderItemID) continue;
      await upsertOrderDetail(pool, cols, line);
      normLines.push(line);
    }

    // Inventory snapshot (for UI): by ItemID (=SKU) + Qualifier for these lines
    let invRows = [];
    if (normLines.length) {
      const tvp = new sql.Table();
      tvp.columns.add("ItemID", sql.VarChar(150));
      tvp.columns.add("Qualifier", sql.VarChar(80));
      const keySet = new Set();
      normLines.forEach((ln) => {
        const k = `${ln.SKU}||${ln.Qualifier}`;
        if (!keySet.has(k)) {
          keySet.add(k);
          tvp.rows.add(ln.SKU, ln.Qualifier || "");
        }
      });
      const reqInv = pool.request();
      reqInv.input("Pairs", tvp);
      invRows = (
        await reqInv.query(`
          SELECT i.*
          FROM dbo.Inventory i
          JOIN @Pairs p
            ON i.ItemID = p.ItemID AND ISNULL(i.Qualifier,'') = ISNULL(p.Qualifier,'')
          ORDER BY i.ItemID, i.LocationName
        `)
      ).recordset;
    }

    res.json({ ok: true, order: orderHeader, lines: normLines, inventory: invRows });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message, data: e.response?.data });
  }
});

/**
 * POST /api/single-alloc/allocate
 * body: { orderId: number, lineIds: number[] }
 * - Clears SuggAlloc for those lineIds
 * - Runs looped/CTE allocation (fixed version)
 */
r.post("/allocate", async (req, res) => {
  try {
    const { orderId, lineIds } = req.body || {};
    const oid = toInt(orderId, 0);
    if (!oid) return res.status(400).json({ ok: false, message: "orderId required" });
    if (!Array.isArray(lineIds) || !lineIds.length)
      return res.status(400).json({ ok: false, message: "lineIds required" });

    const ids = lineIds.map((n) => toInt(n, 0)).filter(Boolean);
    if (!ids.length) return res.status(400).json({ ok: false, message: "No valid lineIds" });

    const pool = await getPool();

    // Temp table for ids (parameterized & safe)
    const tvp = new sql.Table();
    tvp.columns.add("OrderItemID", sql.Int);
    ids.forEach((id) => tvp.rows.add(id));

    const req = pool.request();
    req.input("Ids", tvp);

    await req.batch(`
      -- Clear existing suggestions for these lines (optional but typical)
      DELETE s
      FROM dbo.SuggAlloc s
      JOIN @Ids i ON s.OrderItemID = i.OrderItemID;

      DECLARE @RemainingOpenQty INT = 1;

      WHILE @RemainingOpenQty > 0
      BEGIN
        ;WITH base AS (
          SELECT
            od.OrderItemID,
            od.OrderedQTY,
            inv.ReceiveItemID,
            inv.AvailableQTY,
            inv.ReceivedQty,
            inv.LocationName,
            ISNULL(sa.SumQty, 0)                           AS SumSuggAllocQty,
            od.OrderedQTY - ISNULL(sa.SumQty, 0)           AS RemainingOpenQty,
            CASE
              WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1) = 'A'  AND (od.OrderedQTY-ISNULL(sa.SumQty,0)) = inv.AvailableQTY THEN 1
              WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1) <> 'A' AND (od.OrderedQTY-ISNULL(sa.SumQty,0)) = inv.AvailableQTY THEN 2
              WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1) <> 'A' AND (od.OrderedQTY-ISNULL(sa.SumQty,0)) > inv.AvailableQTY THEN 3
              WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1) = 'A'  AND (od.OrderedQTY-ISNULL(sa.SumQty,0)) > inv.AvailableQTY THEN 4
              WHEN inv.ReceivedQty >  inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1) = 'A'  AND (od.OrderedQTY-ISNULL(sa.SumQty,0)) >= inv.AvailableQTY THEN 5
              WHEN inv.ReceivedQty >  inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1) <> 'A' AND (od.OrderedQTY-ISNULL(sa.SumQty,0)) >= inv.AvailableQTY THEN 6
              WHEN SUBSTRING(inv.LocationName,4,1) = 'A'  AND (od.OrderedQTY-ISNULL(sa.SumQty,0)) <= inv.AvailableQTY THEN 7
              WHEN SUBSTRING(inv.LocationName,4,1) <> 'A' AND (od.OrderedQTY-ISNULL(sa.SumQty,0)) <= inv.AvailableQTY THEN 8
            END AS Seq
          FROM dbo.OrderDetails od
          JOIN @Ids i ON od.OrderItemID = i.OrderItemID
          INNER JOIN dbo.Inventory inv
            ON od.ItemID = inv.ItemID AND ISNULL(od.Qualifier,'') = ISNULL(inv.Qualifier,'')
          LEFT JOIN (
            SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumQty
            FROM dbo.SuggAlloc
            GROUP BY OrderItemID
          ) sa ON sa.OrderItemID = od.OrderItemID
          WHERE inv.ReceiveItemID NOT IN (SELECT DISTINCT ReceiveItemID FROM dbo.SuggAlloc)
            AND inv.AvailableQTY > 0
        )
        INSERT INTO dbo.SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
        SELECT TOP 1
          b.OrderItemID,
          b.ReceiveItemID,
          CASE WHEN b.RemainingOpenQty >= b.AvailableQTY THEN b.AvailableQTY ELSE b.RemainingOpenQty END
        FROM base b
        WHERE b.RemainingOpenQty > 0
        ORDER BY
          b.OrderItemID,
          b.Seq ASC,
          CASE WHEN b.Seq IN (1,2,3,4,5,6) THEN b.AvailableQTY
               ELSE 999999 - b.AvailableQTY
          END DESC;

        -- recompute remaining across selected lines
        SELECT @RemainingOpenQty = MAX(remaining)
        FROM (
          SELECT
            od.OrderItemID,
            od.OrderedQTY - ISNULL(sa.SumQty,0) AS remaining
          FROM dbo.OrderDetails od
          JOIN @Ids i ON od.OrderItemID = i.OrderItemID
          LEFT JOIN (
            SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumQty
            FROM dbo.SuggAlloc
            GROUP BY OrderItemID
          ) sa ON sa.OrderItemID = od.OrderItemID
        ) r;

        IF @RemainingOpenQty IS NULL SET @RemainingOpenQty = 0;
      END
    `);

    res.json({ ok: true, orderId: oid, linesAffected: ids.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * POST /api/single-alloc/push
 * body: { orderId }
 * - Reads SuggAlloc for the order's lines
 * - Sends to Extensiv /orders/{id}/allocator
 */
r.post("/push", async (req, res) => {
  try {
    const { orderId } = req.body || {};
    const oid = toInt(orderId, 0);
    if (!oid) return res.status(400).json({ ok: false, message: "orderId required" });

    const pool = await getPool();
    const rs = await pool.request().input("orderId", sql.Int, oid).query(`
      SELECT sa.OrderItemID, sa.ReceiveItemID, sa.SuggAllocQty
      FROM dbo.SuggAlloc sa
      WHERE sa.OrderItemID IN (SELECT OrderItemID FROM dbo.OrderDetails WHERE OrderID = @orderId)
        AND ISNULL(sa.SuggAllocQty,0) > 0
      ORDER BY sa.OrderItemID, sa.ReceiveItemID
    `);

    const allocations = rs.recordset.map((a) => ({
      orderItemId: a.OrderItemID,
      receiveItemId: a.ReceiveItemID,
      qty: a.SuggAllocQty,
    }));

    const base = trimBase(
      process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com"
    );
    const headers = await authHeaders();

    const resp = await axios.put(
      `${base}/orders/${oid}/allocator`,
      { allocations },
      { headers, timeout: 30000 }
    );

    res.json({ ok: true, status: resp.status, sent: allocations.length });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, message: e.message, data: e.response?.data || null });
  }
});

export default r;
