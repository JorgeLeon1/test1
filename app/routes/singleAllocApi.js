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

 // Make error obvious to the UI
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
   // If ItemID column exists but you want SKU mirrored into it:
   ["ItemID", "ItemID", sql.VarChar(150), s(rec.SKU, 150)],
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

// quick sanity ping
r.get("/ping", (_req, res) => res.json({ ok: true, where: "single-alloc" }));

/**
* GET /api/single-alloc/order/:id
* - pulls one order from Extensiv (detail=All&itemdetail=All)
* - upserts its lines into dbo.OrderDetails
* - returns normalized header + lines
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
     const line = {
       OrderItemID: toInt(iro.orderItemId ?? iro.OrderItemId ?? it.orderItemId ?? it.OrderItemId, 0),
       OrderID: orderHeader.orderId,
       CustomerID: orderHeader.customerId,
       CustomerName: orderHeader.customerName,
       SKU: s(it?.itemIdentifier?.sku ?? it?.sku ?? it?.SKU ?? "", 150),
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
* - convenience for UI to load the lines we stored for this order
*/
r.get("/lines/:orderId", async (req, res) => {
 try {
   const orderId = toInt(req.params.orderId, 0);
   if (!orderId) return res.status(400).json({ ok: false, message: "Invalid orderId" });
   const pool = await getPool();
   const q = await pool
     .request()
     .input("OrderID", sql.Int, orderId)
     .query(`SELECT OrderItemID, OrderID, CustomerID, CustomerName, ItemID, SKU, Qualifier, OrderedQTY, UnitID, UnitName, ReferenceNum
             FROM dbo.OrderDetails
             WHERE OrderID=@OrderID
             ORDER BY OrderItemID`);
   res.json({ ok: true, orderId, lines: q.recordset });
 } catch (e) {
   res.status(500).json({ ok: false, message: e.message });
 }
});

/**
* POST /api/single-alloc/allocate
* body: { orderId: number, lineIds: number[] }
* - clears old SuggAlloc for those lines
* - runs your iterative allocation SQL scoped to given line IDs
*/
r.post("/allocate", async (req, res) => {
 try {
   const { orderId, lineIds } = req.body || {};
   const oid = toInt(orderId, 0);
   if (!oid) return res.status(400).json({ ok: false, message: "orderId required" });
   if (!Array.isArray(lineIds) || !lineIds.length) {
     return res.status(400).json({ ok: false, message: "lineIds required" });
   }

   const idsCsv = lineIds.map((n) => toInt(n)).filter(Boolean).join(",");
   if (!idsCsv) return res.status(400).json({ ok: false, message: "lineIds empty after filtering" });

   const pool = await getPool();

   // Clear old suggestions for these specific lines
   await pool.request().query(`DELETE FROM SuggAlloc WHERE OrderItemID IN (${idsCsv});`);

   // Iterative suggestion logic (uses your sequence & priorities)
   await pool.request().batch(`
DECLARE @RemainingOpenQty INT;
SET @RemainingOpenQty = 1;

WHILE @RemainingOpenQty > 0
BEGIN
 INSERT INTO SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
 SELECT TOP 1
   a.OrderItemID,
   b.ReceiveItemID,
   CASE
     WHEN (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY THEN b.AvailableQTY
     ELSE (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0))
   END AS AllocQty
 FROM (
   SELECT
     od.OrderItemID,
     od.OrderedQTY,
     inv.ReceiveItemID,
     inv.AvailableQTY,
     ISNULL(sa.SumSuggAllocQty,0) AS SumSuggAllocQty,
     od.OrderedQTY - ISNULL(sa.SumSuggAllocQty,0) AS RemainingOpenQty,
     inv.LocationName,
     CASE
       WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)='A'  AND (od.OrderedQTY-ISNULL(sa.SumSuggAllocQty,0)) = inv.AvailableQTY THEN 1
       WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)<>'A' AND (od.OrderedQTY-ISNULL(sa.SumSuggAllocQty,0)) = inv.AvailableQTY THEN 2
       WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)<>'A' AND (od.OrderedQTY-ISNULL(sa.SumSuggAllocQty,0)) > inv.AvailableQTY THEN 3
       WHEN inv.ReceivedQty = inv.AvailableQty AND SUBSTRING(inv.LocationName,4,1)='A'  AND (od.OrderedQTY-ISNULL(sa.SumSuggAllocQty,0)) > inv.AvailableQTY THEN 4
       WHEN inv.ReceivedQty > inv.AvailableQty  AND SUBSTRING(inv.LocationName,4,1)='A'  AND (od.OrderedQTY-ISNULL(sa.SumSuggAllocQty,0)) >= inv.AvailableQTY THEN 5
       WHEN inv.ReceivedQty > inv.AvailableQty  AND SUBSTRING(inv.LocationName,4,1)<>'A' AND (od.OrderedQTY-ISNULL(sa.SumSuggAllocQty,0)) >= inv.AvailableQTY THEN 6
       WHEN SUBSTRING(inv.LocationName,4,1)='A'  AND (od.OrderedQTY-ISNULL(sa.SumSuggAllocQty,0)) <= inv.AvailableQTY THEN 7
       WHEN SUBSTRING(inv.LocationName,4,1)<>'A' AND (od.OrderedQTY-ISNULL(sa.SumSuggAllocQty,0)) <= inv.AvailableQTY THEN 8
     END AS Seq
   FROM dbo.OrderDetails od
   LEFT JOIN dbo.Inventory inv
     ON od.ItemID = inv.ItemID AND od.Qualifier = inv.Qualifier
   LEFT JOIN (
     SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
     FROM SuggAlloc
     GROUP BY OrderItemID
   ) sa
     ON od.OrderItemID = sa.OrderItemID
   WHERE
     od.OrderItemID IN (${idsCsv})
     AND inv.AvailableQTY > 0
     AND inv.ReceiveItemID NOT IN (SELECT DISTINCT ReceiveItemID FROM SuggAlloc)
 ) a
 WHERE a.RemainingOpenQty > 0
 ORDER BY a.OrderItemID,
          a.Seq ASC,
          CASE
            WHEN a.Seq IN (1,2,3,4,5,6) THEN a.AvailableQTY + 0
            WHEN a.Seq IN (7,8) THEN 999999 - a.AvailableQTY
          END DESC;

 SET @RemainingOpenQty = (
   SELECT TOP 1
     ISNULL(od.OrderedQTY - ISNULL(sa.SumSuggAllocQty,0), 0) AS Remaining
   FROM dbo.OrderDetails od
   LEFT JOIN (
     SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
     FROM SuggAlloc
     GROUP BY OrderItemID
   ) sa ON sa.OrderItemID = od.OrderItemID
   WHERE od.OrderItemID IN (${idsCsv})
   ORDER BY Remaining DESC
 );
END
   `);

   res.json({ ok: true, orderId: oid, linesAffected: lineIds.length });
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
* - pushes current SuggAlloc for the order to Extensiv allocator endpoint
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
