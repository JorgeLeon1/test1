// app/services/allocService.js
import { getPool, sql } from "./db/mssql.js";

/**
 * Greedy allocation: for each order line in dbo.OrderDetails,
 * grab from Inventory rows (same ItemID) sorted by Available DESC
 * until the line qty is satisfied. Writes dbo.Allocations.
 */
export async function runAllocationAndRead() {
  const pool = await getPool();

  // tables
  await pool.request().batch(`
IF OBJECT_ID('dbo.Allocations','U') IS NULL
BEGIN
  CREATE TABLE dbo.Allocations (
    Id         INT IDENTITY(1,1) PRIMARY KEY,
    OrderId    INT NULL,
    ItemID     VARCHAR(100) NOT NULL,
    Qualifier  VARCHAR(50)  NULL,
    Location   VARCHAR(100) NULL,
    Qty        INT          NOT NULL DEFAULT 0,
    CreatedAt  DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
  `);

  // load demand (order lines) and supply (inventory)
  const lines = (await pool.request().query(`
    SELECT OrderId, ItemID, ISNULL(Qualifier,'') as Qualifier, OrderedQTY
    FROM dbo.OrderDetails
  `)).recordset;

  const invRows = (await pool.request().query(`
    SELECT ItemID, ISNULL(Location,'') AS Location, Available
    FROM dbo.Inventory WHERE Available > 0
  `)).recordset;

  // index inventory by item
  const byItem = new Map();
  for (const r of invRows) {
    if (!byItem.has(r.ItemID)) byItem.set(r.ItemID, []);
    byItem.get(r.ItemID).push({ loc: r.Location, avail: Number(r.Available) || 0 });
  }
  for (const arr of byItem.values()) arr.sort((a,b)=>b.avail-a.avail);

  // allocate
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const req = new sql.Request(tx);
    let applied = 0;

    for (const line of lines) {
      let need = Number(line.OrderedQTY) || 0;
      const buckets = byItem.get(line.ItemID) || [];
      for (const b of buckets) {
        if (need <= 0 || b.avail <= 0) continue;
        const take = Math.min(need, b.avail);
        await req
          .input("OrderId", sql.Int, line.OrderId ?? null)
          .input("ItemID", sql.VarChar(100), line.ItemID)
          .input("Qualifier", sql.VarChar(50), line.Qualifier || "")
          .input("Location", sql.VarChar(100), b.loc || "")
          .input("Qty", sql.Int, take)
          .query(`
INSERT INTO dbo.Allocations (OrderId, ItemID, Qualifier, Location, Qty)
VALUES (@OrderId, @ItemID, @Qualifier, @Location, @Qty);
          `);
        b.avail -= take;
        need    -= take;
        applied += take;
        if (need <= 0) break;
      }
    }

    await tx.commit();

    // return what we wrote
    const rows = (await pool.request().query(`
      SELECT TOP 200 * FROM dbo.Allocations ORDER BY Id DESC
    `)).recordset;

    return { applied, rows };
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}
