// src/app/routes/extensiv.js
import { Router } from "express";
import axios from "axios";
import { authHeaders, fetchAndUpsertOrders, fetchOneOrderDetail } from "../services/extensivClient.js";
import { getPool } from "../services/db/mssql.js";
// --- SEARCH + LINES + RUN SQL ALLOC ---
import { runSqlAllocation } from "../services/sqlAllocator.js";
import { getPool } from "../services/db/mssql.js";

// Search orders by a loose string (casts OrderId to varchar to allow partial)
r.get("/orders/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ ok: true, results: [] });

    const pool = await getPool();
    const rs = await pool.request()
      .input("q", sql.VarChar(50), `%${q}%`)
      .query(`
        SELECT TOP (50)
          OrderId,
          COUNT(*)        AS lineCount,
          SUM(OrderedQTY) AS totalQty
        FROM dbo.OrderDetails
        WHERE CAST(OrderId AS VARCHAR(50)) LIKE @q
        GROUP BY OrderId
        ORDER BY OrderId DESC
      `);

    res.json({ ok: true, results: rs.recordset });
  } catch (e) { next(e); }
});

// Get lines for a specific order
r.get("/orders/:orderId/lines", async (req, res, next) => {
  try {
    const orderId = Number(req.params.orderId);
    if (!orderId) return res.status(400).json({ ok: false, message: "Invalid orderId" });

    const pool = await getPool();
    const rs = await pool.request()
      .input("OrderId", sql.Int, orderId)
      .query(`
        SELECT OrderItemID,
               COALESCE(NULLIF(LTRIM(RTRIM(SKU)), ''), NULLIF(LTRIM(RTRIM(ItemID)), '')) AS SKU,
               Qualifier,
               OrderedQTY
        FROM dbo.OrderDetails
        WHERE OrderId = @OrderId
        ORDER BY OrderItemID
      `);

    res.json({ ok: true, orderId, lines: rs.recordset });
  } catch (e) { next(e); }
});

// Run the SQL allocation (your script) for the order / selected lines
r.post("/orders/:orderId/alloc/sql", async (req, res, next) => {
  try {
    const orderId = Number(req.params.orderId);
    const selected = Array.isArray(req.body?.orderItemIds) ? req.body.orderItemIds : [];
    const out = await runSqlAllocation(orderId, selected);
    res.json(out);
  } catch (e) { next(e); }
});


const r = Router();

const trimBase = (u) => (u || "").replace(/\/+$/, "");
const firstArray = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.ResourceList)) return data.ResourceList;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?._embedded?.["http://api.3plCentral.com/rels/orders/order"]))
    return data._embedded["http://api.3plCentral.com/rels/orders/order"];
  for (const v of Object.values(data || {})) if (Array.isArray(v)) return v;
  return [];
};

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

r.post("/import", async (req, res, next) => {
  try {
    const result = await fetchAndUpsertOrders(req.body || {});
    res.json(result);
  } catch (e) {
    next(e);
  }
});

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
    OrderItemID INT NULL,
    OrderId     INT NULL,
    ItemID      VARCHAR(100) NULL,
    Qualifier   VARCHAR(50) NULL,
    OrderedQTY  INT NULL
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
r.get("/alloc-ui", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>SQL Allocation Runner</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
    input[type="text"]{ padding:8px; width:280px; }
    button{ padding:8px 12px; cursor:pointer; }
    table{ border-collapse: collapse; margin-top:12px; width: 100%; }
    th, td{ border:1px solid #ddd; padding:6px 8px; }
    th{ background:#f6f6f6; text-align:left; }
    .muted{ color:#666; font-size:12px; }
    .row { display:flex; gap:8px; align-items:center; margin: 8px 0; }
    .pill{ background:#eef; border-radius:9999px; padding:2px 8px; font-size:12px; }
    .ok { color: #056; }
    .err{ color:#b00; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h2>SQL Allocation Runner</h2>

  <div class="row">
    <input id="q" type="text" placeholder="Search Order #" />
    <button onclick="search()">Search</button>
    <span class="muted">Type full or partial order id</span>
  </div>

  <div id="orders"></div>
  <div id="lines"></div>
  <div id="run"></div>
  <div id="result"></div>

<script>
let currentOrderId = null;
let selected = new Set();

async function search(){
  const q = document.getElementById('q').value.trim();
  document.getElementById('orders').innerHTML = 'Searching...';
  const r = await fetch('/extensiv/orders/search?q=' + encodeURIComponent(q));
  const j = await r.json();
  if(!j.ok){ document.getElementById('orders').innerHTML = '<div class="err">Search failed</div>'; return; }
  const rows = j.results || [];
  if(!rows.length){ document.getElementById('orders').innerHTML = '<div>No matches</div>'; return; }
  const html = ['<table><thead><tr><th>OrderId</th><th>Lines</th><th>Total Qty</th><th></th></tr></thead><tbody>'];
  for(const row of rows){
    html.push('<tr><td>'+row.OrderId+'</td><td>'+row.lineCount+'</td><td>'+row.totalQty+'</td>'+
      '<td><button onclick="loadLines('+row.OrderId+')">Open</button></td></tr>');
  }
  html.push('</tbody></table>');
  document.getElementById('orders').innerHTML = html.join('');
  document.getElementById('lines').innerHTML = '';
  document.getElementById('run').innerHTML = '';
  document.getElementById('result').innerHTML = '';
}

async function loadLines(orderId){
  currentOrderId = orderId;
  selected = new Set();
  document.getElementById('lines').innerHTML = 'Loading lines...';
  const r = await fetch('/extensiv/orders/'+orderId+'/lines');
  const j = await r.json();
  if(!j.ok){ document.getElementById('lines').innerHTML = '<div class="err">Failed to load lines</div>'; return; }
  const lines = j.lines || [];
  const rows = ['<table><thead><tr><th>Select</th><th>OrderItemID</th><th>SKU</th><th>Qualifier</th><th>OrderedQTY</th></tr></thead><tbody>'];
  for(const ln of lines){
    rows.push('<tr>'+
      '<td><input type="checkbox" onchange="toggleSel('+ln.OrderItemID+', this.checked)"/></td>'+
      '<td>'+ln.OrderItemID+'</td>'+
      '<td>'+ (ln.SKU || '') +'</td>'+
      '<td>'+ (ln.Qualifier || '') +'</td>'+
      '<td>'+ln.OrderedQTY+'</td>'+
    '</tr>');
  }
  rows.push('</tbody></table>');
  document.getElementById('lines').innerHTML = '<div class="pill">Order '+orderId+'</div>' + rows.join('');
  document.getElementById('run').innerHTML = '<div class="row"><button onclick="runAlloc()">Run SQL Allocation</button><span class="muted">Runs into dbo.SuggAlloc</span></div>';
  document.getElementById('result').innerHTML = '';
}

function toggleSel(id, on){ if(on) selected.add(id); else selected.delete(id); }

async function runAlloc(){
  if(!currentOrderId){ alert('Pick an order first'); return; }
  const ids = Array.from(selected.values());
  document.getElementById('result').innerHTML = 'Running allocation...';
  const r = await fetch('/extensiv/orders/'+currentOrderId+'/alloc/sql', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ orderItemIds: ids })
  });
  const j = await r.json();
  if(!j.ok){ document.getElementById('result').innerHTML = '<div class="err">'+(j.message || 'Failed')+'</div>'; return; }
  const rows = j.rows || [];
  const html = ['<div class="ok">Done. '+rows.length+' suggestions.</div>',
                '<table><thead><tr><th>OrderItemID</th><th>ReceiveItemID</th><th>SuggAllocQty</th></tr></thead><tbody>'];
  for(const x of rows){
    html.push('<tr><td>'+x.OrderItemID+'</td><td>'+x.ReceiveItemID+'</td><td>'+x.SuggAllocQty+'</td></tr>');
  }
  html.push('</tbody></table>');
  document.getElementById('result').innerHTML = html.join('');
}
</script>
</body>
</html>`);
});

export default r;
