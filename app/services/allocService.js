import { getPool } from "./db/mssql.js";

export async function runAllocationAndRead() {
  const pool = await getPool();
  await pool.request().query(`DELETE FROM SuggAlloc;`);
  await pool.request().query(`
DECLARE @RemainingOpenQty INT;
SET @RemainingOpenQty = 1;
WHILE @RemainingOpenQty > 0
BEGIN
  INSERT INTO SuggAlloc (OrderItemID, ReceiveItemID, SuggAllocQty)
  SELECT TOP 1 OrderItemID, ReceiveItemID,
    CASE WHEN RemainingOpenQty >= AvailableQTY THEN AvailableQTY ELSE RemainingOpenQty END AS AllocQty
  FROM (
    SELECT
      a.OrderItemID, a.OrderedQTY, b.ReceiveItemID, b.AvailableQTY,
      ISNULL(c.SumSuggAllocQty,0) AS SumSuggAllocQty,
      a.OrderedQTY - ISNULL(c.SumSuggAllocQty,0) AS RemainingOpenQty,
      LocationName,
      CASE
        WHEN b.ReceivedQty=b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) = AvailableQTY THEN 1
        WHEN b.ReceivedQty=b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) = AvailableQTY THEN 2
        WHEN b.ReceivedQty=b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) > AvailableQTY THEN 3
        WHEN b.ReceivedQty=b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) > AvailableQTY THEN 4
        WHEN b.ReceivedQty>b.AvailableQty AND SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >= AvailableQTY THEN 5
        WHEN b.ReceivedQty>b.AvailableQty AND SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) >= AvailableQTY THEN 6
        WHEN SUBSTRING(b.LocationName,4,1) = 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) <= AvailableQTY THEN 7
        WHEN SUBSTRING(b.LocationName,4,1) <> 'A' AND (a.OrderedQTY-ISNULL(c.SumSuggAllocQty,0)) <= AvailableQTY THEN 8
      END AS Seq
    FROM [dbo].[OrderDetails] a
    LEFT JOIN [dbo].[Inventory] b ON a.ItemID = b.ItemID AND a.Qualifier = b.Qualifier
    LEFT JOIN (SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) SumSuggAllocQty FROM SuggAlloc GROUP BY OrderItemID) c
      ON a.OrderItemID = c.OrderItemID
    WHERE b.ReceiveItemId NOT IN (SELECT DISTINCT ReceiveItemID FROM SuggAlloc)
      AND b.AvailableQTY > 0
  ) x
  WHERE RemainingOpenQty > 0
  ORDER BY OrderItemID, Seq ASC,
    CASE WHEN Seq IN (1,2,3,4,5,6) THEN AvailableQty+0 WHEN Seq IN (7,9) THEN 999999-AvailableQty END DESC;

  SET @RemainingOpenQty = (
    SELECT TOP 1 ISNULL(OrderedQty - SumSuggAllocQty,0)
    FROM (
      SELECT a.*, b.SumSuggAllocQty
      FROM OrderDetails a
      LEFT JOIN (SELECT OrderItemID, SUM(ISNULL(SuggAllocQty,0)) SumSuggAllocQty FROM SuggAlloc GROUP BY OrderItemID) b
      ON a.OrderItemID = b.OrderItemID
    ) y
  );
END
  `);
  const rows = (await pool.request().query(`SELECT OrderItemID, ReceiveItemID, SuggAllocQty FROM SuggAlloc ORDER BY OrderItemID;`)).recordset;
  return { applied: rows.length, rows };
}
