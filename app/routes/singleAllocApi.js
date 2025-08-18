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

  const { data } = await axios.get(`${base}/orders/${orderId}`, {
    headers,
    params: { detail: "All", itemdetail: "All" },
    timeout: 30000,
  });
  return data;
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

async function getExistingCols(pool) {
  const q = await pool.request().query(
    "SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OrderDetails')"
  );
  return new Set(q.recordset.map(r => r.name));
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
    ["ItemID", "ItemID", sql.VarChar(150), s(rec.SKU, 150)],
    ["Qualifier", "Qualifier", sql.VarChar(80), s(rec.Qualifier, 80)],
    ["OrderedQTY", "OrderedQTY", sql.Int, toInt(rec.OrderedQTY, 0)],
    ["UnitID", "UnitID", sql.Int, toInt(rec.UnitID, 0)],
    ["UnitName", "UnitName", sql.VarChar(80), s(rec.UnitName, 80)],
    ["ReferenceNum", "ReferenceNum", sql.VarChar(120), s(rec.ReferenceNum, 120)],
  ];
  const active = defs.filter(([c]) => cols.has(c));
  active.forEach(([c, p, type, val]) => req.input(p, type, val));

  const setClause   = active.map(([c, p]) => `${c}=@${p}`).join(", ");
  const insertCols  = ["OrderItemID", ...active.map(([c]) => c)].join(", ");
  const insertVals  = ["@OrderItemID", ...active.map(([,p]) => `@${p}`)].join(", ");

  const sqlText = `
IF EXISTS (SELECT 1 FROM dbo.OrderDetails WITH (UPDLOCK, HOLDLOCK) WHERE OrderItemID=@OrderItemID)
  UPDATE dbo.OrderDetails SET ${setClause} WHERE OrderItemID=@OrderItemID;
ELSE
  INSERT INTO dbo.OrderDetails (${insertCols}) VALUES (${insertVals});
`;
  await req.query(sqlText);
}

/* -------------------------- Routes -------------------------- */

r.get("/ping", (_req, res) => res.json({ ok: true, where: "single-alloc" }));

// GET /api/single-alloc/order/:id
r.get("/order/:id", async (req, res) => {
  try {
    const orderId = toInt(req.params.id, 0);
    if (!orderId) return res.status(400).json({ ok:false, message:"Invalid orderId" });

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
    const lines = [];

    for (const it of linesRaw) {
      const iro = it?.readOnly || it?.ReadOnly || {};
      const line = {
        OrderItemID: toInt(iro.orderItemId ?? iro.orderItemId ?? it.orderItemId ?? it.OrderItemId, 0),
        OrderID: orderHeader.orderId,
        CustomerID: orderHeader.customerId,
        CustomerName: orderHeader.customerName,
        SKU: s(it?.itemIdentifier?.sku ?? it?.sku ?? it?.SKU ?? "", 150),
        Qualifier: s(it?.qualifier ?? "", 80),
        OrderedQTY: toInt(it?.qty ?? it?.orderedQty ?? it?.Qty ?? 0, 0),
        UnitID: toInt(iro?.unitIdentifier?.id, 0),
        UnitName: s(iro?.unitIdentifier?.name, 80),
        ReferenceNum: orderHeader.referenceNum,
      };
      if (!line.OrderItemID) continue;
      await upsertOrderDetail(pool, cols, line);
      lines.push(line);
    }

    res.json({ ok: true, order: orderHeader, lines });
  } catch (e) {
    res.status(500).json({ ok:false, message: e.message });
  }
});

// POST /api/single-alloc/allocate
r.post("/allocate", async (req, res) => {
  try {
    const { orderId, lineIds } = req.body || {};
    if (!toInt(orderId)) return res.status(400).json({ ok:false, message:"orderId required" });
    if (!Array.isArray(lineIds) || !lineIds.length) return res.status(400).json({ ok:false, message:"lineIds required" });

    const ids = lineIds.map(n => toInt(n)).filter(Boolean).join(",");
    const pool = await getPool();

    await pool.request().batch(`
      DELETE SuggAlloc WHERE OrderItemID IN (${ids});

      DECLARE @RemainingOpenQty INT;
      SET @RemainingOpenQty = 1;

      WHILE @RemainingOpenQty > 0
      BEGIN
        INSERT INTO SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
        SELECT TOP 1
          a.OrderItemID, b.ReceiveItemID,
          CASE WHEN (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY
               THEN b.AvailableQTY
               ELSE (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0))
          END AS AllocQty
        FROM (
          SELECT
            a.OrderItemID, a.OrderedQTY, b.ReceiveItemID, b.AvailableQTY,
            ISNULL(c.SumSuggAllocQty,0) AS SumSuggAllocQty,
            a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0) AS RemainingOpenQty,
            b.LocationName,
            CASE
              WHEN b.ReceivedQty=b.AvailableQty AND SUBSTRING(b.LocationName,4,1)='A'  AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) = b.AvailableQTY THEN 1
              WHEN b.ReceivedQty=b.AvailableQty AND SUBSTRING(b.LocationName,4,1)<>'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) = b.AvailableQTY THEN 2
              WHEN b.ReceivedQty=b.AvailableQty AND SUBSTRING(b.LocationName,4,1)<>'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) > b.AvailableQTY THEN 3
              WHEN b.ReceivedQty=b.AvailableQty AND SUBSTRING(b.LocationName,4,1)='A'  AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) > b.AvailableQTY THEN 4
              WHEN b.ReceivedQty>b.AvailableQty  AND SUBSTRING(b.LocationName,4,1)='A'  AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY THEN 5
              WHEN b.ReceivedQty>b.AvailableQty  AND SUBSTRING(b.LocationName,4,1)<>'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY THEN 6
              WHEN SUBSTRING(b.LocationName,4,1)='A'  AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) <= b.AvailableQTY THEN 7
              WHEN SUBSTRING(b.LocationName,4,1)<>'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) <= b.AvailableQTY THEN 8
            END AS Seq
          FROM dbo.OrderDetails a
          LEFT JOIN dbo.Inventory b
            ON a.ItemID = b.ItemID AND a.Qualifier = b.Qualifier
          LEFT JOIN (SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) SumSuggAllocQty FROM SuggAlloc GROUP BY OrderItemID) c
            ON a.OrderItemID = c.OrderItemID
          WHERE a.OrderItemID IN (${ids})
            AND b.ReceiveItemId NOT IN (SELECT DISTINCT ReceiveItemID FROM SuggAlloc)
            AND b.AvailableQTY > 0
        ) a
        WHERE a.RemainingOpenQty > 0
        ORDER BY a.OrderItemID, a.Seq ASC,
                 CASE WHEN a.seq IN (1,2,3,4,5,6) THEN a.AvailableQty+0 WHEN a.seq IN (7,9) THEN 999999-a.AvailableQty END DESC;

        SET @RemainingOpenQty = (
          SELECT TOP 1 ISNULL(OrderedQty - SumSuggAllocQty, 0)
          FROM (
            SELECT od.OrderedQTY AS OrderedQty, sa.SumSuggAllocQty
            FROM OrderDetails od
            LEFT JOIN (SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) SumSuggAllocQty FROM SuggAlloc GROUP BY OrderItemID) sa
              ON od.OrderItemID = sa.OrderItemID
            WHERE od.OrderItemID IN (${ids})
          ) t
        );
      END
    `);

    res.json({ ok: true, orderId, linesAffected: lineIds.length });
  } catch (e) {
    res.status(500).json({ ok:false, message: e.message });
  }
});

// POST /api/single-alloc/push
r.post("/push", async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!toInt(orderId)) return res.status(400).json({ ok:false, message:"orderId required" });

    const pool = await getPool();
    const allocs = await pool.request().query(`
      SELECT OrderItemID, ReceiveItemID, SuggAllocQty
      FROM SuggAlloc
      WHERE OrderItemID IN (SELECT OrderItemID FROM OrderDetails WHERE OrderID = ${toInt(orderId)})
        AND ISNULL(SuggAllocQty,0) > 0
    `);

    const payload = {
      allocations: allocs.recordset.map(a => ({
        orderItemId: a.OrderItemID,
        receiveItemId: a.ReceiveItemID,
        qty: a.SuggAllocQty
      }))
    };

    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
    const headers = await authHeaders();
    const resp = await axios.put(`${base}/orders/${orderId}/allocator`, payload, {
      headers, timeout: 30000,
    });

    res.json({ ok:true, status: resp.status, sent: payload.allocations.length });
  } catch (e) {
    res.status(500).json({ ok:false, message: e.message, data: e.response?.data });
  }
});

export default r;
