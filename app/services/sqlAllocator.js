// src/app/services/sqlAllocator.js
import { getPool, sql } from "./db/mssql.js";

/**
 * Ensures SuggAlloc table exists.
 * Columns match your script: OrderItemID, ReceiveItemID, SuggAllocQty (+CreatedAt).
 */
async function ensureTables(pool) {
  await pool.request().batch(`
IF OBJECT_ID('dbo.SuggAlloc','U') IS NULL
BEGIN
  CREATE TABLE dbo.SuggAlloc (
    OrderItemID   INT         NOT NULL,
    ReceiveItemID INT         NOT NULL,
    SuggAllocQty  INT         NOT NULL,
    CreatedAt     DATETIME2   NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_SuggAlloc_OrderItemID ON dbo.SuggAlloc(OrderItemID);
END
`);
}

/**
 * Runs your while-loop allocation for a single order.
 * Optionally restrict to a subset of order-item IDs.
 *
 * @param {number} orderId
 * @param {number[]} orderItemIds optional subset
 */
export async function runSqlAllocation(orderId, orderItemIds = []) {
  if (!orderId) return { ok: false, message: "orderId required" };

  const pool = await getPool();
  await ensureTables(pool);

  // Build a CSV safely for a temp list (we'll cast to int in SQL)
  const csv = (orderItemIds || []).filter(Number.isFinite).join(",");

  const result = await pool.request()
    .input("OrderId", sql.Int, orderId)
    .input("CsvIds", sql.VarChar(sql.MAX), csv)
    .query(`
SET NOCOUNT ON;

-- Scope the working set to the selected order (and optionally a subset of items)
-- Build a temp table of selected OrderItemIDs (if provided)
DECLARE @Ids TABLE (OrderItemID INT PRIMARY KEY);
IF LEN(ISNULL(@CsvIds, '')) > 0
BEGIN
  INSERT INTO @Ids(OrderItemID)
  SELECT DISTINCT TRY_CAST(value AS INT)
  FROM STRING_SPLIT(@CsvIds, ',')
  WHERE TRY_CAST(value AS INT) IS NOT NULL;
END

-- Clean only this order's existing suggestions (or subset), not the whole table
DELETE SA
FROM dbo.SuggAlloc SA
JOIN dbo.OrderDetails OD ON OD.OrderItemID = SA.OrderItemID
WHERE OD.OrderId = @OrderId
  AND (NOT EXISTS (SELECT 1 FROM @Ids) OR SA.OrderItemID IN (SELECT OrderItemID FROM @Ids));

/*
  Your allocation logic (loop) adapted:
  - Scopes to a.OrderId = @OrderId
  - Optional subset filter: if @Ids has rows, only those OrderItemIDs are considered
  - Uses [dbo].[Inventory] as in your script (expects: ReceiveItemID, AvailableQTY, ReceivedQty, LocationName)
*/

DECLARE @RemainingOpenQty INT = 1;

WHILE @RemainingOpenQty > 0
BEGIN
  INSERT INTO dbo.SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
  SELECT TOP 1
    t.OrderItemID,
    t.ReceiveItemID,
    CASE WHEN t.RemainingOpenQty >= t.AvailableQTY THEN t.AvailableQTY ELSE t.RemainingOpenQty END AS AllocQty
  FROM (
    SELECT
      a.OrderItemID,
      a.OrderedQTY,
      b.ReceiveItemID,
      b.AvailableQTY,
      ISNULL(c.SumSuggAllocQty,0)                             AS SumSuggAllocQty,
      a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0)              AS RemainingOpenQty,
      b.LocationName,
      CASE
        WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) = b.AvailableQTY THEN 1
        WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) = b.AvailableQTY THEN 2
        WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >  b.AvailableQTY THEN 3
        WHEN b.ReceivedQty = b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >  b.AvailableQTY THEN 4
        WHEN b.ReceivedQty >  b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY THEN 5
        WHEN b.ReceivedQty >  b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >= b.AvailableQTY THEN 6
        WHEN SUBSTRING(b.LocationName,4,1) =  'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) <= b.AvailableQTY THEN 7
        WHEN SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) <= b.AvailableQTY THEN 8
      END AS Seq
    FROM [dbo].[OrderDetails] a
    LEFT JOIN [dbo].[Inventory] b
      ON a.ItemID = b.ItemID
     AND a.Qualifier = b.Qualifier
    LEFT JOIN (
      SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
      FROM dbo.SuggAlloc
      GROUP BY OrderItemID
    ) c
      ON a.OrderItemID = c.OrderItemID
    WHERE a.OrderId = @OrderId
      AND b.AvailableQTY > 0
      AND b.ReceiveItemId NOT IN (SELECT DISTINCT ReceiveItemID FROM dbo.SuggAlloc)
      AND (NOT EXISTS (SELECT 1 FROM @Ids) OR a.OrderItemID IN (SELECT OrderItemID FROM @Ids))
  ) t
  WHERE t.RemainingOpenQty > 0
  ORDER BY
    t.OrderItemID,
    t.Seq ASC,
    CASE WHEN t.Seq IN (1,2,3,4,5,6) THEN t.AvailableQty + 0
         WHEN t.Seq IN (7,9) THEN 999999 - t.AvailableQty
    END DESC;

  -- recompute remaining on the specific scope
  SET @RemainingOpenQty =
  (
    SELECT TOP 1 ISNULL(OrderedQty - SumSuggAllocQty, 0)
    FROM (
      SELECT a.OrderItemID, a.OrderedQty, b.SumSuggAllocQty
      FROM dbo.OrderDetails a
      LEFT JOIN (
        SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) AS SumSuggAllocQty
        FROM dbo.SuggAlloc
        GROUP BY OrderItemID
      ) b ON a.OrderItemID = b.OrderItemID
      WHERE a.OrderId = @OrderId
        AND (NOT EXISTS (SELECT 1 FROM @Ids) OR a.OrderItemID IN (SELECT OrderItemID FROM @Ids))
    ) z
    ORDER BY (OrderedQty - ISNULL(SumSuggAllocQty,0)) DESC
  );
  IF @RemainingOpenQty IS NULL SET @RemainingOpenQty = 0;
END;

-- Return the suggestions for the order (or subset)
SELECT SA.OrderItemID, SA.ReceiveItemID, SA.SuggAllocQty
FROM dbo.SuggAlloc SA
JOIN dbo.OrderDetails OD ON OD.OrderItemID = SA.OrderItemID
WHERE OD.OrderId = @OrderId
  AND (NOT EXISTS (SELECT 1 FROM @Ids) OR SA.OrderItemID IN (SELECT OrderItemID FROM @Ids))
ORDER BY SA.OrderItemID, SA.ReceiveItemID;
`);

  return { ok: true, orderId, rows: result.recordset, count: result.recordset.length };
}
