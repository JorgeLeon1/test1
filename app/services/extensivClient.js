// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "../../db/mssql.js";

const TIMEOUT = 30000;

/** ---------- TOKEN (Bearer) OR BASIC ---------- **/
let tokenCache = { value: null, exp: 0 };

function b64() {
  // prefer explicit base64 if provided
  if (process.env.EXT_BASIC_AUTH_B64) return process.env.EXT_BASIC_AUTH_B64.trim();
  const id = process.env.EXT_CLIENT_ID || process.env.EXT_API_KEY || "";
  const sec = process.env.EXT_CLIENT_SECRET || process.env.EXT_API_SECRET || "";
  return Buffer.from(`${id}:${sec}`).toString("base64");
}

function trimBase(u) { return (u || "").replace(/\/+$/, ""); }

async function fetchOAuthToken() {
  if (Date.now() < tokenCache.exp && tokenCache.value) return tokenCache.value;

  const tokenUrl = process.env.EXT_TOKEN_URL
    || "https://secure-wms.com/AuthServer/api/Token"; // sandbox default

  // Extensiv oauth likes x-www-form-urlencoded with Basic auth header
  const form = new URLSearchParams();
  form.set("grant_type", "client_credentials");
  if (process.env.EXT_USER_LOGIN) form.set("user_login", process.env.EXT_USER_LOGIN);

  const r = await axios.post(tokenUrl, form.toString(), {
    headers: {
      Authorization: `Basic ${b64()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    timeout: TIMEOUT,
    validateStatus: () => true,
  });

  if (r.status >= 400) {
    const err = new Error(`OAuth ${r.status}`);
    err.response = r;
    throw err;
  }

  const tok = r.data?.access_token || r.data?.token || r.data?.accessToken;
  const expSec = Number(r.data?.expires_in || 300);
  if (!tok) throw new Error("Token response missing access_token");
  tokenCache = { value: tok, exp: Date.now() + (expSec - 30) * 1000 };
  return tok;
}

export async function authHeaders() {
  const mode = (process.env.EXT_AUTH_MODE || "bearer").toLowerCase();
  if (mode === "basic") {
    return {
      Authorization: `Basic ${b64()}`,
      Accept: "application/hal+json; charset=utf-8",
      "Content-Type": "application/hal+json; charset=utf-8",
    };
  } else {
    const tok = await fetchOAuthToken();
    return {
      Authorization: `Bearer ${tok}`,
      Accept: "application/hal+json; charset=utf-8",
      "Content-Type": "application/hal+json; charset=utf-8",
    };
  }
}

/** ---------- HELPERS: HAL vs ResourceList ---------- **/
function get(obj, ...keys) {
  for (const k of keys) {
    if (obj && k in obj) { obj = obj[k]; } else { return undefined; }
  }
  return obj;
}

function pickOrderArray(payload) {
  // HAL shape
  const halKey = "http://api.3plCentral.com/rels/orders/order";
  const fromHal = get(payload, "_embedded", halKey);
  if (Array.isArray(fromHal)) return { list: fromHal, mode: "hal" };

  // Legacy non-HAL
  const rl = payload?.ResourceList;
  if (Array.isArray(rl)) return { list: rl, mode: "resourcelist" };

  // Some tenants return plain arrays
  if (Array.isArray(payload)) return { list: payload, mode: "array" };

  return { list: [], mode: "unknown" };
}

function mapHeader(o) {
  // Support HAL (camel) and non-HAL (Pascal) casings
  const ro = o.readOnly || o.ReadOnly || {};
  const cust = ro.customerIdentifier || ro.CustomerIdentifier || {};
  const fac = ro.facilityIdentifier || ro.FacilityIdentifier || {};
  return {
    OrderId: ro.orderId ?? ro.OrderId ?? o.orderId ?? o.OrderId,
    ReferenceNum: o.referenceNum ?? o.ReferenceNum ?? null,
    CustomerId: cust.id ?? cust.Id ?? null,
    FacilityId: fac.id ?? fac.Id ?? null,
    Status: ro.status ?? ro.Status ?? null,
    ProcessDate: ro.processDate ?? ro.ProcessDate ?? null,
    LastModifiedDate: ro.lastModifiedDate ?? ro.LastModifiedDate ?? null,
  };
}

function mapItems(o) {
  // HAL items live in _embedded[rels/orders/item]
  const halItemKey = "http://api.3plCentral.com/rels/orders/item";
  let items = get(o, "_embedded", halItemKey);
  if (!Array.isArray(items)) {
    // Some legacy payloads flatten items
    items = o.OrderItems || o.orderItems || [];
  }

  const orderId =
    o.readOnly?.orderId ?? o.ReadOnly?.OrderId ?? o.orderId ?? o.OrderId;

  return items.map((it) => {
    const ro = it.readOnly || it.ReadOnly || {};
    const itemId = ro.orderItemId ?? ro.OrderItemId ?? it.orderItemId ?? it.OrderItemId;
    const ident = it.itemIdentifier || it.ItemIdentifier || {};
    return {
      OrderItemId: itemId,
      OrderId: orderId,
      SKU: ident.sku ?? ident.Sku ?? it.sku ?? it.Sku ?? null,
      Qualifier: it.qualifier ?? it.Qualifier ?? null,
      Qty: it.qty ?? it.Qty ?? it.orderedQty ?? it.OrderedQty ?? 0,
    };
  });
}

/** ---------- SQL: ensure tables & upserts ---------- **/
async function ensureTables(pool) {
  // OrderHeaders
  await pool.request().batch(`
IF OBJECT_ID('dbo.OrderHeaders','U') IS NULL
BEGIN
  CREATE TABLE dbo.OrderHeaders (
    OrderId            INT          NOT NULL PRIMARY KEY,
    ReferenceNum       NVARCHAR(200) NULL,
    CustomerId         INT           NULL,
    FacilityId         INT           NULL,
    Status             INT           NULL,
    ProcessDate        DATETIME2     NULL,
    LastModifiedDate   DATETIME2     NULL
  );
END
`);
  // OrderDetails
  await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
BEGIN
  CREATE TABLE dbo.OrderDetails (
    OrderItemId    INT           NOT NULL PRIMARY KEY,
    OrderId        INT           NOT NULL,
    ItemID         NVARCHAR(200) NULL,  -- alias for SKU to match your earlier naming
    SKU            NVARCHAR(200) NULL,
    Qualifier      NVARCHAR(50)  NULL,
    OrderedQTY     DECIMAL(18,4) NULL,
    CONSTRAINT FK_OrderDetails_OrderHeaders FOREIGN KEY (OrderId) REFERENCES dbo.OrderHeaders(OrderId)
  );
END
`);
}

async function upsertHeaderTx(tx, h) {
  const r = new sql.Request(tx);
  await r
    .input("OrderId", sql.Int, h.OrderId)
    .input("ReferenceNum", sql.NVarChar(200), h.ReferenceNum)
    .input("CustomerId", sql.Int, h.CustomerId)
    .input("FacilityId", sql.Int, h.FacilityId)
    .input("Status", sql.Int, h.Status)
    .input("ProcessDate", sql.DateTime2, h.ProcessDate ? new Date(h.ProcessDate) : null)
    .input("LastModifiedDate", sql.DateTime2, h.LastModifiedDate ? new Date(h.LastModifiedDate) : null)
    .query(`
MERGE dbo.OrderHeaders AS t
USING (SELECT @OrderId AS OrderId) s
ON (t.OrderId = s.OrderId)
WHEN MATCHED THEN UPDATE SET
  ReferenceNum=@ReferenceNum, CustomerId=@CustomerId, FacilityId=@FacilityId,
  Status=@Status, ProcessDate=@ProcessDate, LastModifiedDate=@LastModifiedDate
WHEN NOT MATCHED THEN INSERT (OrderId, ReferenceNum, CustomerId, FacilityId, Status, ProcessDate, LastModifiedDate)
VALUES (@OrderId, @ReferenceNum, @CustomerId, @FacilityId, @Status, @ProcessDate, @LastModifiedDate);
`);
}

async function upsertItemTx(tx, it) {
  const r = new sql.Request(tx);
  await r
    .input("OrderItemId", sql.Int, it.OrderItemId)
    .input("OrderId", sql.Int, it.OrderId)
    .input("SKU", sql.NVarChar(200), it.SKU)
    .input("Qualifier", sql.NVarChar(50), it.Qualifier || "")
    .input("Qty", sql.Decimal(18,4), Number(it.Qty || 0))
    .query(`
MERGE dbo.OrderDetails AS t
USING (SELECT @OrderItemId AS OrderItemId) s
ON (t.OrderItemId = s.OrderItemId)
WHEN MATCHED THEN UPDATE SET
  OrderId=@OrderId, SKU=@SKU, ItemID=@SKU, Qualifier=@Qualifier, OrderedQTY=@Qty
WHEN NOT MATCHED THEN INSERT (OrderItemId, OrderId, SKU, ItemID, Qualifier, OrderedQTY)
VALUES (@OrderItemId, @OrderId, @SKU, @SKU, @Qualifier, @Qty);
`);
}

/** ---------- PUBLIC: import headers+items with detail ---------- **/
export async function fetchAndUpsertOrders({ startPage = 1, limit = 200, pgsiz = 100 } = {}) {
  const api = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com");
  const baseUrl = `${api}/orders`; // HAL endpoint

  const pool = await getPool();
  await ensureTables(pool);

  let page = startPage;
  let importedHeaders = 0;
  let upsertedItems = 0;

  const commonHeaders = await authHeaders();

  while (importedHeaders < limit) {
    const params = {
      pgsiz: Math.min(Math.max(1, pgsiz), 1000),
      pgnum: page,
      detail: "OrderItems",          // include items
      itemdetail: "All",             // include allocations + saved elements
      // Optional RQL, e.g., status filters or modified date:
      // rql: "ReadOnly.IsClosed==false"
    };

    const resp = await axios.get(baseUrl, {
      headers: { ...commonHeaders, "Accept-Language": "en-US,en;q=0.8" },
      params,
      timeout: TIMEOUT,
      validateStatus: () => true,
    });

    if (resp.status === 400 && String(resp.data?.ErrorCode || "").includes("NotSupported")) {
      // Some tenants are picky—fall back to just pgsiz/pgnum without detail flags
      delete params.itemdetail;
      delete params.detail;
      const resp2 = await axios.get(baseUrl, {
        headers: { ...commonHeaders, "Accept-Language": "en-US,en;q=0.8" },
        params,
        timeout: TIMEOUT,
        validateStatus: () => true,
      });
      if (resp2.status >= 400) {
        const e = new Error(`Orders ${resp2.status}`);
        e.response = resp2;
        throw e;
      }
      await upsertPayload(pool, resp2.data, { includeItems: false });
      const { countH } = countPayload(resp2.data, false);
      importedHeaders += countH;
      if (countH === 0) break;
      page++;
      continue;
    }

    if (resp.status >= 400) {
      const e = new Error(`Orders ${resp.status}`);
      e.response = resp;
      throw e;
    }

    const { countH, countI } = await upsertPayload(pool, resp.data, { includeItems: true });
    importedHeaders += countH;
    upsertedItems += countI;

    if (countH === 0) break;      // no more pages
    if (importedHeaders >= limit) break;
    page++;
  }

  return { importedHeaders, upsertedItems };
}

function countPayload(payload, includeItems) {
  const { list } = pickOrderArray(payload);
  let cH = Array.isArray(list) ? list.length : 0;
  let cI = 0;
  if (includeItems && cH) {
    for (const o of list) cI += mapItems(o).length;
  }
  return { countH: cH, countI: cI };
}

async function upsertPayload(pool, payload, { includeItems }) {
  const { list } = pickOrderArray(payload);
  if (!Array.isArray(list) || !list.length) return { countH: 0, countI: 0 };

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    let itemCount = 0;
    for (const o of list) {
      const h = mapHeader(o);
      if (!h.OrderId) continue;
      await upsertHeaderTx(tx, h);
      if (includeItems) {
        const items = mapItems(o);
        for (const it of items) {
          if (!it.OrderItemId) continue;
          await upsertItemTx(tx, it);
          itemCount++;
        }
      }
    }
    await tx.commit();
    return { countH: list.length, countI: itemCount };
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

/** ---------- Simple peek for debugging ---------- **/
export async function peekOrders({ pgsiz = 1, pgnum = 1 } = {}) {
  const api = trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com");
  const url = `${api}/orders`;
  const headers = await authHeaders();
  const { data, status } = await axios.get(url, {
    headers: { ...headers, "Accept-Language": "en-US,en;q=0.8" },
    params: { pgsiz, pgnum, detail: "OrderItems", itemdetail: "All" },
    timeout: TIMEOUT,
    validateStatus: () => true,
  });
  return { status, data };
}
