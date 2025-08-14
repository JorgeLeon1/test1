// src/app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

/* ============ small helpers ============ */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const s = (v, n, def = "") => (v == null ? def : String(v).normalize("NFC").slice(0, n));
const i = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};

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

/* ============ auth (basic / oauth) ============ */
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
  if (!basic) throw new Error("No auth configured: EXT_BASIC_AUTH_B64 or EXT_TOKEN_URL (+ client id/secret) required.");
  return {
    Authorization: basic,
    Accept: "application/hal+json, application/json",
    "Content-Type": "application/hal+json; charset=utf-8",
  };
}

/* ============ API calls ============ */
async function listOrdersPage({ base, headers, pgsiz = 100, pgnum = 1 }) {
  const { data } = await axios.get(`${base}/orders`, {
    headers,
    params: { pgsiz, pgnum, detail: "OrderItems", itemdetail: "All" },
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
    const page = await listOrdersPage({ base, headers, pgsiz: 100, pgnum: 1 });
    const list = firstArray(page);
    return list.find(o => (ro(o).orderId ?? ro(o).OrderId ?? o.orderId ?? o.OrderId) === orderId) || null;
  } catch {
    return null;
  }
}

/* ============ DB bootstrap ============ */
async function ensureOrderDetailsTable(pool) {
  // Create table with all required columns if missing
  await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
BEGIN
  CREATE TABLE dbo.OrderDetails (
    OrderItemID     INT           NOT NULL PRIMARY KEY,
    OrderId         INT           NOT NULL DEFAULT(0),
    CustomerID      INT           NOT NULL DEFAULT(0),
    CustomerName    VARCHAR(200)  NOT NULL DEFAULT(''),
    ItemID          VARCHAR(150)  NOT NULL DEFAULT(''),
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

  // Add any missing columns (for existing environments)
  const addCol = async (name, spec) => {
    const rs = await pool.request().input("col", sql.VarChar(128), name).query(`
      SELECT 1 AS ok FROM sys.columns
      WHERE object_id = OBJECT_ID('dbo.OrderDetails') AND name = @col
    `);
    if (!rs.recordset.length) {
      await pool.request().batch(`ALTER TABLE dbo.OrderDetails ADD ${name} ${spec};`);
    }
  };

  await addCol("CustomerID",     "INT NOT NULL CONSTRAINT DF_OrderDetails_CustomerID DEFAULT(0)");
  await addCol("CustomerName",   "VARCHAR(200) NOT NULL CONSTRAINT DF_OrderDetails_CustomerName DEFAULT('')");
  await addCol("ItemID",         "VARCHAR(150) NOT NULL CONSTRAINT DF_OrderDetails_ItemID DEFAULT('')");
  await addCol("UnitID",         "INT NULL");
  await addCol("UnitName",       "VARCHAR(50) NULL");
  await addCol("Qualifier",      "VARCHAR(80) NULL");
  await addCol("OrderedQTY",     "INT NOT NULL CONSTRAINT DF_OrderDetails_OrderedQTY DEFAULT(0)");
  await addCol("ReferenceNum",   "VARCHAR(100) NULL");
  await addCol("ShipToAddress1", "VARCHAR(200) NULL");
  await addCol("ShipToCity",     "VARCHAR(100) NULL");
  await addCol("ShipToState",    "VARCHAR(50) NULL");
  await addCol("ShipToZip",      "VARCHAR(20) NULL");

  // Widen, if an older/narrow schema exists
  await pool.request().batch(`
IF COL_LENGTH('dbo.OrderDetails','CustomerName') < 200
  ALTER TABLE dbo.OrderDetails ALTER COLUMN CustomerName VARCHAR(200) NOT NULL;
IF COL_LENGTH('dbo.OrderDetails','ItemID') < 150
  ALTER TABLE dbo.OrderDetails ALTER COLUMN ItemID VARCHAR(150) NOT NULL;
IF COL_LENGTH('dbo.OrderDetails','UnitName') < 50
  ALTER TABLE dbo.OrderDetails ALTER COLUMN UnitName VARCHAR(50) NULL;
IF COL_LENGTH('dbo.OrderDetails','Qualifier') < 80
  ALTER TABLE dbo.OrderDetails ALTER COLUMN Qualifier VARCHAR(80) NULL;
IF COL_LENGTH('dbo.OrderDetails','ReferenceNum') < 100
  ALTER TABLE dbo.OrderDetails ALTER COLUMN ReferenceNum VARCHAR(100) NULL;
IF COL_LENGTH('dbo.OrderDetails','ShipToAddress1') < 200
  ALTER TABLE dbo.OrderDetails ALTER COLUMN ShipToAddress1 VARCHAR(200) NULL;
IF COL_LENGTH('dbo.OrderDetails','ShipToCity') < 100
  ALTER TABLE dbo.OrderDetails ALTER COLUMN ShipToCity VARCHAR(100) NULL;
IF COL_LENGTH('dbo.OrderDetails','ShipToState') < 50
  ALTER TABLE dbo.OrderDetails ALTER COLUMN ShipToState VARCHAR(50) NULL;
IF COL_LENGTH('dbo.OrderDetails','ShipToZip') < 20
  ALTER TABLE dbo.OrderDetails ALTER COLUMN ShipToZip VARCHAR(20) NULL;
`);
}

/* ============ MAIN IMPORT ============ */
export async function fetchAndUpsertOrders({ maxPages = 10, pageSize = 200 } = {}) {
  const pool = await getPool();
  await ensureOrderDetailsTable(pool);

  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  let importedHeaders = 0;
  let upsertedItems = 0;
  const errors = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    // fetch a page with items
    let page;
    try {
      page = await listOrdersPage({ base, headers, pgsiz: pageSize, pgnum: pg });
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

    // flatten rows (one per order item)
    const rows = [];
    for (const ord of orders) {
      const r = ro(ord);

      const orderId      = i(r.orderId ?? r.OrderId ?? ord.orderId ?? ord.OrderId, 0);
      const customerId   = i(r.customerIdentifier?.id ?? r.CustomerIdentifier?.Id ?? 0, 0);
      const customerName = s(r.customerIdentifier?.name ?? r.CustomerIdentifier?.Name ?? "", 200);
      const referenceNum = s(ord.referenceNum ?? ord.ReferenceNum ?? "", 100);

      const shipTo = ord.shipTo || {};
      const addr1  = s(shipTo.address1, 200);
      const city   = s(shipTo.city, 100);
      const state  = s(shipTo.state, 50);
      const zip    = s(shipTo.zip, 20);

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

        if (!orderItemId) continue; // must have a key
        // make sure required fields are non-empty
        const safeSku = sku || "UNKNOWN";

        rows.push({
          OrderItemID: orderItemId,
          OrderId: orderId,
          CustomerID: customerId,
          CustomerName: customerName || "",
          ItemID: safeSku,
          UnitID: unitId,
          UnitName: unitName || null,
          Qualifier: qualifier || null,
          OrderedQTY: qty,
          ReferenceNum: referenceNum || null,
          ShipToAddress1: addr1 || null,
          ShipToCity: city || null,
          ShipToState: state || null,
          ShipToZip: zip || null,
        });
      }
    }

    // upsert each row (no transaction, so one bad row won’t abort all)
    for (const r of rows) {
      try {
        await pool
          .request()
          .input("OrderItemID", sql.Int, r.OrderItemID)
          .input("OrderId", sql.Int, r.OrderId)
          .input("CustomerID", sql.Int, r.CustomerID)
          .input("CustomerName", sql.VarChar(200), r.CustomerName)
          .input("ItemID", sql.VarChar(150), r.ItemID)
          .input("UnitID", sql.Int, r.UnitID)
          .input("UnitName", sql.VarChar(50), r.UnitName)
          .input("Qualifier", sql.VarChar(80), r.Qualifier)
          .input("OrderedQTY", sql.Int, r.OrderedQTY)
          .input("ReferenceNum", sql.VarChar(100), r.ReferenceNum)
          .input("ShipToAddress1", sql.VarChar(200), r.ShipToAddress1)
          .input("ShipToCity", sql.VarChar(100), r.ShipToCity)
          .input("ShipToState", sql.VarChar(50), r.ShipToState)
          .input("ShipToZip", sql.VarChar(20), r.ShipToZip)
          .query(`
IF EXISTS (SELECT 1 FROM dbo.OrderDetails WITH (UPDLOCK, HOLDLOCK) WHERE OrderItemID=@OrderItemID)
  UPDATE dbo.OrderDetails
     SET OrderId=@OrderId,
         CustomerID=@CustomerID,
         CustomerName=@CustomerName,
         ItemID=@ItemID,
         UnitID=@UnitID,
         UnitName=@UnitName,
         Qualifier=@Qualifier,
         OrderedQTY=@OrderedQTY,
         ReferenceNum=@ReferenceNum,
         ShipToAddress1=@ShipToAddress1,
         ShipToCity=@ShipToCity,
         ShipToState=@ShipToState,
         ShipToZip=@ShipToZip
   WHERE OrderItemID=@OrderItemID;
ELSE
  INSERT INTO dbo.OrderDetails
    (OrderItemID, OrderId, CustomerID, CustomerName, ItemID, UnitID, UnitName, Qualifier, OrderedQTY, ReferenceNum, ShipToAddress1, ShipToCity, ShipToState, ShipToZip)
  VALUES
    (@OrderItemID, @OrderId, @CustomerID, @CustomerName, @ItemID, @UnitID, @UnitName, @Qualifier, @OrderedQTY, @ReferenceNum, @ShipToAddress1, @ShipToCity, @ShipToState, @ShipToZip);
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

    if (orders.length < pageSize) break; // last page
  }

  return errors.length
    ? { ok: false, importedHeaders, upsertedItems, errors }
    : { ok: true, importedHeaders, upsertedItems };
}
