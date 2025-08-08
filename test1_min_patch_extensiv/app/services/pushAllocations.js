import axios from "axios";
import { getPool } from "./db/mssql.js";

export async function pushAllocations() {
  const pool = await getPool();
  const { recordset: sugg } = await pool.request().query(`SELECT OrderItemID, ReceiveItemID, SuggAllocQty FROM SuggAlloc ORDER BY OrderItemID;`);
  if (!sugg.length) return { pushed: 0, note: "No rows in SuggAlloc" };
  const headers = {
    Authorization: `Basic ${Buffer.from(`${process.env.EXT_API_KEY}:${process.env.EXT_API_SECRET}`).toString("base64")}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  let pushed = 0;
  if ((process.env.EXT_PUSH_MODE || "custom") === "custom") {
    const url = `${process.env.EXT_BASE_URL}/custom/allocations`;
    const payload = sugg.map(r => ({ orderItemId: r.OrderItemID, receiveItemId: r.ReceiveItemID, qty: r.SuggAllocQty }));
    const { data } = await axios.post(url, payload, { headers });
    pushed = Array.isArray(data?.processed) ? data.processed.length : payload.length;
  } else {
    for (const row of sugg) {
      await axios.post(`${process.env.EXT_BASE_URL}/orders/allocate`, row, { headers });
      pushed++;
    }
  }
  return { pushed };
}
