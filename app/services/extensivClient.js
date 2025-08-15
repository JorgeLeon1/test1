// src/app/services/extensivClient.js
import axios from "axios";

// ---- Robust DB import: works with either named or default exports
import * as dbMod from "./db/mssql.js";
const db = dbMod?.default ?? dbMod;
const getPool = db?.getPool;
const sql = db?.sql;

if (typeof getPool !== "function" || !sql) {
  throw new Error("DB module does not export getPool/sql (services/db/mssql.js).");
}

/* --------------------------- small helpers --------------------------- */
const trimBase = (u) => (u || "").replace(/\/+$/, "");
const toInt = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const s = (v, max = 255) => (v == null ? "" : String(v).normalize("NFC").slice(0, max));

// pull first array from any of the shapes Extensiv returns
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
const ro = (o) => o?.readOnly || o?.ReadOnly || {};
function itemsFromOrder(ord) {
  const em = ord?._embedded;
  if (em && Array.isArray(em["http://api.3plCentral.com/rels/orders/item"])) {
    return em["http://api.3plCentral.com/rels/orders/item"];
  }
  if (Array.isArray(ord?.OrderItems)) return ord.OrderItems;
  if (Array.isArray(ord?.Items)) return ord.Items;
  return [];
}

/* ------------------------------ auth ------------------------------ */
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
    if (process.env.EXT_USER_LOGIN) form.set("user_login", process.env.EXT_USER_LOGIN);
    if (process.env.EXT_USER_LOGIN_ID) form.set("user_login_id", process.env.EXT_USER_LOGIN_ID);
    if (process.env.EXT_TPL_GUID) form.set("tplguid", process.env.EXT_TPL_GUID);

    const auth = basicHeaderFromEnv(); // base64(clientId:clientSecret)
    const r = await axios.post(tokenUrl, form, {
      headers: {
        Authorization: auth || "",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (r.status >= 200 && r.status < 300 && r.data?.access_token) {
      return `Bearer ${r.data.access_token}`;
    }
    return null;
  } catch {
    return null;
  }
}

export async function authHeaders() {
  const mode = (process.env.EXT_AUTH_MODE || "").toLowerCase();
  if (mode === "bearer") {
    const bearer = await getBearerViaOAuth();
    if (bearer) {
      return {
        Authorization: bearer,
        Accept: "application/hal+json, application/json",
        "Content-Type": "application/hal+json; charset=utf-8",
      };
    }
  }
  const basic = basicHeaderFromEnv();
  if (!basic) {
    throw new Error(
      "No auth configured: set EXT_BASIC_AUTH_B64 or EXT_TOKEN_URL (+ client id/secret)."
    );
  }
  return {
    Authorization: basic,
    Accept: "application/hal+json, application/json",
    "Content-Type": "application/hal+json; charset=utf-8",
  };
}

/* ------------------------------ API ------------------------------ */
async function listOrdersPage({ base, headers, pgsiz = 100, pgnum = 1, openOnly = true }) {
  // Restrict to OPEN & UNALLOCATED in the API if possible
  const params = { pgsiz, pgnum, detail: "OrderItems", itemdetail: "All" };
  if (openOnly) {
    // status 0 = Open; fullyAllocated=false
    params.rql = "readOnly.status==0;readOnly.fullyAllocated==false";
  }
  const { data } = await axios.get(`${base}/orders`, { headers, params, timeout: 30000 });
  return data;
}

export async function fetchOneOrderDetail(orderId) {
  const base = trimBase(
    process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com"
  );
  const headers = await authHeaders();

  try {
    const { data } = await axios.get(`${base}/orders`, {
      headers,
      params: {
        pgsiz: 1,
        pgnum: 1,
        detail: "OrderItems",
        itemdetail: "All",
        rql: `readOnly.orderId==${orderId}`,
      },
      timeout: 20000,
    });
    const list = firstArray(data);
    if (list?.[0]) return list[0];
  } catch {}
  try {
    const page = await listOrdersPage({ base, headers, pgsiz: 100, pgnum: 1, openOnly: false });
    const list = firstArray(page);
    return list.find((o) => (ro(o).orderId ?? ro(o).OrderId ?? o.orderId ?? o.OrderId) === orderId) || null;
  } catch {
    return null;
  }
}

/* -------- discover existing columns so we only write what exists -------- */
async function getExistingOrderDetailsColumns(pool) {
  const q = await pool
    .request()
    .query("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OrderDetails')");
  return new Set(q.recordset.map((r) => r.name));
}

/* ------- build a dynamic upsert using only columns that actually exist ---- */
async function upsertOrderDetail(pool, cols, rec) {
  if (!rec.OrderItemID) return;

  const req = pool.request();
  req.input("OrderItemID", sql.Int, rec.OrderItemID);

  const fieldDefs = [
    ["OrderID", "OrderID", sql.Int, toInt(rec.OrderId, 0)], // NOTE: DB col is OrderID (capital D), map from OrderId
    ["OrderId", "OrderId", sql.Int, toInt(rec.OrderId, 0)], // if your table used OrderId (lower d)
    ["CustomerID", "CustomerID", sql.Int, toInt(rec.CustomerID, 0)],
    ["CustomerName", "CustomerName", sql.VarChar(200), s(rec.CustomerName, 200)],
    ["SKU", "SKU", sql.VarChar(150), s(rec.SKU, 150)],
    ["ItemID", "ItemID", sql.VarChar(150), s(rec.SKU, 150)], // mirror SKU into ItemID if present
    ["Qualifier", "Qualifier", sql.VarChar(80), s(rec.Qualifier, 80)],
    ["OrderedQTY", "OrderedQTY", sql.Int, toInt(rec.OrderedQTY, 0)],
    ["UnitID", "UnitID", sql.Int, toInt(rec.UnitID, 0)],
    ["UnitName", "UnitName", sql.VarChar(80), s(rec.UnitName, 80)],
    ["ReferenceNum", "ReferenceNum", sql.VarChar(120), s(rec.ReferenceNum, 120)],
    ["ShipToAddress1", "ShipToAddress1", sql.VarChar(255), s(rec.ShipToAddress1, 255)],
  ];

  const active = fieldDefs.filter(([col]) => cols.has(col));
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

/* ----------------------------- MAIN IMPORT ----------------------------- */
export async function fetchAndUpsertOrders({ maxPages = 10, pageSize = 200, openOnly = true } = {}) {
  const pool = await getPool();
  const existingCols = await getExistingOrderDetailsColumns(pool);

  const base = trimBase(
    process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com"
  );
  const headers = await authHeaders();

  let importedHeaders = 0;
  let upsertedItems = 0;
  const errors = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    let pageData;
    try {
      pageData = await listOrdersPage({ base, headers, pgsiz: pageSize, pgnum: pg, openOnly });
    } catch (e) {
      const st = e.response?.status;
      const dt = e.response?.data;
      return {
        ok: false,
        status: st || 500,
        message: `Orders GET failed (page ${pg})`,
        data: typeof dt === "string" ? dt : dt || String(e.message),
      };
    }

    const orders = firstArray(pageData);
    if (!orders.length) break;
    importedHeaders += orders.length;

    for (const ord of orders) {
      const R = ro(ord);
      const orderId = toInt(R.orderId ?? R.OrderId ?? ord.orderId ?? ord.OrderId, 0);

      // order-level fields
      const customerId = toInt(R.customerIdentifier?.id, 0);
      const customerName = s(R.customerIdentifier?.name, 200);
      const referenceNum = s(ord.referenceNum, 120);
      const shipToAddress1 = s(ord.shipTo?.address1, 255);

      let lines = itemsFromOrder(ord);
      if (!lines.length) {
        try {
          const detail = await fetchOneOrderDetail(orderId);
          lines = itemsFromOrder(detail);
        } catch {
          lines = [];
        }
      }

      for (const it of lines) {
        const IR = ro(it);
        const orderItemId = toInt(IR.orderItemId ?? IR.OrderItemId ?? it.orderItemId ?? it.OrderItemId, 0);
        const sku = s(
          it?.itemIdentifier?.sku ??
            it?.ItemIdentifier?.Sku ??
            it?.sku ??
            it?.SKU ??
            "",
          150
        );
        const unitId = toInt(IR.unitIdentifier?.id, 0);
        const unitName = s(IR.unitIdentifier?.name, 80);
        const qualifier = s(it?.qualifier ?? it?.Qualifier ?? "", 80);
        const qty = toInt(it?.qty ?? it?.Qty ?? it?.orderedQty ?? it?.OrderedQty, 0);

        if (!orderItemId) continue;

        const rec = {
          OrderItemID: orderItemId,
          OrderId: orderId,
          CustomerID: customerId,
          CustomerName: customerName,
          SKU: sku,
          Qualifier: qualifier,
          OrderedQTY: qty,
          UnitID: unitId,
          UnitName: unitName,
          ReferenceNum: referenceNum,
          ShipToAddress1: shipToAddress1,
        };

        try {
          await upsertOrderDetail(pool, existingCols, rec);
          upsertedItems++;
        } catch (e) {
          errors.push({
            orderItemId,
            message: e.message,
            number: e.number,
            code: e.code,
            state: e.state,
            class: e.class,
            lineNumber: e.lineNumber,
          });
        }
      }
    }

    if (orders.length < pageSize) break;
  }

  return errors.length
    ? { ok: false, importedHeaders, upsertedItems, errors }
    : { ok: true, importedHeaders, upsertedItems };
}

// Also export a default for safer importing from routes
export default {
  authHeaders,
  fetchOneOrderDetail,
  fetchAndUpsertOrders,
};
