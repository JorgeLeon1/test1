// src/app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

/* --------------------------- auth helpers --------------------------- */

const trimBase = (u) => (u || "").replace(/\/+$/, "");

function basicHeaderFromEnv() {
  const b64 = process.env.EXT_BASIC_AUTH_B64 || "";
  return b64 ? `Basic ${b64}` : null;
}

async function getBearerViaOAuth() {
  // Only try if you actually have a token URL configured
  const tokenUrl = process.env.EXT_TOKEN_URL;
  if (!tokenUrl) return null;

  try {
    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");
    if (process.env.EXT_USER_LOGIN) form.set("user_login", process.env.EXT_USER_LOGIN);
    if (process.env.EXT_USER_LOGIN_ID) form.set("user_login_id", process.env.EXT_USER_LOGIN_ID);
    if (process.env.EXT_TPL_GUID) form.set("tplguid", process.env.EXT_TPL_GUID);

    const auth = basicHeaderFromEnv(); // base64(clientId:clientSecret)
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
  // Preferred order: explicit AUTH_MODE, else try OAuth, else Basic
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
    // fall back to basic
  }

  const basic = basicHeaderFromEnv();
  if (!basic) {
    throw new Error("No auth configured: set EXT_BASIC_AUTH_B64 or EXT_TOKEN_URL (+ client id/secret).");
  }
  return {
    Authorization: basic,
    Accept: "application/hal+json, application/json",
    "Content-Type": "application/hal+json; charset=utf-8",
  };
}

/* --------------------------- API primitives -------------------------- */

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

function extractOrderItems(order) {
  // Try the common HAL spot first
  const em = order?._embedded;
  if (em && Array.isArray(em["http://api.3plCentral.com/rels/orders/item"])) {
    return em["http://api.3plCentral.com/rels/orders/item"];
  }
  // Try other shapes we’ve seen in the wild
  if (Array.isArray(order?.OrderItems)) return order.OrderItems;
  if (Array.isArray(order?.Items)) return order.Items;
  // Nothing found
  return [];
}

/* 
  Legacy listing endpoint:
  GET https://box.secure-wms.com/orders?pgsiz=100&pgnum=1&detail=OrderItems&itemdetail=All
*/
async function legacyListOrders({ pgsiz = 100, pgnum = 1 } = {}) {
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  const resp = await axios.get(`${base}/orders`, {
    headers,
    params: {
      pgsiz,
      pgnum,
      // include items so we can upsert details in one pass
      detail: "OrderItems",
      itemdetail: "All",
    },
    timeout: 30000,
  });
  return resp.data;
}

/* 
  Fetch a *single* order with items (fallback endpoint)
  Some tenants expose a detail endpoint; if you don’t have it, we’ll just filter from list.
*/
export async function fetchOneOrderDetail(orderId) {
  // safest: list with RQL to limit to a single order id (if your tenant supports rql=readOnly.orderId==ID)
  const base = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");
  const headers = await authHeaders();

  // Try RQL filter (many tenants support `rql=readOnly.orderId==<id>`)
  try {
    const { data } = await axios.get(`${base}/orders`, {
      headers,
      params: { pgsiz: 1, pgnum: 1, detail: "OrderItems", itemdetail: "All", rql: `readOnly.orderId==${orderId}` },
      timeout: 20000,
    });
    const list = firstArray(data);
    return list[0] || null;
  } catch {
    // Fallback: fetch a page and find it (not ideal, but keeps the function safe)
    const page = await legacyListOrders({ pgsiz: 100, pgnum: 1 });
    const list = firstArray(page);
    return list.find(o => o?.ReadOnly?.OrderId === orderId) || null;
  }
}

/* ------------------------------ DB setup ------------------------------ */

async function ensureTables(pool) {
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
}

/* ----------------------------- Main import ---------------------------- */

export async function fetchAndUpsertOrders({ maxPages = 10, pageSize = 100 } = {}) {
  const pool = await getPool();
  await ensureTables(pool);

  let importedHeaders = 0;
  let upsertedItems = 0;

  for (let page = 1; page <= maxPages; page++) {
    const payload = await legacyListOrders({ pgsiz: pageSize, pgnum: page });
    const orders = firstArray(payload);
    if (!orders.length) break;

    importedHeaders += orders.length;

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const req = new sql.Request(tx);

      for (const ord of orders) {
        const orderId =
          ord?.ReadOnly?.OrderId ??
          ord?.readOnly?.orderId ??
          ord?.orderId ??
          null;

        const items = extractOrderItems(ord);
        for (const it of items) {
          const orderItemId =
            it?.ReadOnly?.OrderItemId ??
            it?.readOnly?.orderItemId ??
            it?.orderItemId ??
            it?.id ??
            null;

          const sku =
            it?.ItemIdentifier?.Sku ??
            it?.itemIdentifier?.sku ??
            it?.sku ??
            null;

          const qualifier = it?.Qualifier ?? it?.qualifier ?? "";
          const qty =
            Number(
              it?.Qty ??
              it?.qty ??
              it?.OrderedQty ??
              it?.orderedQty ??
              0
            ) || 0;

          if (orderItemId && sku) {
            await req
              .input("OrderItemID", sql.Int, orderItemId)
              .input("OrderId", sql.Int, orderId)
              .input("ItemID", sql.VarChar(100), sku)
              .input("Qualifier", sql.VarChar(50), qualifier)
              .input("OrderedQTY", sql.Int, qty)
              .query(`
                MERGE dbo.OrderDetails AS t
                USING (SELECT @OrderItemID AS OrderItemID) s
                  ON t.OrderItemID = s.OrderItemID
                WHEN MATCHED THEN UPDATE SET
                  OrderId=@OrderId, ItemID=@ItemID, Qualifier=@Qualifier, OrderedQTY=@OrderedQTY
                WHEN NOT MATCHED THEN INSERT (OrderItemID, OrderId, ItemID, Qualifier, OrderedQTY)
                  VALUES (@OrderItemID, @OrderId, @ItemID, @Qualifier, @OrderedQTY);
              `);
            upsertedItems++;
          }
        }
      }

      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    // stop if the last page likely returned fewer than requested
    if (orders.length < pageSize) break;
  }

  return { importedHeaders, upsertedItems };
}
