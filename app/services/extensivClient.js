// helpers (keep if you already have similar ones)
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const s = (v, max) => (v == null ? null : String(v).normalize("NFC").slice(0, max));
const toInt = (v, def = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : def);

function ro(o) { return o?.readOnly || o?.ReadOnly || {}; }
function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj?.ResourceList)) return obj.ResourceList;
  const hal = obj?._embedded?.["http://api.3plCentral.com/rels/orders/order"];
  if (Array.isArray(hal)) return hal;
  if (Array.isArray(obj?.data)) return obj.data;
  for (const v of Object.values(obj || {})) if (Array.isArray(v)) return v;
  return [];
}
function itemsFromOrder(ord) {
  const em = ord?._embedded;
  if (em && Array.isArray(em["http://api.3plCentral.com/rels/orders/item"]))
    return em["http://api.3plCentral.com/rels/orders/item"];
  if (Array.isArray(ord?.OrderItems)) return ord.OrderItems;
  if (Array.isArray(ord?.Items)) return ord.Items;
  return [];
}

async function listOrdersPage({ base, headers, pgsiz = 100, pgnum = 1 }) {
  const { data } = await axios.get(`${base}/orders`, {
    headers,
    params: { pgsiz, pgnum, detail: "OrderItems", itemdetail: "All" },
    timeout: 30000,
  });
  return data;
}

/* build records for the dbo.OrderDetails columns you showed */
function buildRowsForOrderDetails(ord) {
  const R = [];
  const r = ro(ord);
  // Only open / not closed orders
  if (r.isClosed === true) return R;

  const orderId = r.orderId ?? r.OrderId ?? ord.orderId ?? ord.OrderId;
  const cust    = r.customerIdentifier || ord.customerIdentifier || {};
  const refNum  = ord.referenceNum ?? "";

  for (const it of itemsFromOrder(ord)) {
    const ir = ro(it);
    // Only unallocated lines
    if (ir.fullyAllocated === true) continue;

    const orderItemId = ir.orderItemId ?? ir.OrderItemId ?? it.orderItemId ?? it.OrderItemId;
    const sku         = it?.itemIdentifier?.sku ?? it?.ItemIdentifier?.Sku ?? it?.sku ?? it?.SKU;
    const itemId      = it?.itemIdentifier?.id  ?? it?.ItemIdentifier?.Id  ?? null;
    const unit        = ir.unitIdentifier || it.unitIdentifier || {};
    const qualifier   = it?.qualifier ?? it?.Qualifier ?? "";
    const qty         = toInt(it?.qty ?? it?.Qty ?? it?.OrderedQty ?? it?.orderedQty, 0);

    // essential keys must exist
    if (!orderItemId || !orderId || !sku) continue;

    R.push({
      OrderItemID:  toInt(orderItemId, 0),
      OrderID:      toInt(orderId, 0),
      CustomerName: s(cust.name, 200) || "",
      CustomerID:   toInt(cust.id, 0),
      ItemID:       s(itemId ?? sku, 150),   // fallback to SKU if numeric id missing
      SKU:          s(sku, 150),
      UnitID:       toInt(unit.id, 0),
      UnitName:     s(unit.name, 80) || "",
      Qualifier:    s(qualifier, 80) || "",
      OrderedQTY:   toInt(qty, 0),
      ReferenceNum: s(refNum, 120) || "",
    });
  }
  return R;
}

/* single-row upsert with exact column names from your table */
async function upsertOrderDetailExact(pool, rec) {
  const req = pool.request();
  req.input("OrderItemID",  sql.Int,         rec.OrderItemID);
  req.input("OrderID",      sql.Int,         rec.OrderID);
  req.input("CustomerName", sql.VarChar(200),rec.CustomerName);
  req.input("CustomerID",   sql.Int,         rec.CustomerID);
  req.input("ItemID",       sql.VarChar(150),rec.ItemID);
  req.input("SKU",          sql.VarChar(150),rec.SKU);
  req.input("UnitID",       sql.Int,         rec.UnitID);
  req.input("UnitName",     sql.VarChar(80), rec.UnitName);
  req.input("Qualifier",    sql.VarChar(80), rec.Qualifier);
  req.input("OrderedQTY",   sql.Int,         rec.OrderedQTY);
  req.input("ReferenceNum", sql.VarChar(120),rec.ReferenceNum);

  await req.query(`
IF EXISTS (SELECT 1 FROM dbo.OrderDetails WITH (UPDLOCK, HOLDLOCK) WHERE OrderItemID=@OrderItemID)
  UPDATE dbo.OrderDetails
     SET OrderID=@OrderID,
         CustomerName=@CustomerName,
         CustomerID=@CustomerID,
         ItemID=@ItemID,
         SKU=@SKU,
         UnitID=@UnitID,
         UnitName=@UnitName,
         Qualifier=@Qualifier,
         OrderedQTY=@OrderedQTY,
         ReferenceNum=@ReferenceNum
   WHERE OrderItemID=@OrderItemID;
ELSE
  INSERT INTO dbo.OrderDetails
    (OrderItemID, OrderID, CustomerName, CustomerID, ItemID, SKU, UnitID, UnitName, Qualifier, OrderedQTY, ReferenceNum)
  VALUES
    (@OrderItemID,@OrderID,@CustomerName,@CustomerID,@ItemID,@SKU,@UnitID,@UnitName,@Qualifier,@OrderedQTY,@ReferenceNum);
`);
}

/* ============ MAIN: import only open + not-fully-allocated ============ */
export async function fetchAndUpsertOrders({ maxPages = 20, pageSize = 200 } = {}) {
  const pool    = await getPool();
  const base    = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  let importedHeaders = 0;
  let upsertedItems   = 0;
  const errors        = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    let pageData;
    try {
      pageData = await listOrdersPage({ base, headers, pgsiz: pageSize, pgnum: pg });
    } catch (e) {
      return { ok: false, importedHeaders, upsertedItems, message: `GET /orders failed page ${pg}: ${e.message}` };
    }

    const allOrders = firstArray(pageData);
    if (!allOrders.length) break;

    // keep only open + NOT fully allocated orders
    const orders = allOrders.filter(o => {
      const r = ro(o);
      return r.isClosed !== true && r.fullyAllocated !== true;
    });

    importedHeaders += orders.length;

    // flatten rows for this page
    const rows = [];
    for (const ord of orders) rows.push(...buildRowsForOrderDetails(ord));

    // de-dupe by OrderItemID
    const seen = new Set();
    const unique = rows.filter(r => {
      if (seen.has(r.OrderItemID)) return false;
      seen.add(r.OrderItemID);
      return true;
    });

    // upsert one-by-one so a bad row doesn’t nuke the batch
    for (const rec of unique) {
      try {
        await upsertOrderDetailExact(pool, rec);
        upsertedItems++;
      } catch (e) {
        errors.push({ orderItemId: rec.OrderItemID, message: e.message, number: e.number, code: e.code, state: e.state, class: e.class, lineNumber: e.lineNumber });
      }
    }

    if (allOrders.length < pageSize) break; // last page
  }

  return errors.length
    ? { ok: false, importedHeaders, upsertedItems, errors }
    : { ok: true,  importedHeaders, upsertedItems };
}
