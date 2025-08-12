import { Router } from "express";
import axios from "axios";
import { fetchAndUpsertOrders, authHeaders } from "../services/extensivClient.js";
import { runAllocationAndRead } from "../services/allocService.js";
import { pushAllocations } from "../services/pushAllocations.js";

const r = Router();

r.get('/_debug', (req, res) => {
  res.json({
    routeMounted: true,
    envPresent: {
      EXT_BASE_URL: !!process.env.EXT_BASE_URL,
      EXT_CLIENT_ID: !!process.env.EXT_CLIENT_ID,
      EXT_CLIENT_SECRET: !!process.env.EXT_CLIENT_SECRET,
      EXT_TPL_GUID: !!process.env.EXT_TPL_GUID,
      EXT_USER_LOGIN: !!process.env.EXT_USER_LOGIN,
      EXT_USER_LOGIN_ID: !!process.env.EXT_USER_LOGIN_ID,
      EXT_CUSTOMER_IDS: !!process.env.EXT_CUSTOMER_IDS,
      EXT_FACILITY_IDS: !!process.env.EXT_FACILITY_IDS
    }
  });
});

r.get('/token', async (_req, res) => {
  try {
    const h = await authHeaders();
    const bearer = h.Authorization?.split(' ')[1] || '';
    res.json({ ok: true, tokenLen: bearer.length, head: bearer.slice(0,12), tail: bearer.slice(-8) });
  } catch (e) {
    res.status(500).json({ ok:false, status:e.response?.status, data:e.response?.data || e.message });
  }
});

r.get('/ping2', async (_req, res) => {
  const base = (process.env.EXT_BASE_URL || '').replace(/\/+$/, '');
  const h0 = await authHeaders();
  const combos = [
    { path: '/orders',     label: 'Customer/Facility (ALL)',
      hdrs: h => ({ ...h, CustomerIds: process.env.EXT_CUSTOMER_IDS || 'ALL', FacilityIds: process.env.EXT_FACILITY_IDS || 'ALL' }) },
    { path: '/api/orders', label: 'Customer/Facility (ALL) + /api',
      hdrs: h => ({ ...h, CustomerIds: process.env.EXT_CUSTOMER_IDS || 'ALL', FacilityIds: process.env.EXT_FACILITY_IDS || 'ALL' }) },
    { path: '/orders',     label: '3PL-Warehouse/Customer',
      hdrs: h => ({ ...h, '3PL-Warehouse-Id': process.env.EXT_WAREHOUSE_ID || '', '3PL-Customer-Id': process.env.EXT_CUSTOMER_ID || '' }) },
    { path: '/api/orders', label: '3PL-Warehouse/Customer + /api',
      hdrs: h => ({ ...h, '3PL-Warehouse-Id': process.env.EXT_WAREHOUSE_ID || '', '3PL-Customer-Id': process.env.EXT_CUSTOMER_ID || '' }) },
  ];
  const results = [];
  for (const c of combos) {
    const url = base + c.path;
    try {
      const resp = await axios.get(url, { headers: c.hdrs(h0), params: { page:1, pageSize:1 } });
      return res.json({ ok:true, winner:{ url, headerSet:c.label }, sample: resp.data?.data?.[0] || resp.data });
    } catch (e) {
      results.push({ url, headerSet:c.label, status:e.response?.status || null, data:e.response?.data || String(e.message) });
    }
  }
  res.status(500).json({ ok:false, tried: results });
});

// existing endpoints
r.post('/import', async (req, res, next) => { try { res.json(await fetchAndUpsertOrders(req.body || {})); } catch (e) { next(e); }});
r.post('/allocate', async (_req, res, next) => { try { const { applied, rows } = await runAllocationAndRead(); res.json({ applied, suggestions: rows }); } catch (e) { next(e); }});
r.post('/push', async (_req, res, next) => { try { res.json(await pushAllocations()); } catch (e) { next(e); }});

export default r;
