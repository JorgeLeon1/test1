// src/app/routes/singleAllocApi.js
import { Router } from "express";
import axios from "axios";
import { getPool, sql } from "../services/db/mssql.js";
import { authHeaders, fetchSingleOrder, _helpers } from "../services/extensivClient.js";

const r = Router();
const { ro } = _helpers;

// normalize items from order payload
function extractItems(order) {
  const em = order?._embedded?.["http://api.3plCentral.com/rels/orders/item"];
  if (Array.isArray(em)) return em;
  if (Array.isArray(order?.OrderItems)) return order.OrderItems;
  if (Array.isArray(order?.Items)) return order.Items;
  return [];
}

// upsert OrderDetails (only columns that exist)
async function upsertOrderDetails(pool, rows) {
  if (!rows?.length) return 0;

  const colRes = await pool.request()
    .query("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OrderDetails')");
  const columns = new Set(colRes.recordset.map(r => r.name));

  const defs = [
    ["OrderId",        sql.Int,        r => r.OrderId],
    ["OrderItemID",    sql.Int,        r => r.OrderItemID],
    ["CustomerID",     sql.Int,        r => r.CustomerID],
    ["CustomerName",   sql.VarChar(200),r => r.CustomerName],
    ["ItemID",         sql.VarChar(150),r => r.ItemID],
    ["SKU",            sql.VarChar(150),r => r.SKU],
    ["Qualifier",      sql.VarChar(80), r => r.Qualifier],
    ["OrderedQTY",     sql.Int,         r => r.OrderedQTY],
    ["UnitID",         sql.Int,         r => r.UnitID],
    ["UnitName",       sql.VarChar(80), r => r.UnitName],
    ["ReferenceNum",   sql.VarChar(120),r => r.ReferenceNum],
    ["ShipToAddress1", sql.VarChar(255),r => r.ShipToAddress1],
  ].filter(([name]) => columns.has(name));

  let n = 0;
  for (const rec of rows) {
    const req = pool.request();
    for (const [name, type, getter] of defs) {
      req.input(name, type, getter(rec));
    }
    const setClause  = defs.map(([n]) => `${n}=@${n}`).join(", ");
    const colList    = defs.map(([n]) => n).join(", ");
    const valList    = defs.map(([n]) => `@${n}`).join(", ");
    await req.query(`
IF EXISTS (SELECT 1 FROM dbo.OrderDetails WITH (UPDLOCK, HOLDLOCK) WHERE OrderItemID=@OrderItemID)
  UPDATE dbo.OrderDetails SET ${setClause} WHERE OrderItemID=@OrderItemID;
ELSE
  INSERT INTO dbo.OrderDetails (${colList}) VALUES (${valList});
    `);
    n++;
  }
  return n;
}

// inventory for (ItemID/SKU, Qualifier) from dbo.Inventory
async function inventoryForOrder(pool, rows) {
  if (!rows?.length) return [];
  const pairs = Array.from(
    new Set(rows.map(r => `${r.ItemID}|||${r.Qualifier || ""}`))
  ).map(k => {
    const [ItemID, Qualifier] = k.split("|||");
    return { ItemID, Qualifier };
  });

  const req = pool.request();
  req.input("PairsJson", sql.NVarChar(sql.MAX), JSON.stringify(pairs));
  const q = await req.query(`
DECLARE @pairs TABLE (ItemID VARCHAR(150), Qualifier VARCHAR(80));
INSERT INTO @pairs (ItemID, Qualifier)
SELECT j.ItemID, j.Qualifier
FROM OPENJSON(@PairsJson) WITH (ItemID VARCHAR(150) '$.ItemID', Qualifier VARCHAR(80) '$.Qualifier') j;

SELECT i.ItemID, i.Qualifier, i.ReceiveItemID, i.AvailableQTY, i.ReceivedQty, i.LocationName
FROM dbo.Inventory i
JOIN @pairs p ON ISNULL(p.ItemID,'')=ISNULL(i.ItemID,'') AND ISNULL(p.Qualifier,'')=ISNULL(i.Qualifier,'')
WHERE i.AvailableQTY > 0
ORDER BY i.ItemID, i.Qualifier, i.LocationName;
  `);
  return q.recordset;
}

/* ======================= API ENDPOINTS ======================= */

/**
 * GET /api/single-alloc/order/:id
 * Fetch ONE order (with ALL item details), upsert to dbo.OrderDetails,
 * return normalized order header + lines + matching inventory.
 */
r.get("/order/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok:false, message:"Invalid order id" });

    // 1) fetch from Extensiv
    const order = await fetchSingleOrder(id);

    // 2) flatten lines
    const orderRO = ro(order);
    const orderId =
      orderRO.orderId ?? orderRO.OrderId ?? order.orderId ?? order.OrderId ?? id;
    const cust = orderRO.customerIdentifier || order.customerIdentifier || {};
    const ref  = order.referenceNum || "";
    const addr = order?.shipTo?.address1 || "";

    const items = extractItems(order);
    const rows = [];
    for (const it of items) {
      const IR = ro(it);
      const orderItemId = IR.orderItemId ?? IR.OrderItemId ?? it.orderItemId ?? it.OrderItemId ?? it.id;
      if (!orderItemId) continue;

      const sku =
        it?.itemIdentifier?.sku ??
        it?.ItemIdentifier?.Sku ??
        it?.sku ?? it?.SKU ?? "";
      const qualifier = it?.qualifier ?? it?.Qualifier ?? "";
      const qty = Number(it?.qty ?? it?.Qty ?? it?.orderedQty ?? it?.OrderedQty ?? 0) || 0;
      const unitId   = IR?.unitIdentifier?.id   ?? null;
      const unitName = IR?.unitIdentifier?.name ?? "";

      rows.push({
        OrderId:        Number(orderId),
        OrderItemID:    Number(orderItemId),
        CustomerID:     Number(cust?.id || 0),
        CustomerName:   String(cust?.name || ""),
        ItemID:         String(sku || ""),   // mirror SKU into ItemID
        SKU:            String(sku || ""),
        Qualifier:      String(qualifier || ""),
        OrderedQTY:     qty,
        UnitID:         unitId ? Number(unitId) : null,
        UnitName:       String(unitName || ""),
        ReferenceNum:   String(ref || ""),
        ShipToAddress1: String(addr || ""),
      });
    }

    // 3) upsert lines
    const pool = await getPool();
    const upserts = await upsertOrderDetails(pool, rows);

    // 4) inventory
    const inv = await inventoryForOrder(pool, rows);

    res.json({
      ok: true,
      order: {
        orderId: Number(orderId),
        customerId: Number(cust?.id || 0),
        customerName: String(cust?.name || ""),
        referenceNum: ref || "",
        shipToAddress1: addr || "",
      },
      upserts,
      lines: rows,
      inventory: inv,
    });
  } catch (e) { next(e); }
});

/**
 * POST /api/single-alloc/allocate
 * body: { lineIds: number[] }
 * Runs your while-loop SQL (scoped to those OrderItemIDs) → dbo.SuggAlloc.
 */
r.post("/allocate", async (req, res, next) => {
  try {
    let ids = req.body?.lineIds;
    if (!ids) return res.status(400).json({ ok:false, message:"lineIds required" });
    if (!Array.isArray(ids)) ids = [ids];
    const lineIds = ids.map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0);
    if (!lineIds.length) return res.status(400).json({ ok:false, message:"no valid IDs" });

    const idList = lineIds.join(",");
    const pool = await getPool();

    // clear existing suggestions for those lines
    await pool.request().query(`DELETE FROM dbo.SuggAlloc WHERE OrderItemID IN (${idList});`);

    // while-loop allocation (your script; scoped to selected lines)
    await pool.request().query(`
DECLARE @RemainingOpenQty INT = 1;
WHILE @RemainingOpenQty > 0
BEGIN
  INSERT INTO dbo.SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
  SELECT TOP 1
    a.OrderItemID,
    b.ReceiveItemID,
    CASE WHEN (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY
         THEN b.AvailableQTY ELSE (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) END AS AllocQty
  FROM dbo.OrderDetails a
  LEFT JOIN dbo.Inventory b
         ON a.ItemID = b.ItemID AND ISNULL(a.Qualifier,'') = ISNULL(b.Qualifier,'')
  LEFT JOIN (
      SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
      FROM dbo.SuggAlloc
      GROUP BY OrderItemID
  ) c ON a.OrderItemID = c.OrderItemID
  WHERE a.OrderItemID IN (${idList})
    AND b.ReceiveItemId NOT IN (SELECT DISTINCT ReceiveItemID FROM dbo.SuggAlloc)
    AND b.AvailableQTY > 0
    AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) > 0
  ORDER BY
    a.OrderItemID,
    CASE
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) =  b.AvailableQTY THEN 1
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) =  b.AvailableQTY THEN 2
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >   b.AvailableQTY THEN 3
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >   b.AvailableQTY THEN 4
      WHEN b.ReceivedQty > b.AvailableQty  AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >=  b.AvailableQTY THEN 5
      WHEN b.ReceivedQty > b.AvailableQty  AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >=  b.AvailableQTY THEN 6
      WHEN SUBSTRING(b.LocationName,4,1) = 'A'  AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) <= b.AvailableQTY THEN 7
      WHEN SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) <= b.AvailableQTY THEN 8
    END ASC,
    CASE WHEN SUBSTRING(b.LocationName,4,1) = 'A' THEN 999999 - b.AvailableQTY ELSE b.AvailableQTY + 0 END DESC;

  SELECT TOP 1
    @RemainingOpenQty = (a.OrderedQTY - ISNULL(b.SumSuggAllocQty,0))
  FROM dbo.OrderDetails a
  LEFT JOIN (
    SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
    FROM dbo.SuggAlloc
    GROUP BY OrderItemID
  ) b ON a.OrderItemID = b.OrderItemID
  WHERE a.OrderItemID IN (${idList})
  ORDER BY (a.OrderedQTY - ISNULL(b.SumSuggAllocQty,0)) DESC;
END
    `);

    const after = await pool.request().query(`
      SELECT s.OrderItemID, s.ReceiveItemID, s.SuggAllocQty
      FROM dbo.SuggAlloc s
      WHERE s.OrderItemID IN (${idList})
      ORDER BY s.OrderItemID, s.ReceiveItemID;
    `);

    res.json({ ok:true, rows: after.recordset });
  } catch (e) { next(e); }
});

/**
 * POST /api/single-alloc/push
 * body: { orderId: number }
 * Builds payload from dbo.SuggAlloc and PUTs to /orders/{orderId}/allocator
 */
r.post("/push", async (req, res, next) => {
  try {
    const orderId = Number(req.body?.orderId || 0);
    if (!orderId) return res.status(400).json({ ok:false, message:"orderId required" });

    const pool = await getPool();
    const q = await pool.request()
      .input("OrderId", sql.Int, orderId)
      .query(`
        SELECT od.OrderID, s.OrderItemID, s.ReceiveItemID, s.SuggAllocQty
        FROM dbo.SuggAlloc s WITH (NOLOCK)
        JOIN dbo.OrderDetails od WITH (NOLOCK)
          ON od.OrderItemID = s.OrderItemID
        WHERE od.OrderID = @OrderId
        ORDER BY s.OrderItemID, s.ReceiveItemID;
      `);

    const rows = q.recordset || [];
    if (!rows.length) return res.json({ ok:false, message:"No SuggAlloc for this order." });

    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.OrderItemID)) map.set(r.OrderItemID, []);
      map.get(r.OrderItemID).push({
        receiveItemId: r.ReceiveItemID,
        qty: Number(r.SuggAllocQty) || 0
      });
    }
    const orderItems = Array.from(map.entries()).map(([orderItemId, allocations]) => ({ orderItemId, allocations }));

    const headers = await authHeaders();
    const base = (process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com").replace(/\/+$/, "");
    const resp = await axios.put(`${base}/orders/${orderId}/allocator`, { orderItems }, {
      headers, timeout: 30000, validateStatus: () => true
    });

    res.status(resp.status).json({ ok: resp.status >=200 && resp.status<300, status: resp.status, data: resp.data });
  } catch (e) { next(e); }
});

export default r;
