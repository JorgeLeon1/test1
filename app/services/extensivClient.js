// src/app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

/* --------------------- tiny helpers --------------------- */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const s = (v, n, d = "") => (v == null ? d : String(v).normalize("NFC").slice(0, n));
const i = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const ro = (o) => o?.readOnly || o?.ReadOnly || {};

function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj?.ResourceList)) return obj.ResourceList;
  const hal = obj?._embedded?.["http://api.3plCentral.com/rels/orders/order"];
  if (Array.isArray(hal)) return hal;
  if (Array.isArray(obj?.data)) return obj.data;
  for (const v of Object.values(obj || {})) if (Array.isArray(v)) return v;
  return [];
}

function orderItems(ord) {
  const em = ord?._embedded;
  if (em && Array.isArray(em["http://api.3plCentral.com/rels/orders/item"])) {
    return em["http://api.3plCentral.com/rels/orders/item"];
  }
  if (Array.isArray(ord?.OrderItems)) return ord.OrderItems;
  if (Array.isArray(ord?.Items)) return ord.Items;
  return [];
}

/* ---------------------- auth helpers --------------------- */
function basicHeaderFromEnv() {
  const b64 = process.env.EXT_BASIC_AUTH_B64 || "";
  return b64 ? `Basic ${b64}` : null;
}

async function getBearerViaOAuth() {
  const tokenUrl = process.env.EXT_TOKEN_URL;
  if (!tokenUrl) return null;
  try {
    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");
    if (process.env.EXT_USER_LOGIN)    form.set("user_login",    process.env.EXT_USER_LOGIN);
    if (process.env.EXT_USER_LOGIN_ID) form.set("user_login_id", process.env.EXT_USER_LOGIN_ID);
    if (process.env.EXT_TPL_GUID)      form.set("tplguid",       process.env.EXT_TPL_GUID);

    const auth = basicHeaderFromEnv();
    const resp = await axios.post(tokenUrl, form, {
      headers: {
        Authorization: auth || "",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (resp.status >= 200 && resp.status < 300 && resp.data?.access_token) {
      return `Bearer ${resp.data.access_token}`;
    }
    return null;
  } catch {
    return null;
  }
}

export async function authHeaders() {
  const mode = (process.env.EXT_AUTH_MODE || "").toLowerCase();
  if (mode === "bearer") {
    const b = await getBearerViaOAuth();
    if (b) {
      return {
        Authorization: b,
        Accept: "application/hal+json, application/json",
        "Content-Type": "application/hal+json; charset=utf-8",
      };
    }
  }
  const basic = basicHeaderFromEnv();
  if (!basic) throw new Error("No auth configured: set EXT_BASIC_AUTH_B64 or EXT_TOKEN_URL (+ client id/secret).");
  return {
    Authorization: basic,
    Accept: "application/hal+json, application/json",
    "Content-Type": "application/hal+json; charset=utf-8",
  };
}

/* ---------------------- API wrappers --------------------- */
function buildOrderRql({ onlyOpen = true, onlyUnallocated = false } = {}) {
  const terms = [];
  // For RQL, status is only reliable for Canceled; use isClosed for open.
  if (onlyOpen) terms.push("readOnly.isClosed==false");
  if (onlyUnallocated) terms.push("readOnly.fullyAllocated==false");
  return terms.length ? terms.join(";") : undefined;
}

async function listOrdersPage({ base, headers, pgsiz = 100, pgnum = 1, onlyOpen = true, onlyUnallocated = false }) {
  const rql = buildOrderRql({ onlyOpen, onlyUnallocated });
  const { data } = await axios.get(`${base}/orders`, {
    headers,
    params: { pgsiz, pgnum, detail: "OrderItems", itemdetail: "All", ...(rql ? { rql } : {}) },
    timeout: 30000,
  });
  return data;
}

export async function fetchOneOrderDetail(orderId) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  try {
    const { data } = await axios.get(`${base}/orders`, {
      headers,
      params: { pgsiz: 1, pgnum: 1, detail: "OrderItems", itemdetail: "All", rql: `readOnly.orderId==${orderId}` },
      timeout: 20000,
    });
    const list = firstArray(data);
    if (list?.[0]) return list[0];
  } catch {}
  try {
    const page = await listOrdersPage({ base, headers, pgsiz: 100, pgnum: 1, onlyOpen: true });
    const list = firstArray(page);
    return list.find(o => (ro(o).orderId ?? ro(o).OrderId ?? o.orderId ?? o.OrderId) === orderId) || null;
  } catch {
    return null;
  }
}

/* ------------------ DB bootstrap / schema probe ------------------ */
async function ensureOrderDetailsBase(pool) {
  await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
BEGIN
  CREATE TABLE dbo.OrderDetails (
    OrderItemID     INT           NOT NULL PRIMARY KEY,
    OrderId         INT           NOT NULL DEFAULT(0),
    CustomerID      INT           NOT NULL DEFAULT(0),
    CustomerName    VARCHAR(200)  NOT NULL DEFAULT(''),
    -- Some DBs use ItemID, others use SKU; we will populate whichever exists (or both)
    ItemID          VARCHAR(150)  NULL,
    SKU             VARCHAR(150)  NULL,
    UnitID          INT           NULL,
    UnitName        VARCHAR(50)   NULL,
    Qualifier       VARCHAR(80)   NULL,
    OrderedQTY      INT           NOT NULL DEFAULT(0),
    ReferenceNum    VARCHAR(100)  NULL,
    ShipToAddress1  VARCHAR(200)  NULL,
    ShipToCity      VARCHAR(100)  NULL,
    ShipToState     VARCHAR(50)   NULL,
    ShipToZip       VARCHAR(20)   NULL
  );
END
`);
}

async function getOrderDetailsColumns(pool) {
  const rs = await pool.request().query(`
    SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OrderDetails')
  `);
  const set = new Set(rs.recordset.map(r => r.name.toUpperCase()));
  return {
    hasItemID: set.has("ITEMID"),
    hasSKU: set.has("SKU"),
    // the rest are assumed present (created above) but we still guard
    hasCustomerID: set.has("CUSTOMERID"),
    hasCustomerName: set.has("CUSTOMERNAME"),
    hasUnitID: set.has("UNITID"),
    hasUnitName: set.has("UNITNAME"),
    hasQualifier: set.has("QUALIFIER"),
    hasOrderedQTY: set.has("ORDEREDQTY"),
    hasReferenceNum: set.has("REFERENCENUM"),
    hasShipToAddress1: set.has("SHIPTOADDRESS1"),
    hasShipToCity: set.has("SHIPTOCITY"),
    hasShipToState: set.has("SHIPTOSTATE"),
    hasShipToZip: set.has("SHIPTOZIP"),
  };
}

/* ---------------------- MAIN IMPORTER ---------------------- */
export async function fetchAndUpsertOrders({
  maxPages = 10,
  pageSize = 200,
  onlyOpen = true,          // << default: only open
  onlyUnallocated = false,  //    set true to require unallocated too
} = {}) {
  const pool = await getPool();
  await ensureOrderDetailsBase(pool);
  const cols = await getOrderDetailsColumns(pool);

  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  let importedHeaders = 0;
  let upsertedItems = 0;
  const errors = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    let page;
    try {
      page = await listOrdersPage({ base, headers, pgsiz: pageSize, pgnum: pg, onlyOpen, onlyUnallocated });
    } catch (e) {
      return {
        ok: false,
        status: e.response?.status || 500,
        message: `Orders GET failed (page ${pg})`,
        data: e.response?.data || e.message,
      };
    }

    const orders = firstArray(page);
    if (!orders.length) break;
    importedHeaders += orders.length;

    const rows = [];
    for (const ord of orders) {
      const r = ro(ord);
      const orderId      = i(r.orderId ?? r.OrderId ?? ord.orderId ?? ord.OrderId, 0);
      const customerId   = i(r.customerIdentifier?.id ?? r.CustomerIdentifier?.Id ?? 0, 0);
      const customerName = s(r.customerIdentifier?.name ?? r.CustomerIdentifier?.Name ?? "", 200);
      const referenceNum = s(ord.referenceNum ?? ord.ReferenceNum ?? "", 100);

      const shipTo = ord.shipTo || {};
      const addr1  = s(shipTo.address1, 200, null);
      const city   = s(shipTo.city, 100, null);
      const state  = s(shipTo.state, 50, null);
      const zip    = s(shipTo.zip, 20, null);

      for (const it of orderItems(ord)) {
        const ir   = ro(it);
        const item = it?.itemIdentifier || it?.ItemIdentifier || {};
        const unit = ir?.unitIdentifier || ir?.UnitIdentifier || {};

        const orderItemId = i(ir.orderItemId ?? ir.OrderItemId ?? it.orderItemId ?? it.OrderItemId ?? it.id, 0);
        const sku         = s(item.sku ?? item.Sku ?? it.sku ?? it.SKU ?? "", 150);
        const unitId      = i(unit.id ?? unit.Id, null);
        const unitName    = s(unit.name ?? unit.Name ?? "", 50);
        const qualifier   = s(it.qualifier ?? it.Qualifier ?? "", 80);
        const qty         = i(it.qty ?? it.Qty ?? it.orderedQty ?? it.OrderedQty, 0);

        if (!orderItemId) continue;
        const safeSku = sku || "UNKNOWN";

        rows.push({
          OrderItemID: orderItemId,
          OrderId: orderId,
          CustomerID: customerId,
          CustomerName: customerName || "",
          ItemID: safeSku,     // we will map to ItemID and/or SKU depending on schema
          SKU: safeSku,
          UnitID: unitId,
          UnitName: unitName || null,
          Qualifier: qualifier || null,
          OrderedQTY: qty,
          ReferenceNum: referenceNum || null,
          ShipToAddress1: addr1,
          ShipToCity: city,
          ShipToState: state,
          ShipToZip: zip,
        });
      }
    }

    for (const r of rows) {
      try {
        const req = pool.request()
          .input("OrderItemID", sql.Int, r.OrderItemID)
          .input("OrderId", sql.Int, r.OrderId)
          .input("CustomerID", sql.Int, r.CustomerID)
          .input("CustomerName", sql.VarChar(200), r.CustomerName)
          .input("UnitID", sql.Int, r.UnitID)
          .input("UnitName", sql.VarChar(50), r.UnitName)
          .input("Qualifier", sql.VarChar(80), r.Qualifier)
          .input("OrderedQTY", sql.Int, r.OrderedQTY)
          .input("ReferenceNum", sql.VarChar(100), r.ReferenceNum)
          .input("ShipToAddress1", sql.VarChar(200), r.ShipToAddress1)
          .input("ShipToCity", sql.VarChar(100), r.ShipToCity)
          .input("ShipToState", sql.VarChar(50), r.ShipToState)
          .input("ShipToZip", sql.VarChar(20), r.ShipToZip);

        if (cols.hasItemID) req.input("ItemID", sql.VarChar(150), r.ItemID);
        if (cols.hasSKU)    req.input("SKU",    sql.VarChar(150), r.SKU);

        // Build dynamic SET & INSERT lists based on existing columns
        const setPieces = [
          "OrderId=@OrderId",
          "CustomerID=@CustomerID",
          "CustomerName=@CustomerName",
          cols.hasItemID ? "ItemID=@ItemID" : null,
          cols.hasSKU    ? "SKU=@SKU"       : null,
          "UnitID=@UnitID",
          "UnitName=@UnitName",
          "Qualifier=@Qualifier",
          "OrderedQTY=@OrderedQTY",
          "ReferenceNum=@ReferenceNum",
          "ShipToAddress1=@ShipToAddress1",
          "ShipToCity=@ShipToCity",
          "ShipToState=@ShipToState",
          "ShipToZip=@ShipToZip",
        ].filter(Boolean).join(", ");

        const colList = [
          "OrderItemID","OrderId","CustomerID","CustomerName",
          ...(cols.hasItemID ? ["ItemID"] : []),
          ...(cols.hasSKU    ? ["SKU"]    : []),
          "UnitID","UnitName","Qualifier","OrderedQTY","ReferenceNum",
          "ShipToAddress1","ShipToCity","ShipToState","ShipToZip",
        ];

        const valList = colList.map(c => `@${c}`).join(", ");

        await req.query(`
IF EXISTS (SELECT 1 FROM dbo.OrderDetails WITH (UPDLOCK, HOLDLOCK) WHERE OrderItemID=@OrderItemID)
  UPDATE dbo.OrderDetails SET ${setPieces} WHERE OrderItemID=@OrderItemID;
ELSE
  INSERT INTO dbo.OrderDetails (${colList.join(", ")})
  VALUES (${valList});
        `);

        upsertedItems++;
      } catch (e) {
        errors.push({
          orderItemId: r.OrderItemID,
          message: e.message,
          number: e.number,
          code: e.code,
          state: e.state,
          class: e.class,
          lineNumber: e.lineNumber,
        });
      }
    }

    if (orders.length < pageSize) break;
  }

  return errors.length
    ? { ok: false, importedHeaders, upsertedItems, errors }
    : { ok: true, importedHeaders, upsertedItems };
}
