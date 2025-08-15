import { Router } from "express";
import axios from "axios";
import * as dbMod from "../services/db/mssql.js";
import * as extMod from "../services/extensivClient.js";

const db = dbMod.default ?? dbMod;
const ext = extMod.default ?? extMod;

const r = Router();
const getPool = db.getPool;

// helper
const trimBase = (u) => (u || "").replace(/\/+$/, "");

// ---- UI page ---------------------------------------------------------
r.get("/ui", (_req, res) => {
  res.type("html").send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Allocate Orders</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:20px}
  .row{display:flex;gap:8px;align-items:center;margin-bottom:12px}
  input[type=search]{padding:8px 10px;border:1px solid #ccc;border-radius:6px;min-width:280px}
  button{padding:8px 12px;border:1px solid #333;background:#111;color:#fff;border-radius:6px;cursor:pointer}
  button.secondary{background:#eee;color:#111;border-color:#bbb}
  table{border-collapse:collapse;width:100%;margin-top:12px}
  th,td{border:1px solid #ddd;padding:6px 8px;font-size:14px}
  th{background:#f6f6f6;text-align:left}
  .tag{font-size:12px;padding:2px 6px;border-radius:4px;border:1px solid #ddd;background:#fafafa}
</style>
</head>
<body>
  <h2>Select Order Lines To Allocate</h2>
  <div class="row">
    <input id="q" type="search" placeholder="Search Order # (exact or partial)" />
    <button id="btnSearch">Search</button>
    <span id="status" class="tag"></span>
  </div>

  <div id="results"></div>

  <div class="row">
    <button class="secondary" id="btnImport">Import from Extensiv</button>
    <button id="btnPlan">Run SQL Allocation</button>
    <button id="btnPush">Push to Extensiv</button>
  </div>

<script>
const elQ = document.getElementById('q');
const elStatus = document.getElementById('status');
const elResults = document.getElementById('results');

function setStatus(t){ elStatus.textContent = t || ''; }

async function search() {
  setStatus('Searching…');
  const q = elQ.value.trim();
  const r = await fetch('/alloc/search?q=' + encodeURIComponent(q));
  const data = await r.json();
  setStatus(data.ok ? 'Found ' + data.orders.length + ' order(s)' : 'Search error');
  if (!data.ok) { elResults.innerHTML = '<pre>'+JSON.stringify(data,null,2)+'</pre>'; return; }

  // render orders list
  let html = '';
  for (const o of data.orders) {
    html += \`
      <details open>
        <summary><strong>Order #\${o.OrderID}</strong> — \${o.CustomerName || ''} — Ref \${o.ReferenceNum || ''}</summary>
        <div id="lines-\${o.OrderID}">Loading lines…</div>
      </details>\`;
    // fetch lines
    fetch('/alloc/lines?orderId=' + o.OrderID)
      .then(r => r.json())
      .then(j => {
        const div = document.getElementById('lines-'+o.OrderID);
        if (!j.ok) { div.innerHTML = '<pre>'+JSON.stringify(j,null,2)+'</pre>'; return; }
        let rows = j.lines.map(l => \`
          <tr>
            <td><input type="checkbox" class="chk" data-oi="\${l.OrderItemID}" data-oid="\${o.OrderID}" \${l.RemainingOpenQty>0?'checked':''}></td>
            <td>\${l.OrderItemID}</td>
            <td>\${l.SKU || ''}</td>
            <td>\${l.Qualifier || ''}</td>
            <td>\${l.OrderedQTY}</td>
            <td>\${l.AllocatedSoFar}</td>
            <td><strong>\${l.RemainingOpenQty}</strong></td>
          </tr>\`).join('');
        div.innerHTML = \`
          <table>
            <thead><tr>
              <th>Select</th><th>OrderItemID</th><th>SKU</th><th>Qualifier</th>
              <th>Ordered</th><th>Planned</th><th>Remaining</th>
            </tr></thead>
            <tbody>\${rows}</tbody>
          </table>\`;
      });
  }
  elResults.innerHTML = html || '<em>No results.</em>';
}

document.getElementById('btnSearch').onclick = search;

document.getElementById('btnImport').onclick = async () => {
  setStatus('Importing open/unallocated…');
  const r = await fetch('/extensiv/import', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ openOnly:true, maxPages:10, pageSize:200 })});
  const j = await r.json();
  setStatus(j.ok ? 'Imported '+j.importedHeaders+' / upserted '+j.upsertedItems : 'Import error');
};

function getSelected() {
  return Array.from(document.querySelectorAll('input.chk:checked')).map(c => ({ orderId: Number(c.dataset.oid), orderItemId: Number(c.dataset.oi) }));
}

document.getElementById('btnPlan').onclick = async () => {
  const sel = getSelected();
  if (!sel.length) { alert('Select one or more lines.'); return; }
  setStatus('Planning allocation…');
  const r = await fetch('/alloc/plan', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ selected: sel })});
  const j = await r.json();
  setStatus(j.ok ? ('Planned '+j.rowsAffected+' rows in SuggAlloc') : 'Plan error');
  // refresh lines display
  const oids = [...new Set(sel.map(x => x.orderId))];
  for (const oid of oids) {
    const div = document.getElementById('lines-'+oid);
    if (div) {
      const rr = await fetch('/alloc/lines?orderId='+oid); const jj = await rr.json();
      if (jj.ok) {
        let rows = jj.lines.map(l => \`
          <tr>
            <td><input type="checkbox" class="chk" data-oi="\${l.OrderItemID}" data-oid="\${oid}" \${l.RemainingOpenQty>0?'checked':''}></td>
            <td>\${l.OrderItemID}</td><td>\${l.SKU||''}</td><td>\${l.Qualifier||''}</td>
            <td>\${l.OrderedQTY}</td><td>\${l.AllocatedSoFar}</td><td><strong>\${l.RemainingOpenQty}</strong></td>
          </tr>\`).join('');
        div.innerHTML = \`<table><thead><tr>
          <th>Select</th><th>OrderItemID</th><th>SKU</th><th>Qualifier</th><th>Ordered</th><th>Planned</th><th>Remaining</th>
        </tr></thead><tbody>\${rows}</tbody></table>\`;
      }
    }
  }
};

document.getElementById('btnPush').onclick = async () => {
  const sel = getSelected();
  if (!sel.length) { alert('Select one or more lines.'); return; }
  const orderId = sel[0].orderId; // assume same order
  setStatus('Pushing allocation to Extensiv…');
  const r = await fetch('/alloc/push', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ orderId, selected: sel })});
  const j = await r.json();
  setStatus(j.ok ? 'Extensiv allocation OK' : ('Push error: '+(j.message||'')));
};
</script>
</body>
</html>
  `);
});

// ---- API: search orders by Order # (from SQL) --------------------------
r.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const pool = await getPool();
    const rs = await pool.request()
      .input("q", db.sql.VarChar(50), "%" + q + "%")
      .query(`
        SELECT DISTINCT TOP (50)
          OrderID,
          MAX(CustomerName)   AS CustomerName,
          MAX(ReferenceNum)   AS ReferenceNum
        FROM dbo.OrderDetails
        WHERE CAST(OrderID AS VARCHAR(50)) LIKE @q
        ORDER BY OrderID DESC
      `);
    res.json({ ok: true, orders: rs.recordset });
  } catch (e) {
    res.status(500).json({ ok:false, message:e.message });
  }
});

// ---- API: lines for an order + remaining qty ---------------------------
r.get("/lines", async (req, res) => {
  try {
    const orderId = Number(req.query.orderId);
    if (!orderId) return res.status(400).json({ ok:false, message:"orderId required" });
    const pool = await getPool();
    const rs = await pool.request()
      .input("oid", db.sql.Int, orderId)
      .query(`
        WITH SA AS (
          SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSugg
          FROM dbo.SuggAlloc GROUP BY OrderItemID
        )
        SELECT
          d.OrderItemID, d.OrderID, d.SKU, d.Qualifier, d.OrderedQTY,
          ISNULL(sa.SumSugg,0) AS AllocatedSoFar,
          (ISNULL(d.OrderedQTY,0) - ISNULL(sa.SumSugg,0)) AS RemainingOpenQty
        FROM dbo.OrderDetails d
        LEFT JOIN SA sa ON sa.OrderItemID = d.OrderItemID
        WHERE d.OrderID=@oid
        ORDER BY d.OrderItemID ASC;
      `);
    res.json({ ok:true, lines: rs.recordset });
  } catch (e) {
    res.status(500).json({ ok:false, message:e.message });
  }
});

// ---- API: run the SQL allocator for selected lines ---------------------
r.post("/plan", async (req, res) => {
  try {
    const selected = Array.isArray(req.body?.selected) ? req.body.selected : [];
    if (!selected.length) return res.status(400).json({ ok:false, message:"selected[] required" });

    const orderItemIds = [...new Set(selected.map(x => Number(x.orderItemId)).filter(Boolean))];
    const pool = await getPool();

    // Clear existing plan for these lines
    await pool.request()
      .query(`DELETE dbo.SuggAlloc WHERE OrderItemID IN (${orderItemIds.join(",")})`);

    // Your allocator, scoped to the selected OrderItemIDs
    const sqlText = `
DECLARE @Work TABLE (OrderItemID INT PRIMARY KEY);
INSERT INTO @Work(OrderItemID) VALUES ${orderItemIds.map(id => `(${id})`).join(",")};

DECLARE @RemainingOpenQty INT = 1;

WHILE @RemainingOpenQty > 0
BEGIN
  INSERT INTO dbo.SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
  SELECT TOP 1
    a.OrderItemID, b.ReceiveItemID,
    CASE WHEN (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY THEN b.AvailableQTY
         ELSE (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) END AS AllocQty
  FROM dbo.OrderDetails a
  JOIN @Work w ON w.OrderItemID = a.OrderItemID
  LEFT JOIN dbo.Inventory b
         ON a.ItemID = b.ItemID AND ISNULL(a.Qualifier,'') = ISNULL(b.Qualifier,'')
  LEFT JOIN (
    SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
    FROM dbo.SuggAlloc GROUP BY OrderItemID
  ) c ON a.OrderItemID = c.OrderItemID
  WHERE b.ReceiveItemID NOT IN (SELECT DISTINCT ReceiveItemID FROM dbo.SuggAlloc)
    AND b.AvailableQTY > 0
    AND (a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)) > 0
  ORDER BY
    a.OrderItemID ASC,
    CASE
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) = b.AvailableQTY THEN 1
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) = b.AvailableQTY THEN 2
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >  b.AvailableQTY THEN 3
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >  b.AvailableQTY THEN 4
      WHEN b.ReceivedQty > b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY THEN 5
      WHEN b.ReceivedQty > b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY THEN 6
      WHEN SUBSTRING(b.LocationName,4,1) = 'A'  AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) <= b.AvailableQTY THEN 7
      WHEN SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) <= b.AvailableQTY THEN 8
    END ASC,
    CASE WHEN (CASE
      WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) IN ('A') THEN 1
      WHEN b.ReceivedQty = b.AvailableQty THEN 2
      ELSE 3 END) IN (1,2,3) THEN b.AvailableQTY + 0 ELSE (999999 - b.AvailableQTY) END DESC;

  SELECT TOP 1 @RemainingOpenQty = ISNULL(a.OrderedQTY - ISNULL(x.SumSugg,0), 0)
  FROM dbo.OrderDetails a
  JOIN @Work w ON w.OrderItemID = a.OrderItemID
  OUTER APPLY (
    SELECT SUM(ISNULL(SuggAllocQty,0)) AS SumSugg FROM dbo.SuggAlloc WHERE OrderItemID = a.OrderItemID
  ) x;
END
`;
    const result = await pool.request().query(sqlText);
    res.json({ ok:true, rowsAffected: result.rowsAffected?.reduce((a,b)=>a+b,0) || 0 });
  } catch (e) {
    res.status(500).json({ ok:false, message:e.message });
  }
});

// ---- API: push SuggAlloc -> Extensiv for an order -----------------------
r.post("/push", async (req, res) => {
  try {
    const orderId = Number(req.body?.orderId);
    const selected = Array.isArray(req.body?.selected) ? req.body.selected : [];
    if (!orderId || !selected.length) return res.status(400).json({ ok:false, message:"orderId and selected[] required" });

    const itemIds = [...new Set(selected.map(x => Number(x.orderItemId)).filter(Boolean))];

    const pool = await getPool();
    const rs = await pool.request()
      .query(`
        SELECT OrderItemID, ReceiveItemID, SuggAllocQty
        FROM dbo.SuggAlloc
        WHERE OrderItemID IN (${itemIds.join(",")})
        ORDER BY OrderItemID, ReceiveItemID;
      `);

    // group per orderItemId
    const byItem = new Map();
    for (const row of rs.recordset) {
      if (!byItem.has(row.OrderItemID)) byItem.set(row.OrderItemID, []);
      byItem.get(row.OrderItemID).push({ receiveItemId: row.ReceiveItemID, qty: row.SuggAllocQty });
    }
    const payload = {
      proposedAllocations: Array.from(byItem.entries()).map(([orderItemId, list]) => ({
        orderItemId,
        proposedAllocations: list
      }))
    };

    // call Extensiv /orders/{orderId}/allocator
    const headers = await (ext.authHeaders?.() ?? (async ()=> {
      // fallback to basic header if service not exporting (shouldn't happen)
      const b64 = process.env.EXT_BASIC_AUTH_B64 || "";
      return {
  Authorization: b64 ? `Basic ${b64}` : "",
  Accept: "application/hal+json, application/json",
  "Content-Type": "application/hal+json; charset=utf-8"
};
    })());
    const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");

    const resp = await axios.put(\`\${base}/orders/\${orderId}/allocator\`, payload, {
      headers, timeout: 30000, validateStatus: () => true
    });

    if (resp.status >= 200 && resp.status < 300) {
      return res.json({ ok:true, status: resp.status, payloadSent: payload });
    }
    res.status(502).json({ ok:false, status: resp.status, data: resp.data });
  } catch (e) {
    res.status(500).json({ ok:false, message:e.message });
  }
});

export default r;
