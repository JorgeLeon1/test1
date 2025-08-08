// app/routes/extensiv.js
import { Router } from "express";
import { fetchAndUpsertOrders, authHeaders } from "../services/extensivClient.js";
import { runAllocationAndRead } from "../services/allocService.js";
import { pushAllocations } from "../services/pushAllocations.js";
import axios from "axios";

const r = Router();

// Debug: verify route is mounted and envs (not values) exist
r.get('/_debug', (req, res) => {
  res.json({
    routeMounted: true,
    envPresent: {
      SQL_SERVER: !!process.env.SQL_SERVER,
      SQL_DATABASE: !!process.env.SQL_DATABASE,
      SQL_USER: !!process.env.SQL_USER,
      SQL_PASSWORD: !!process.env.SQL_PASSWORD,
      EXT_BASE_URL: !!process.env.EXT_BASE_URL,
      EXT_API_KEY: !!process.env.EXT_API_KEY,
      EXT_API_SECRET: !!process.env.EXT_API_SECRET,
      EXT_WAREHOUSE_ID: !!process.env.EXT_WAREHOUSE_ID,
      EXT_CUSTOMER_ID: !!process.env.EXT_CUSTOMER_ID,
    }
  });
});

// Ping Extensiv to see the exact HTTP error/status
r.get('/ping', async (req, res) => {
  try {
    const resp = await axios.get(`${process.env.EXT_BASE_URL}/orders`, {
      headers: authHeaders(),
      params: { page: 1, pageSize: 1 }
    });
    res.json({ ok: true, status: resp.status, sample: resp.data?.data?.[0] || resp.data });
  } catch (e) {
    console.error("[/extensiv/ping]", e.response?.status, e.response?.data || e.message);
    res.status(500).json({
      ok: false,
      status: e.response?.status,
      data: e.response?.data || e.message
    });
  }
});

r.post('/import', async (req, res, next) => {
  try {
    console.log("[/extensiv/import] body:", req.body);
    const result = await fetchAndUpsertOrders(req.body || {});
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/allocate', async (_req, res, next) => {
  try {
    console.log("[/extensiv/allocate]");
    const { applied, rows } = await runAllocationAndRead();
    res.json({ applied, suggestions: rows });
  } catch (e) { next(e); }
});

r.post('/push', async (_req, res, next) => {
  try {
    console.log("[/extensiv/push]");
    const result = await pushAllocations();
    res.json(result);
  } catch (e) { next(e); }
});

export default r;
