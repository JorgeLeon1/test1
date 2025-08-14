// app/routes/extensiv.js
import { Router } from "express";
import axios from "axios";

import {
  authHeaders,
  fetchAndUpsertOrders,
  fetchOneOrderDetail,   // remove the /peekOrder route below if you don't export this
} from "../services/extensivClient.js";

import { importInventory } from "../services/inventoryClient.js";
import { runAllocationAndRead } from "../services/allocService.js";
import { pushAllocations } from "../services/pushAllocations.js";
// If your mssql helper is at src/db/mssql.js, use "../../db/mssql.js" instead:
import { getPool } from "../services/db/mssql.js";

/* --------------------------- init router FIRST --------------------------- */
const r = Router();

/* ------------------------------ helpers ---------------------------------- */
const trimBase = (u) => (u || "").replace(/\/+$/, "");

// Find the first array in typical Extensiv responses (HAL & legacy)
const firstArray = (data) => {
  if (!data) return [];
  // HAL orders
  const hal = data?._embedded?.["http://api.3plCentral.com/rels/orders/order"];
  if (Array.isArray(hal)) return hal;
  // Legacy lists
  if (Array.isArray(data.ResourceList)) return data.ResourceList;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data)) return data;
  // last resort
  for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  return [];
};

/* -------------------------------- DEBUG ---------------------------------- */

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

r.get("/token", async (_req, res) => {
  try {
    const h = await authHeaders();
    const bearer = h.Authorization?.startsWith("Bearer ")
      ? h.Authorization.slice(7)
      : "";
    res.json({
      ok: true,
      tokenLen: bearer.length,
      head: bearer.slice(0, 12),
      tail: bearer.slice(-8),
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({
      ok: false,
      status: e.response?.status,
      message: e.message,
      data: e.response?.data || "",
    });
  }
});

/* --------------------------------- PEEK ---------------------------------- */

r.get("/peek", async (_req, res) => {
  try {
    const base = trimBase(
      process.env.EXT_API_BASE ||
      process.env.EXT_BASE_URL ||
      "https://box.secure-wms.com"
    );
    const headers = await authHeaders();
    const resp = await axios.get(`${base}/orders`, {
      headers: { ...headers, "Accept-Language": "en-US,en;q=0.8" },
      params: { pgsiz: 1, pgnum: 1, detail: "OrderItems", itemdetail: "All" },
      timeout: 15000,
      validateStatus: () => true,
    });

    const data = resp.data;
    const list = firstArray(data);

    res.status(resp.status).json({
      ok: resp.status < 400,
      status: resp.status,
      topLevelType: Array.isArray(data) ? "array" : "object",
      keys: data && typeof data === "object" ? Object.keys(data) : [],
      firstArrayKey: Array.isArray(data?._embedded?.["http://api.3plCentral.com/rels/orders/order"])
        ? "HAL:_embedded[rels/orders/order]"
        : Array.isArray(data?.ResourceList)
        ? "ResourceList"
        : Array.isArray(data?.data)
        ? "data"
        : Array.isArray(data)
        ? "(root)"
        : "none",
      firstArrayLen: list.length,
      sample: list[0] || data,
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({
      ok: false,
      status: e.response?.status,
      message: e.message,
      data: e.response?.data || "",
    });
  }
});

r.get("/peekOrder", async (req, res) => {
  try {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ ok: false, message: "Provide ?id=<OrderId>" });

    const payload = await fetchOneOrderDetail(id);
    let items = [];
    let itemArrayKey = "unknown";
    if (Array.isArray(payload?._embedded?.["http://api.3plCentral.com/rels/orders/item"])) {
      itemArrayKey = "HAL:_embedded[rels/orders/item]";
      items = payload._embedded["http://api.3plCentral.com/rels/orders/item"];
    } else if (Array.isArray(payload?.OrderLineItems)) {
      itemArrayKey = "OrderLineItems";
      items = payload.OrderLineItems;
    } else if (Array.isArray(payload?.Items)) {
      itemArrayKey = "Items";
      items = payload.Items;
    } else if (Array.isArray(payload?.ResourceList)) {
      itemArrayKey = "ResourceList";
      items = payload.ResourceList;
    } else if (Array.isArray(payload?.data)) {
      itemArrayKey = "data";
      items = payload.data;
    }

    res.json({
      ok: true,
      orderId: id,
      keys: payload && typeof payload === "object" ? Object.keys(payload) : [],
      itemArrayKey,
      itemsFound: items.length,
      sampleItem: items[0] || null,
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({
      ok: false,
      status: e.response?.status,
      message: e.message,
      data: e.response?.data || "",
    });
  }
});

/* ------------------------------- ACTIONS --------------------------------- */

// Inventory → dbo.Inventory
r.post("/inventory-import", async (_req, res) => {
  try {
    const result = await importInventory();
    res.json(result);
  } catch (e) {
    res.status(e.response?.status || 500).json({
      ok: false,
      status: e.response?.status,
      message: e.message,
      data: e.response?.data || "",
    });
  }
});

// Orders + details → dbo.OrderHeaders / dbo.OrderDetails
r.post("/import", async (req, res) => {
  try {
    const result = await fetchAndUpsertOrders(req.body || {});
    res.json(result);
  } catch (e) {
    res.status(e.response?.status || 500).json({
      ok: false,
      status: e.response?.status,
      message: e.message,
      data: e.response?.data || "",
    });
  }
});

// Allocate using dbo.Inventory → dbo.Allocations
r.post("/allocate", async (_req, res) => {
  try {
    const { applied, rows } = await runAllocationAndRead();
    res.json({ applied, suggestions: rows });
  } catch (e) {
    res.status(e.response?.status || 500).json({
      ok: false,
      status: e.response?.status,
      message: e.message,
      data: e.response?.data || "",
    });
  }
});

// Preview payload to push back to Extensiv (stub)
r.post("/push", async (_req, res) => {
  try {
    const result = await pushAllocations();
    res.json(result);
  } catch (e) {
    res.status(e.response?.status || 500).json({
      ok: false,
      status: e.response?.status,
      message: e.message,
      data: e.response?.data || "",
    });
  }
});

/* ------------------------------- SELFTEST -------------------------------- */

r.get("/selftest", async (_req, res) => {
  const out = { ok: false, steps: {} };
  try {
    const headers = await authHeaders();
    out.steps.auth = "ok";

    const base = trimBase(
      process.env.EXT_API_BASE ||
      process.env.EXT_BASE_URL ||
      "https://box.secure-wms.com"
    );
    const o = await axios.get(`${base}/orders`, {
      headers: { ...headers, "Accept-Language": "en-US,en;q=0.8" },
      params: { pgsiz: 1, pgnum: 1 },
      timeout: 15000,
      validateStatus: () => true,
    });
    const list = firstArray(o.data);
    out.steps.orders = { status: o.status, count: list.length };

    const pool = await getPool();
    await pool.request().query("SELECT 1 as ok");
    out.steps.db = "connect-ok";

    await pool.request().batch(`
IF OBJECT_ID('dbo.OrderHeaders','U') IS NULL
  CREATE TABLE dbo.OrderHeaders (
    OrderId            INT          NOT NULL PRIMARY KEY,
    ReferenceNum       NVARCHAR(200) NULL,
    CustomerId         INT           NULL,
    FacilityId         INT           NULL,
    Status             INT           NULL,
    ProcessDate        DATETIME2     NULL,
    LastModifiedDate   DATETIME2     NULL
  );
IF OBJECT_ID('dbo.OrderDetails','U') IS NULL
  CREATE TABLE dbo.OrderDetails (
    OrderItemID INT           NOT NULL PRIMARY KEY,
    OrderId     INT           NOT NULL,
    ItemID      NVARCHAR(200) NULL,
    SKU         NVARCHAR(200) NULL,
    Qualifier   NVARCHAR(50)  NULL,
    OrderedQTY  DECIMAL(18,4) NULL
  );
IF OBJECT_ID('dbo.Inventory','U') IS NULL
  CREATE TABLE dbo.Inventory (
    ItemID      VARCHAR(100) NOT NULL,
    Location    VARCHAR(100) NULL,
    OnHand      INT NULL,
    Allocated   INT NULL,
    Available   INT NULL,
    PRIMARY KEY (ItemID, ISNULL(Location,''))
  );
IF OBJECT_ID('dbo.Allocations','U') IS NULL
  CREATE TABLE dbo.Allocations (
    Id         INT IDENTITY(1,1) PRIMARY KEY,
    OrderId    INT NULL,
    ItemID     VARCHAR(100) NOT NULL,
    Qualifier  VARCHAR(50)  NULL,
    Location   VARCHAR(100) NULL,
    Qty        INT          NOT NULL DEFAULT 0,
    CreatedAt  DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME()
  );
    `);

    out.steps.tables = "ok";
    out.ok = true;
    res.json(out);
  } catch (e) {
    res.status(e.response?.status || 500).json({
      ok: false,
      where: out.steps.auth
        ? out.steps.orders
          ? out.steps.db
            ? "tables"
            : "db"
          : "orders"
        : "auth",
      status: e.response?.status,
      message: e.message,
      data: e.response?.data || "",
    });
  }
});

export default r;
