// src/app/routes/batchAllocApi.js
import { Router } from "express";
import axios from "axios";
import { getPool, sql } from "../services/db/mssql.js";
import { authHeaders } from "../services/extensivClient.js";

const r = Router();

/* ----------------------- helpers ----------------------- */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const toInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const s = (v, max = 255) => (v == null ? "" : String(v).normalize("NFC").slice(0, max));
const ro = (o) => o?.readOnly || o?.ReadOnly || {};

function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj?.ResourceList)) return obj.ResourceList;
  if (Array.isArray(obj?._embedded?.["http://api.3plCentral.com/rels/orders/order"])) {
    return obj._embedded["http://api.3plCentral.com/rels/orders/order"];
  }
  if (Array.isArray(obj?.data)) return obj.data;
  for (const v of Object.values(obj || {})) if (Array.isArray(v)) return v;
  return [];
}

function itemsFromOrder(ord) {
  const em = ord?._embedded;
  if (em && Array.isArray(em["http://api.3plCentral.com/rels/orders/item"])) {
    return em["http://api.3plCentral.com/rels/orders/item"];
  }
  if (Array.isArray(ord?.OrderItems)) return ord.OrderItems;
  if (Array.isArray(ord?.Items)) return ord.Items;
  return [];
}

async function getExistingCols(pool) {
  const q = await pool
    .request()
    .query("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OrderDetails')");
  return new Set(q.recordset.map((r) => r.name));
}

/** Upsert a subset of columns if they exist in dbo.OrderDetails
 *  IMPORTANT: store ItemID as VARCHAR (raw), not INT — allocator uses string equality or fallback to SKU.
 */
async function upsertOrderDetail(pool, cols, rec) {
  if (!rec.OrderItemID) return;

  const req = pool.request();
  req.input("OrderItemID", sql.Int, rec.OrderItemID);

  const defs = [
    ["OrderID", "OrderID", sql.Int, toInt(rec.OrderID, 0)],
    ["CustomerID", "CustomerID", sql.Int, toInt(rec.CustomerID, 0)],
    ["CustomerName", "CustomerName", sql.VarChar(200), s(rec.CustomerName, 200)],
    ["SKU", "SKU", sql.VarChar(150), s(rec.SKU, 150)],
    ["ItemID", "ItemID", sql.VarChar(128), s(rec.ItemID, 128)], // store raw text
    ["Qualifier", "Qualifier", sql.VarChar(80), s(rec.Qualifier, 80)],
    ["OrderedQTY", "OrderedQTY", sql.Int, toInt(rec.OrderedQTY, 0)],
    ["UnitID", "UnitID", sql.Int, toInt(rec.UnitID, 0)],
    ["UnitName", "UnitName", sql.VarChar(80), s(rec.UnitName, 80)],
    ["ReferenceNum", "ReferenceNum", sql.VarChar(120), s(rec.ReferenceNum, 120)],
  ];

  const active = defs.filter(([c]) => cols.has(c));
  active.forEach(([, p, type, val]) => req.input(p, type, val));

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

/* ======================= SINGLE-ORDER ENDPOINTS ======================= */

/** GET /order/:id
 *  Lightweight "header" and lines for a single order (from OrderDetails).
 *  Use when mounted at /api/single-alloc → /api/single-alloc/order/:id
 */
r.get("/order/:id", async (req, res) => {
  try {
    const id = toInt(req.params.id, 0);
    if (!id) return res.status(400).json({ ok: false, message: "Invalid order id" });

    const pool = await getPool();

    const hdr = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        SELECT TOP (1)
          OrderID         AS orderId,
          CustomerName    AS customerName,
          ReferenceNum    AS referenceNum
        FROM dbo.OrderDetails WITH (NOLOCK)
        WHERE OrderID = @id
        ORDER BY OrderItemID;
      `);

    if (!hdr.recordset.length) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    const linesQ = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        SELECT
          OrderItemID,
          OrderID,
          SKU,
          OrderedQTY,
          ISNULL(Qualifier,'') AS Qualifier,
          ISNULL(UnitName,'')  AS UnitName
        FROM dbo.OrderDetails WITH (NOLOCK)
        WHERE OrderID = @id
        ORDER BY OrderItemID;
      `);

    const order = hdr.recordset[0];
    const lines = linesQ.recordset.map((x) => ({
      OrderItemID: x.OrderItemID,
      orderItemId: x.OrderItemID, // camelCase for UI
      sku: x.SKU,
      OrderedQTY: x.OrderedQTY,
      Qualifier: x.Qualifier,
      unitName: x.UnitName,
    }));

    return res.json({ ok: true, order, lines });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

/* ======================= BATCH: SEARCH/INGEST ENDPOINTS ======================= */

/* ----------------------- GET /search ----------------------- */
r.get("/search", async (req, res) => {
  try {
    const base = trimBase(
      process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com"
    );
    const headers = await authHeaders();

    const pageSize = Math.min(toInt(req.query.pageSize, 100), 500);
    const maxPages = Math.min(toInt(req.query.maxPages, 5), 20);

    const rql = [];
    rql.push("readOnly.fullyAllocated==false");

    if (req.query.status) {
      const statusMap = { AWAITINGPICK: 0, OPEN: 0, CLOSED: 9, CANCELLED: 5 };
      const code = statusMap[String(req.query.status).toUpperCase()];
      if (Number.isFinite(code)) rql.push(`readOnly.status==${code}`);
    }

    if (req.query.customerId) rql.push(`customerIdentifier.id==${toInt(req.query.customerId, 0)}`);
    if (req.query.referenceLike) rql.push(`referenceNum==*${req.query.referenceLike}*`);
    if (req.query.modifiedSince) {
      rql.push(`readOnly.modifiedDateTime>=${encodeURIComponent(req.query.modifiedSince)}`);
    }

    const pool = await getPool();
    const cols = await getExistingCols(pool);

    let importedHeaders = 0;
    let upsertedLines = 0;
    const foundOrders = [];

    for (let pg = 1; pg <= maxPages; pg++) {
      const { data } = await axios.get(`${base}/orders`, {
        headers,
        params: {
          pgsiz: pageSize,
          pgnum: pg,
          detail: "OrderItems",
          itemdetail: "All",
          rql: rql.join(";"),
        },
        timeout: 30000,
        validateStatus: () => true,
      });

      if (!(Array.isArray(data) || data?._embedded || data?.ResourceList)) {
        return res.status(502).json({ ok: false, message: "Unexpected orders payload", data });
      }

      const orders = firstArray(data);
      if (!orders.length) break;
      importedHeaders += orders.length;

      for (const ord of orders) {
        const R = ro(ord);
        const orderId = toInt(R.orderId ?? ord.orderId ?? R.OrderId ?? ord.OrderId, 0);
        const customerId = toInt(ord?.customerIdentifier?.id, 0);
        const customerName = s(ord?.customerIdentifier?.name, 200);
        const referenceNum = s(ord?.referenceNum, 120);

        const lines = itemsFromOrder(ord);
        const lineObjs = [];

        for (const it of lines) {
          const IR = ro(it);
          const orderItemId = toInt(
            IR.orderItemId ?? it.orderItemId ?? IR.OrderItemId ?? it.OrderItemId,
            0
          );
          if (!orderItemId) continue;

          const itemIdRaw = (it?.itemIdentifier?.id ?? it?.ItemID ?? "").toString();
          const sku = s(it?.itemIdentifier?.sku ?? it?.sku ?? it?.SKU ?? "", 150);
          const unitId = toInt(IR?.unitIdentifier?.id, 0);
          const unitName = s(IR?.unitIdentifier?.name ?? "", 80);
          const qualifier = s(it?.qualifier ?? "", 80);
          const qty = toInt(
            it?.qty ??
              it?.orderedQty ??
              it?.Qty ??
              it?.OrderedQty ??
              it?.quantity ??
              it?.Quantity ??
              it?.readOnly?.qty ??
              it?.readOnly?.orderedQty ??
              it?.readOnly?.quantity ??
              0,
            0
          );

          await upsertOrderDetail(pool, cols, {
            OrderItemID: orderItemId,
            OrderID: orderId,
            CustomerID: customerId,
            CustomerName: customerName,
            SKU: sku,
            ItemID: itemIdRaw,
            Qualifier: qualifier,
            OrderedQTY: qty,
            UnitID: unitId,
            UnitName: unitName,
            ReferenceNum: referenceNum,
          });
          lineObjs.push({
            orderItemId,
            itemId: itemIdRaw,
            sku,
            qty,
            unitId,
            unitName,
            qualifier,
          });
          upsertedLines++;
        }

        foundOrders.push({
          orderId,
          customerId,
          customerName,
          referenceNum,
          lineCount: lineObjs.length,
          lines: lineObjs,
        });
      }

      if (orders.length < pageSize) break;
    }

    res.json({ ok: true, importedHeaders, upsertedLines, orders: foundOrders });
  } catch (e) {
    res
      .status(e.status || 500)
      .json({ ok: false, message: e.message, data: e.response?.data || null });
  }
});

/* ----------------------- POST /search-by-batchid ----------------------- */
r.post("/search-by-batchid", async (req, res) => {
  try {
    const base = trimBase(
      process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com"
    );
    const headers = await authHeaders();

    const batchId = toInt(req.body?.batchId, 0);
    if (!batchId) return res.status(400).json({ ok: false, message: "batchId (number) required" });

    const pageSize = Math.min(toInt(req.body?.pageSize, 250), 500);
    const maxPages = Math.min(toInt(req.body?.maxPages, 10), 20);

    const rqlCandidates = [
      `batchId==${batchId}`,
      `readOnly.batchId==${batchId}`,
      `batchIdentifier.id==${batchId}`,
      `batchIdentifier.batchId==${batchId}`,
      `readOnly.batchIdentifier.id==${batchId}`,
      `readOnly.batchIdentifier.batchId==${batchId}`,
      `batchNumber==${batchId}`,
      `readOnly.batchNumber==${batchId}`,
      `batch.id==${batchId}`,
      `readOnly.batch.id==${batchId}`,
      `readOnly.batchIdentifier.number==${batchId}`,
      `batchIdentifier.number==${batchId}`,
    ];

    const pool = await getPool();
    const cols = await getExistingCols(pool);

    const tried = [];
    let usedRql = null;
    let importedHeaders = 0;
    let upsertedLines = 0;
    const foundOrders = [];

    async function ingestOrders(orders) {
      for (const ord of orders) {
        const R = ro(ord);
        const orderId = toInt(R.orderId ?? ord.orderId ?? R.OrderId ?? ord.OrderId, 0);
        const customerId = toInt(ord?.customerIdentifier?.id, 0);
        const customerName = s(ord?.customerIdentifier?.name, 200);
        const referenceNum = s(ord?.referenceNum, 120);

        const lines = itemsFromOrder(ord) || [];
        const lineObjs = [];

        for (const it of lines) {
          const IR = ro(it);
          const orderItemId = toInt(
            IR.orderItemId ?? it.orderItemId ?? IR.OrderItemId ?? it.OrderItemId,
            0
          );
          if (!orderItemId) continue;

          const itemIdRaw = (it?.itemIdentifier?.id ?? it?.ItemID ?? "").toString();
          const sku = s(it?.itemIdentifier?.sku ?? it?.sku ?? it?.SKU ?? "", 150);
          const unitId = toInt(IR?.unitIdentifier?.id, 0);
          const unitName = s(IR?.unitIdentifier?.name ?? "", 80);
          const qualifier = s(it?.qualifier ?? "", 80);
          const qty = toInt(
            it?.qty ??
              it?.orderedQty ??
              it?.Qty ??
              it?.OrderedQty ??
              it?.quantity ??
              it?.Quantity ??
              it?.readOnly?.qty ??
              it?.readOnly?.orderedQty ??
              it?.readOnly?.quantity ??
              0,
            0
          );

          await upsertOrderDetail(pool, cols, {
            OrderItemID: orderItemId,
            OrderID: orderId,
            CustomerID: customerId,
            CustomerName: customerName,
            SKU: sku,
            ItemID: itemIdRaw,
            Qualifier: qualifier,
            OrderedQTY: qty,
            UnitID: unitId,
            UnitName: unitName,
            ReferenceNum: referenceNum,
          });
          upsertedLines++;

          lineObjs.push({ orderItemId, itemId: itemIdRaw, sku, qty, unitId, unitName, qualifier });
        }

        foundOrders.push({
          orderId,
          customerId,
          customerName,
          referenceNum,
          lineCount: lineObjs.length,
          lines: lineObjs,
        });
      }
    }

    for (const rql of rqlCandidates) {
      let gotAny = false;

      for (let pg = 1; pg <= maxPages; pg++) {
        const { data, status } = await axios.get(`${base}/orders`, {
          headers,
          params: { pgsiz: pageSize, pgnum: pg, detail: "OrderItems", itemdetail: "All", rql },
          timeout: 30000,
          validateStatus: () => true,
        });

        if (!tried.length || tried[tried.length - 1].rql !== rql) {
          const sampleKeys = data && typeof data === "object" ? Object.keys(data).slice(0, 10) : [];
          tried.push({ rql, status, sampleKeys });
        }

        if (!(status >= 200 && status < 300)) break;

        const orders = firstArray(data);
        if (!orders.length) break;

        if (!usedRql) usedRql = rql;
        gotAny = true;
        importedHeaders += orders.length;
        await ingestOrders(orders);

        if (orders.length < pageSize) break;
      }

      if (gotAny) break;
    }

    return res.json({
      ok: true,
      usedRql,
      importedHeaders,
      upsertedLines,
      orders: foundOrders,
      diagnostics: { tried },
    });
  } catch (e) {
    return res
      .status(e.status || 500)
      .json({ ok: false, message: e.message, data: e.response?.data || null });
  }
});

/* ----------------------- POST /search-by-ids ----------------------- */
r.post("/search-by-ids", async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((n) => toInt(n)).filter(Boolean)
      : [];
    if (!orderIds.length) return res.status(400).json({ ok: false, message: "orderIds required" });

    const pool = await getPool();
    const rows = await pool.request().query(`
      SELECT OrderID, OrderItemID, SKU, CustomerName, ReferenceNum
      FROM OrderDetails
      WHERE OrderID IN (${orderIds.join(",")})
    `);

    const grouped = new Map();
    for (const r0 of rows.recordset) {
      if (!grouped.has(r0.OrderID)) {
        grouped.set(r0.OrderID, {
          orderId: r0.OrderID,
          customerName: r0.CustomerName,
          referenceNum: r0.ReferenceNum,
          lineCount: 0,
          lines: [],
        });
      }
      const g = grouped.get(r0.OrderID);
      g.lines.push({ OrderItemID: r0.OrderItemID, SKU: r0.SKU });
      g.lineCount++;
    }

    res.json({ ok: true, orders: Array.from(grouped.values()) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/* ======================= ALLOCATE / PUSH (SINGLE OR BATCH) ======================= */
/** POST /allocate
 *  Accepts either:
 *   - { orderIds: number[] }  → batch
 *   - { orderId:  number   }  → single
 *  Work based on OrderDetails + SuggAlloc tables.
 */
r.post("/allocate", async (req, res) => {
  try {
    let ids = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((n) => toInt(n)).filter(Boolean)
      : [];
    const singleId = toInt(req.body?.orderId, 0);
    if (!ids.length && singleId) ids = [singleId];

    if (!ids.length) {
      return res.status(400).json({ ok: false, message: "orderIds or orderId required" });
    }

    const pool = await getPool();

    // Gather target line IDs
    const idQuery = await pool.request().query(`
      SELECT OrderItemID
      FROM OrderDetails
      WHERE OrderID IN (${ids.join(",")})
    `);
    const lineIds = idQuery.recordset.map((r0) => r0.OrderItemID);
    if (!lineIds.length) return res.json({ ok: true, allocated: 0, summary: [] });

    // Clear allocations for these lines
    await pool.request().query(`DELETE SuggAlloc WHERE OrderItemID IN (${lineIds.join(",")});`);

    // Allocation loop (ItemID string equality → SKU fallback), qualifier normalized
    await pool.request().batch(`
DECLARE @iters INT = 0;
DECLARE @maxIters INT = 20000;

WHILE (1=1)
BEGIN
  ;WITH x AS (
    SELECT
      od.OrderItemID,
      od.OrderedQTY,
      UPPER(LTRIM(RTRIM(CAST(od.ItemID AS VARCHAR(128))))) AS ItemIDStr,
      UPPER(LTRIM(RTRIM(od.SKU)))                          AS SKU_N,
      NULLIF(UPPER(LTRIM(RTRIM(od.Qualifier))),'')         AS Qual_N,
      ISNULL(sa.SumSuggAllocQty,0)                         AS SumSuggAllocQty,
      (od.OrderedQTY - ISNULL(sa.SumSuggAllocQty,0))       AS RemainingOpenQty
    FROM OrderDetails od
    LEFT JOIN (
      SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
      FROM SuggAlloc GROUP BY OrderItemID
    ) sa ON sa.OrderItemID = od.OrderItemID
    WHERE od.OrderItemID IN (${lineIds.join(",")})
  ),
  invx AS (
    SELECT
      inv.ReceiveItemID,
      UPPER(LTRIM(RTRIM(CAST(inv.ItemID AS VARCHAR(128))))) AS ItemIDStr,
      UPPER(LTRIM(RTRIM(inv.SKU)))                          AS SKU_N,
      NULLIF(UPPER(LTRIM(RTRIM(inv.Qualifier))),'')         AS Qual_N,
      inv.LocationName,
      inv.ReceivedQty,
      inv.AvailableQTY
    FROM Inventory inv
  ),
  inv_unpicked AS (
    SELECT i.* FROM invx i
    WHERE i.ReceiveItemID NOT IN (SELECT DISTINCT ReceiveItemID FROM SuggAlloc)
  ),
  cand_t1 AS (
    SELECT x.OrderItemID, x.RemainingOpenQty, i.ReceiveItemID, i.AvailableQTY, 1 AS Priority
    FROM x JOIN inv_unpicked i
      ON i.ItemIDStr = x.ItemIDStr
     AND ((i.Qual_N = x.Qual_N) OR (i.Qual_N IS NULL AND x.Qual_N IS NULL))
    WHERE x.RemainingOpenQty > 0 AND ISNULL(i.AvailableQTY,0) > 0
  ),
  cand_t2 AS (
    SELECT x.OrderItemID, x.RemainingOpenQty, i.ReceiveItemID, i.AvailableQTY, 2 AS Priority
    FROM x JOIN inv_unpicked i
      ON i.SKU_N = x.SKU_N
     AND ((i.Qual_N = x.Qual_N) OR (i.Qual_N IS NULL AND x.Qual_N IS NULL))
    WHERE x.RemainingOpenQty > 0 AND ISNULL(i.AvailableQTY,0) > 0
  ),
  cand_t3 AS (
    SELECT x.OrderItemID, x.RemainingOpenQty, i.ReceiveItemID, i.AvailableQTY, 3 AS Priority
    FROM x JOIN inv_unpicked i ON i.SKU_N = x.SKU_N
    WHERE x.RemainingOpenQty > 0
      AND ISNULL(i.AvailableQTY,0) > 0
      AND NOT EXISTS (SELECT 1 FROM cand_t1 t WHERE t.OrderItemID = x.OrderItemID)
      AND NOT EXISTS (SELECT 1 FROM cand_t2 t WHERE t.OrderItemID = x.OrderItemID)
  ),
  cand AS (
    SELECT * FROM cand_t1
    UNION ALL
    SELECT * FROM cand_t2
    UNION ALL
    SELECT * FROM cand_t3
  ),
  pick AS (
    SELECT TOP (1)
      c.OrderItemID,
      c.ReceiveItemID,
      CASE WHEN c.RemainingOpenQty >= c.AvailableQTY THEN c.AvailableQTY ELSE c.RemainingOpenQty END AS AllocQty,
      c.Priority
    FROM cand c
    ORDER BY c.OrderItemID, c.Priority ASC, c.AvailableQTY DESC
  )
  INSERT INTO SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
  SELECT OrderItemID, ReceiveItemID, AllocQty FROM pick;

  IF @@ROWCOUNT = 0 BREAK;

  SET @iters += 1;
  IF @iters >= @maxIters BREAK;

  IF NOT EXISTS (
    SELECT 1
    FROM x
    OUTER APPLY (
      SELECT SUM(ISNULL(sa.SuggAllocQty,0)) AS SumSuggAllocQty
      FROM SuggAlloc sa WHERE sa.OrderItemID = x.OrderItemID
    ) z
    WHERE (x.OrderedQTY - ISNULL(z.SumSuggAllocQty,0)) > 0
  )
    BREAK;
END;
    `);

    const summary = await pool.request().query(`
      SELECT od.OrderID, od.OrderItemID, od.SKU, od.OrderedQTY,
             ISNULL(x.Alloc,0) AS Allocated,
             (od.OrderedQTY - ISNULL(x.Alloc,0)) AS Remaining
      FROM OrderDetails od
      LEFT JOIN (
        SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS Alloc
        FROM SuggAlloc GROUP BY OrderItemID
      ) x ON x.OrderItemID = od.OrderItemID
      WHERE od.OrderItemID IN (${lineIds.join(",")})
      ORDER BY od.OrderID, od.OrderItemID;
    `);

    return res.json({ ok: true, allocated: summary.recordset.length, summary: summary.recordset });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

/** POST /push
 *  Accepts either:
 *   - { orderIds: number[], forceMethod?: "auto"|"put"|"post" }
 *   - { orderId:  number,   forceMethod?: "auto"|"put"|"post" }
 */
r.post("/push", async (req, res) => {
  try {
    let ids = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((n) => toInt(n)).filter(Boolean)
      : [];
    const singleId = toInt(req.body?.orderId, 0);
    if (!ids.length && singleId) ids = [singleId];

    if (!ids.length) {
      return res.status(400).json({ ok: false, message: "orderIds or orderId required" });
    }

    const forceMethod = String(req.body?.forceMethod || "auto").toLowerCase();
    const isValidMethod = (m) => m === "auto" || m === "put" || m === "post";

    const base = trimBase(
      process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com"
    );
    const headers = await authHeaders();
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    headers["Accept"] = headers["Accept"] || "application/json";

    const pool = await getPool();
    const results = [];

    for (const oid of ids) {
      const allocs = await pool
        .request()
        .input("OrderID", sql.Int, oid)
        .query(`
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

      if (payload.allocations.length === 0) {
        results.push({
          orderId: oid,
          ok: false,
          status: 204,
          reason: "No allocations to push (SuggAlloc empty)",
          sentAllocations: 0,
        });
        continue;
      }

      const sendAllocator = async (method) => {
        const url = `${base}/orders/${oid}/allocator`;
        const resp = await axios({
          url,
          method,
          headers,
          data: payload,
          timeout: 30000,
          validateStatus: () => true,
        });
        let body = resp.data;
        let summary = "";
        if (body && typeof body === "object") {
          const keys = Object.keys(body).slice(0, 6).join(", ");
          summary = `keys: ${keys}`;
          if (Array.isArray(body.errors) && body.errors.length) {
            summary += `; errors: ${body.errors.length}`;
          }
          if (Array.isArray(body.warnings) && body.warnings.length) {
            summary += `; warnings: ${body.warnings.length}`;
          }
        } else if (typeof body === "string") {
          summary = body.slice(0, 140);
        }
        return { status: resp.status, summary };
      };

      let attempt;
      if (isValidMethod(forceMethod) && forceMethod !== "auto") {
        attempt = await sendAllocator(forceMethod);
      } else {
        attempt = await sendAllocator("put");
        if ([404, 405, 501].includes(attempt.status)) {
          const fallback = await sendAllocator("post");
          if (fallback.status >= 200 && fallback.status < 300) {
            attempt = { ...fallback, triedFallback: true, primaryStatus: attempt.status };
          } else {
            attempt = { ...attempt, fallbackStatus: fallback.status, fallbackSummary: fallback.summary };
          }
        }
      }

      const ok = attempt.status >= 200 && attempt.status < 300;
      const noOp =
        ok &&
        (attempt.status === 204 ||
          attempt.summary === "" ||
          /no\s+change|no\s+alloc/i.test(attempt.summary || ""));

      results.push({
        orderId: oid,
        ok: ok && !noOp,
        status: attempt.status,
        triedFallback: attempt.triedFallback || false,
        primaryStatus: attempt.primaryStatus,
        forcedMethod: forceMethod !== "auto" ? forceMethod : undefined,
        sentAllocations: payload.allocations.length,
        responseSummary: attempt.summary,
      });
    }

    const anyReal = results.some((r0) => r0.ok === true);
    const hint = anyReal
      ? null
      : "No effective changes detected. Check SuggAlloc rows and endpoint method (PUT vs POST) for your tenant.";

    res.json({ ok: true, results, hint });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message,
      data: e.response?.data || null,
    });
  }
});

/* ======================= INVENTORY HELPERS ======================= */

/* ----------------------- POST /inventory/by-skus ----------------------- */
r.post("/inventory/by-skus", async (req, res) => {
  try {
    const skus = Array.isArray(req.body?.skus) ? req.body.skus : [];
    if (!skus.length) return res.json({ ok: true, items: [] });

    const skuList = skus
      .map((v) => `'${String(v).trim().toUpperCase().replace(/'/g, "''")}'`)
      .join(",");

    const pool = await getPool();
    const rows = await pool.request().query(`
      WITH invx AS (
        SELECT
          inv.SKU,
          NULLIF(UPPER(LTRIM(RTRIM(inv.Qualifier))),'') AS Qualifier,
          inv.ReceiveItemID,
          inv.ReceivedQty,
          inv.AvailableQTY,
          inv.LocationName
        FROM Inventory inv
        WHERE UPPER(LTRIM(RTRIM(inv.SKU))) IN (${skuList})
      )
      SELECT SKU, Qualifier, ReceiveItemID, ReceivedQty, AvailableQTY, LocationName
      FROM invx
      ORDER BY SKU, AvailableQTY DESC;
    `);

    res.json({ ok: true, items: rows.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/* ----------------------- POST /batch/inventory-debug ----------------------- */
r.post("/batch/inventory-debug", async (req, res) => {
  try {
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((n) => (Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : 0)).filter(Boolean)
      : [];
    if (!orderIds.length) return res.status(400).json({ ok: false, message: "orderIds required" });

    const pool = await getPool();
    const data = await pool.request().query(`
      ;WITH odx AS (
        SELECT
          od.OrderID,
          od.OrderItemID,
          od.OrderedQTY,
          UPPER(LTRIM(RTRIM(od.SKU)))                  AS SKU_N,
          NULLIF(UPPER(LTRIM(RTRIM(od.Qualifier))),'') AS Qual_N,
          UPPER(LTRIM(RTRIM(CAST(od.ItemID AS VARCHAR(128))))) AS ItemIDStr
        FROM OrderDetails od
        WHERE od.OrderID IN (${orderIds.join(",")})
      ),
      invx AS (
        SELECT
          inv.ReceiveItemID,
          UPPER(LTRIM(RTRIM(inv.SKU)))                  AS SKU_N,
          NULLIF(UPPER(LTRIM(RTRIM(inv.Qualifier))),'') AS Qual_N,
          UPPER(LTRIM(RTRIM(CAST(inv.ItemID AS VARCHAR(128))))) AS ItemIDStr,
          inv.AvailableQTY
        FROM Inventory inv
      )
      SELECT
        o.OrderID,
        o.OrderItemID,
        o.SKU_N,
        o.Qual_N,
        o.OrderedQTY,
        (SELECT COUNT(*) FROM invx i WHERE i.ItemIDStr = o.ItemIDStr AND ((i.Qual_N = o.Qual_N) OR (i.Qual_N IS NULL AND o.Qual_N IS NULL)) AND ISNULL(i.AvailableQTY,0) > 0) AS T1_ItemIdQual,
        (SELECT COUNT(*) FROM invx i WHERE i.SKU_N  = o.SKU_N   AND ((i.Qual_N = o.Qual_N) OR (i.Qual_N IS NULL AND o.Qual_N IS NULL)) AND ISNULL(i.AvailableQTY,0) > 0) AS T2_SkuQual,
        (SELECT COUNT(*) FROM invx i WHERE i.SKU_N  = o.SKU_N   AND ISNULL(i.AvailableQTY,0) > 0) AS T3_SkuAnyQual
      FROM odx o
      ORDER BY o.OrderID, o.OrderItemID;
    `);

    res.json({ ok: true, lines: data.recordset });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

export default r;
