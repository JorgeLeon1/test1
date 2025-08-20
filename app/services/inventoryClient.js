// app/services/inventoryClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";
import { authHeaders } from "./extensivClient.js";

const trimBase = (u) => (u || "").replace(/\/+$/, "");
const TIMEOUT = 20000;

// Extract an array from various API response shapes
const listify = (data) => {
  if (Array.isArray(data)) return data;
  const keys = ["ResourceList", "data", "items", "Items", "records", "Records", "value"];
  for (const k of keys) if (Array.isArray(data?.[k])) return data[k];
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  }
  return [];
};

// ✅ Named export required by app/routes/extensiv.js
export async function importInventory() {
  const base =
    trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com");
  const headers = await authHeaders();
  const pool = await getPool();

  // Ensure target table exists (idempotent)
  await pool.request().batch(`
IF OBJECT_ID('dbo.Inventory','U') IS NULL
BEGIN
  CREATE TABLE dbo.Inventory (
    ItemID      VARCHAR(100) NOT NULL,
    Location    VARCHAR(100) NULL,
    OnHand      INT          NULL,
    Allocated   INT          NULL,
    Available   INT          NULL,
    PRIMARY KEY (ItemID, ISNULL(Location,''))
  );
END
ELSE
BEGIN
  IF COL_LENGTH('dbo.Inventory','Allocated') IS NULL ALTER TABLE dbo.Inventory ADD Allocated INT NULL;
  IF COL_LENGTH('dbo.Inventory','Available') IS NULL ALTER TABLE dbo.Inventory ADD Available INT NULL;
END
  `);

  // Try common inventory endpoints used by tenants
  const urls = [
    `${base}/inventory`,
    `${base}/api/v1/inventory`,
    `${base}/api/inventory`,
    `${base}/items/inventory`,
  ];

  let rows = [];
  let lastErr = null;

  for (const url of urls) {
    try {
      const r = await axios.get(url, { headers, timeout: TIMEOUT });
      rows = listify(r.data);
      if (rows.length) break;
    } catch (e) {
      lastErr = e;
    }
  }

  // If nothing came back, return a safe result instead of crashing boot
  if (!rows.length) {
    return {
      upsertedInventory: 0,
      note:
        lastErr?.response?.status
          ? `No rows from Extensiv (HTTP ${lastErr.response.status})`
          : "No rows from Extensiv",
    };
  }

  // Normalize + upsert
  let upserted = 0;
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const req = new sql.Request(tx);

    for (const rec of rows) {
      const item =
        rec?.ItemID ??
        rec?.ItemId ??
        rec?.ItemCode ??
        rec?.SKU ??
        rec?.ItemIdentifier?.ItemCode ??
        rec?.ItemIdentifier?.Sku ??
        "";

      if (!item) continue;

      const location =
        rec?.Location ??
        rec?.LocationId ??
        rec?.LocationIdentifier?.NameKey?.Name ??
        rec?.LocationIdentifier?.Name ??
        "";

      const onHand = Number(rec?.OnHand ?? rec?.QtyOnHand ?? rec?.QuantityOnHand ?? 0);
      const allocated = Number(rec?.Allocated ?? rec?.QtyAllocated ?? 0);
      const available = Number(rec?.Available ?? onHand - allocated);

      await req
        .input("ItemID", sql.VarChar(100), item)
        .input("Location", sql.VarChar(100), location || "")
        .input("OnHand", sql.Int, onHand)
        .input("Allocated", sql.Int, allocated)
        .input("Available", sql.Int, available)
        .query(`
MERGE dbo.Inventory AS t
USING (SELECT @ItemID AS ItemID, @Location AS Location) s
  ON t.ItemID = s.ItemID AND ISNULL(t.Location,'') = ISNULL(s.Location,'')
WHEN MATCHED THEN UPDATE
  SET OnHand=@OnHand, Allocated=@Allocated, Available=@Available
WHEN NOT MATCHED THEN INSERT (ItemID, Location, OnHand, Allocated, Available)
  VALUES (@ItemID, @Location, @OnHand, @Allocated, @Available);
        `);

      upserted++;
    }

    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }

  return { upsertedInventory: upserted };
}
