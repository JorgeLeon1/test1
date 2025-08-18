// app/routes/singleAllocApi.js
import express from "express";
import sql from "mssql";
import { authHeaders } from "../services/extensivClient.js";
import axios from "axios";

const router = express.Router();

/* --------------------- DB connection helper --------------------- */
async function connectToDatabase(query, params = []) {
  const pool = await sql.connect(process.env.DB_CONNECTION_STRING);
  const request = pool.request();
  for (const p of params) {
    request.input(p.name, p.type, p.value);
  }
  const result = await request.query(query);
  return result.recordset;
}

/* --------------------- Order payload helpers -------------------- */
function toInt(x, d = 0) {
  const n = parseInt(x);
  return Number.isNaN(n) ? d : n;
}

function toFloat(x, d = 0.0) {
  const n = parseFloat(x);
  return Number.isNaN(n) ? d : n;
}

// Extract order lines from the payload
function linesFromOrderPayload(order) {
  const emb = order?._embedded;

  // Extensiv often nests items here
  if (emb?.["http://api.3plCentral.com/rels/orders/item"]) {
    return emb["http://api.3plCentral.com/rels/orders/item"];
  }

  // Fallbacks
  if (Array.isArray(order?.OrderItems)) return order.OrderItems;
  if (Array.isArray(order?.Items)) return order.Items;

  return [];
}

// Convert lines to database row format
function mapLines(order, items = []) {
  const orderId = order.OrderId ?? order.orderId ?? order.id;
  const orderNum = order.OrderNumber ?? order.orderNumber ?? "";

  return items.map((line) => ({
    OrderId: toInt(orderId),
    OrderNumber: orderNum,
    OrderItemID: toInt(line.OrderItemId ?? line.id ?? 0),
    SKU: line.SKU ?? line.Sku ?? line.sku ?? "",
    OrderedQty: toFloat(line.OrderedQty ?? line.OrderedQuantity ?? 0),
    AllocatedQty: toFloat(line.AllocatedQty ?? line.AllocatedQuantity ?? 0),
    InvoicedQty: toFloat(line.InvoicedQty ?? line.InvoicedQuantity ?? 0),
    PickedQty: toFloat(line.PickedQty ?? line.PickedQuantity ?? 0),
    Qualifier: line.Qualifier ?? "",
    WarehouseId: toInt(line.WarehouseId ?? 0),
    CustomerId: toInt(order.CustomerId ?? 0),
    Status: order.Status ?? "",
  }));
}

/* ------------------------ API endpoints ------------------------- */

// Fetch an order and save its lines to DB
router.get("/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({ ok: false, message: "Missing orderId" });
    }

    // Call Extensiv API
    const { data } = await axios.get(
      `https://api.3plCentral.com/orders/v1/${orderId}`,
      { headers: authHeaders() }
    );

    // Debugging: log structure to console
    console.log("RAW EXTENSIV ORDER PAYLOAD:", JSON.stringify(data, null, 2));

    const items = linesFromOrderPayload(data);
    const rows = mapLines(data, items);

    if (!rows.length) {
      return res.json({ ok: true, message: "No order lines found", rows: [] });
    }

    // Save into DB (upsert style)
    for (const row of rows) {
      await connectToDatabase(
        `
        MERGE OrderDetails AS target
        USING (SELECT @OrderItemID AS OrderItemID) AS src
        ON target.OrderItemID = src.OrderItemID
        WHEN MATCHED THEN UPDATE SET
          OrderId = @OrderId,
          OrderNumber = @OrderNumber,
          SKU = @SKU,
          OrderedQty = @OrderedQty,
          AllocatedQty = @AllocatedQty,
          InvoicedQty = @InvoicedQty,
          PickedQty = @PickedQty,
          Qualifier = @Qualifier,
          WarehouseId = @WarehouseId,
          CustomerId = @CustomerId,
          Status = @Status
        WHEN NOT MATCHED THEN INSERT
          (OrderId, OrderNumber, OrderItemID, SKU, OrderedQty, AllocatedQty,
           InvoicedQty, PickedQty, Qualifier, WarehouseId, CustomerId, Status)
        VALUES
          (@OrderId, @OrderNumber, @OrderItemID, @SKU, @OrderedQty, @AllocatedQty,
           @InvoicedQty, @PickedQty, @Qualifier, @WarehouseId, @CustomerId, @Status);
        `,
        [
          { name: "OrderId", type: sql.Int, value: row.OrderId },
          { name: "OrderNumber", type: sql.NVarChar, value: row.OrderNumber },
          { name: "OrderItemID", type: sql.Int, value: row.OrderItemID },
          { name: "SKU", type: sql.NVarChar, value: row.SKU },
          { name: "OrderedQty", type: sql.Float, value: row.OrderedQty },
          { name: "AllocatedQty", type: sql.Float, value: row.AllocatedQty },
          { name: "InvoicedQty", type: sql.Float, value: row.InvoicedQty },
          { name: "PickedQty", type: sql.Float, value: row.PickedQty },
          { name: "Qualifier", type: sql.NVarChar, value: row.Qualifier },
          { name: "WarehouseId", type: sql.Int, value: row.WarehouseId },
          { name: "CustomerId", type: sql.Int, value: row.CustomerId },
          { name: "Status", type: sql.NVarChar, value: row.Status },
        ]
      );
    }

    res.json({ ok: true, rows });
  } catch (err) {
    console.error("Error in /single-alloc/:orderId:", err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
});

export default router;
