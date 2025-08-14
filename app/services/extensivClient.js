// src/app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

/* ========================== helpers: auth =========================== */

const trimBase = (u) => (u || "").replace(/\/+$/, "");

function basicHeaderFromEnv() {
  // base64("clientId:clientSecret")
  const b64 = process.env.EXT_BASIC_AUTH_B64 || "";
  return b64 ? `Basic ${b64}` : null;
}

async function getBearerViaOAuth() {
  const tokenUrl = process.env.EXT_TOKEN_URL; // e.g. https://secure-wms.com/oauth/token (if your tenant supports it)
  if (!tokenUrl) return null;

  try {
    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");
    if (process.env.EXT_USER_LOGIN) form.set("user_login", process.env.EXT_USER_LOGIN);
    if (process.env.EXT_USER_LOGIN_ID) form.set("user_login_id", process.env.EXT_USER_LOGIN_ID);
    if (process.env.EXT_TPL_GUID) form.set("tplguid", process.env.EXT_TPL_GUID);

    const auth = basicHeaderFromEnv(); // required by Extensiv OAuth
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
  // Preferred order: explicit AUTH_MODE=bearer → OAuth, else Basic
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
    // fall through to Basic
  }

  const basic = basicHeaderFromEnv();
  if (!basic) {
    throw new Error(
      "No auth configured. Set EXT_BASIC_AUTH_B64 or EXT_TOKEN_URL (+ client id/secret)."
    );
  }
  return {
    Authorization: basic,
    Accept: "application/hal+json, application/json",
    "Content-Type": "application/hal+json; charset=utf-8",
  };
}

/* =================== helpers: response normalization =================== */

function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj?.ResourceList)) return obj.ResourceList;
  // HAL shape:
  const halOrders = obj?._embedded?.["http://api.3plCentral.com/rels/orders/order"];
  if (Array.isArray(halOrders)) return halOrders;
  if (Array.isArray(obj?.data)) return obj.data;
  for (const v of Object.values(obj || {})) if (Array.isArray(v)) return v;
  return [];
}

function itemsFromOrder(ord) {
  // HAL items:
  const em = ord?._embedded;
  if (em && Array.isArray(em["http://api.3plCentral.com/rels/orders/item"])) {
    return em["http://api.3plCentral.com/rels/orders/item"];
  }
  // Other common shapes:
  if (Array.isArray(ord?.OrderItems)) return ord.OrderItems;
  if (Array.isArray(ord?.Items)) return ord.Items;
  return [];
}

function readOnly(o) {
  return o?.readOnly || o?.ReadOnly || {};
}

/* ========================== API primitives =========================== */

// Legacy list endpoint that (for some tenants) can include items directly.
async function listOrdersPage({ base, headers, pgsiz = 100, pgnum = 1 }) {
  const { data } = await axios.get(`${base}/orders`, {
    headers,
    params: {
      pgsiz,
      pgnum,
      detail: "OrderItems",
      itemdetail: "All",
    },
    timeout: 30000,
  });
  return data;
}

// Best-effort “fetch one order + items” using RQL; falls back to scanning a page if needed.
export async function fetchOneOrderDetail(orderId) {
  const base = trimBase(
    process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com"
  );
  const headers = await authHeaders();

  // Try RQL to select a single order with full item detail:
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
  } catch {
    /* ignore */
  }

  // Fallback: pull a page and find it
  try {
    const page = await listOrdersPage({ base, headers, pgsiz: 100, pgnum: 1 });
    const list = firstArray(page);
    return list.find((o) => (readOnly(o).OrderId ?? o.OrderId ?? o.orderId) === orderId) || null;
  } catch {
    return null;
  }
}

/* ============================ DB bootstrap ============================ */

async function ensureTables(pool) {
  await pool.request().batch(`
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
  CREATE TABLE dbo.OrderDetails (
    OrderItemID INT NOT NULL PRIMARY KEY,
    OrderId     INT NULL,
    ItemID      VARCHAR(100) NULL,
    Qualifier   VARCHAR(50) NULL,
    OrderedQTY  INT NULL
  );
`);
}

/* ============== Fallback: per-order detail fetcher (batched) ============== */

async function fetchDetailsForMany(orderIds, headers, base, concurrency = 4) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < orderIds.length) {
      const id = orderIds[idx++];
      try {
        const { data } = await axios.get(`${base}/orders`, {
          headers,
          params: {
            pgsiz: 1,
            pgnum: 1,
            detail: "OrderItems",
            itemdetail: "All",
            rql: `readOnly.orderId==${id}`,
          },
          timeout: 20000,
        });
        const list = firstArray(data);
        if (list?.[0]) results.push(list[0]);
      } catch {
        // ignore single-order failures; continue
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, orderIds.length) }, worker);
  await Promise.all(workers);
  return results;
}

/* =============================== IMPORTER =============================== */

export async function fetchAndUpsertOrders({ maxPages = 10, pageSize = 200 } = {}) {
  const pool = await getPool();
  await ensureTables(pool);

  const base = trimBase(
    process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com"
  );
  const headers = await authHeaders();

  let importedHeaders = 0;
  let upsertedItems = 0;
  const errs = [];

  for (let pg = 1; pg <= maxPages; pg++) {
    // 1) page list (asks for items)
    let pageData;
    try {
      pageData = await listOrdersPage({ base, headers, pgsiz: pageSize, pgnum: pg });
    } catch (e) {
      const st = e.response?.status;
      const dt = e.response?.data;
      throw new Error(
        `Orders GET failed (page ${pg}) status ${st} ${typeof dt === "string" ? dt : JSON.stringify(dt)}`
      );
    }

    const orders = firstArray(pageData);
    if (!orders.length) break;
    importedHeaders += orders.length;

    // 2) Flatten items from page response
    const flat = [];
    const orderIds = [];

    for (const ord of orders) {
      const ro = readOnly(ord);
      const orderId = ro.OrderId ?? ro.orderId ?? ord.OrderId ?? ord.orderId ?? null;
      if (orderId) orderIds.push(orderId);

      for (const it of itemsFromOrder(ord)) {
        const iro = readOnly(it);
        const orderItemId =
          iro.OrderItemId ?? iro.orderItemId ?? it.orderItemId ?? it.OrderItemId ?? it.id ?? null;

        const sku =
          it?.itemIdentifier?.sku ??
          it?.ItemIdentifier?.Sku ??
          it?.sku ??
          it?.SKU ??
          null;

        const qualifier = it?.qualifier ?? it?.Qualifier ?? "";
        const qty = Number(it?.qty ?? it?.Qty ?? it?.OrderedQty ?? it?.orderedQty ?? 0) || 0;

        if (orderItemId && sku) {
          flat.push({ orderItemId, orderId, sku, qualifier, qty });
        }
      }
    }

    // 3) If no items came back in the page, fetch per-order details
    if (flat.length === 0 && orderIds.length) {
      const detailed = await fetchDetailsForMany(orderIds, headers, base, 4);
      for (const ord of detailed) {
        const ro = readOnly(ord);
        const orderId = ro.OrderId ?? ro.orderId ?? ord.OrderId ?? ord.orderId ?? null;

        for (const it of itemsFromOrder(ord)) {
          const iro = readOnly(it);
          const orderItemId =
            iro.OrderItemId ?? iro.orderItemId ?? it.orderItemId ?? it.OrderItemId ?? it.id ?? null;

          const sku =
            it?.itemIdentifier?.sku ??
            it?.ItemIdentifier?.Sku ??
            it?.sku ??
            it?.SKU ??
            null;

          const qualifier = it?.qualifier ?? it?.Qualifier ?? "";
          const qty = Number(it?.qty ?? it?.Qty ?? it?.OrderedQty ?? it?.orderedQty ?? 0) || 0;

          if (orderItemId && sku) {
            flat.push({ orderItemId, orderId, sku, qualifier, qty });
          }
        }
      }
    }

    // 4) Dedupe by OrderItemID
    const byId = new Map();
    for (const x of flat) if (!byId.has(x.orderItemId)) byId.set(x.orderItemId, x);
    const items = Array.from(byId.values());

    // 5) Chunked upsert (smaller chunks to avoid long transactions)
    const CHUNK = 150;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const req = new sql.Request(tx);
        for (const it of chunk) {
          await req
            .input("OrderItemID", sql.Int, it.orderItemId)
            .input("OrderId", sql.Int, it.orderId ?? null)
            .input("ItemID", sql.VarChar(100), it.sku)
            .input("Qualifier", sql.VarChar(50), it.qualifier ?? "")
            .input("OrderedQTY", sql.Int, it.qty ?? 0)
            .query(`
IF EXISTS (SELECT 1 FROM dbo.OrderDetails WITH (UPDLOCK, HOLDLOCK) WHERE OrderItemID=@OrderItemID)
  UPDATE dbo.OrderDetails
     SET OrderId=@OrderId, ItemID=@ItemID, Qualifier=@Qualifier, OrderedQTY=@OrderedQTY
   WHERE OrderItemID=@OrderItemID;
ELSE
  INSERT INTO dbo.OrderDetails (OrderItemID, OrderId, ItemID, Qualifier, OrderedQTY)
  VALUES (@OrderItemID, @OrderId, @ItemID, @Qualifier, @OrderedQTY);
          `);
          upsertedItems++;
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        errs.push({ page: pg, chunkStart: i, code: e.code, number: e.number, message: e.message });
      }
    }

    if (orders.length < pageSize) break; // last page
  }

  if (errs.length) return { ok: false, importedHeaders, upsertedItems, errors: errs };
  return { importedHeaders, upsertedItems };
}
