// app/routes/extensiv.js
import { Router } from "express";
import axios from "axios";
import { fetchAndUpsertOrders, authHeaders } from "../services/extensivClient.js";
import { runAllocationAndRead } from "../services/allocService.js";
import { pushAllocations } from "../services/pushAllocations.js";

const r = Router();
const baseUrl = () =>
  (process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com").replace(/\/+$/, "");

// ---------- Debug ----------
r.get("/_debug", (_req, res) => {
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
      EXT_FACILITY_IDS: !!process.env.EXT_FACILITY_IDS,
    },
  });
});

// ---------- Token probe ----------
r.get("/token", async (_req, res) => {
  try {
    const h = await authHeaders();
    const [scheme, value = ""] = (h.Authorization || "").split(" ");
    res.json({
      ok: true,
      scheme,
      tokenLen: value.length,
      head: value.slice(0, 12),
      tail: value.slice(-8),
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      status: e.response?.status || null,
      data: e.response?.data || e.message,
    });
  }
});

// ---------- Ping orders (NO query params on legacy) ----------
r.get("/ping2", async (_req, res) => {
  const base = baseUrl();
  const tried = [];
  try {
    const headers = await authHeaders();

    // 1) Legacy /orders — headers only, no params
    try {
      const url = `${base}/orders`;
      const resp = await axios.get(url, { headers, timeout: 15000 });
      const data = resp.data;
      const count = Array.isArray(data?.data)
        ? data.data.length
        : Array.isArray(data)
        ? data.length
        : null;
      return res.json({ ok: true, winner: url, status: resp.status, count });
    } catch (e) {
      tried.push({
        url: `${base}/orders`,
        status: e.response?.status || null,
        data: e.response?.data || String(e),
      });
    }

    // 2) v1 fallback — also try without params first
    try {
      const url = `${base}/api/v1/orders`;
      const resp = await axios.get(url, { headers, timeout: 15000 });
      const data = resp.data;
      const count = Array.isArray(data?.data)
        ? data.data.length
        : Array.isArray(data)
        ? data.length
        : null;
      return res.json({ ok: true, winner: url, status: resp.status, count });
    } catch (e) {
      tried.push({
        url: `${base}/api/v1/orders`,
        status: e.response?.status || null,
        data: e.response?.data || String(e),
      });
    }

    return res.status(500).json({ ok: false, tried });
  } catch (e) {
    return res.status(500).json({ ok: false, err: e.message, tried });
  }
});

// ---------- Peek payload shape (helps listify importer) ----------
r.get("/peek", async (_req, res) => {
  try {
    const headers = await authHeaders();
    const url = `${baseUrl()}/orders`;
    const resp = await axios.get(url, { headers, timeout: 15000 });
    const data = resp.data;

    let firstArrayKey = null,
      firstArrayLen = null,
      sample = null;

    if (Array.isArray(data)) {
      firstArrayKey = "(rootArray)";
      firstArrayLen = data.length;
      sample = data[0] ?? null;
    } else if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v)) {
          firstArrayKey = k;
          firstArrayLen = v.length;
          sample = v[0] ?? null;
          break;
        }
      }
    }

    res.json({
      ok: true,
      status: resp.status,
      topLevelType: Array.isArray(data) ? "array" : typeof data,
      keys: data && typeof data === "object" ? Object.keys(data) : null,
      firstArrayKey,
      firstArrayLen,
      sample,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      status: e.response?.status || null,
      data: e.response?.data || e.message,
    });
  }
});

// ---------- Actions ----------
r.post("/import", async (req, res, next) => {
  try {
    res.json(await fetchAndUpsertOrders(req.body || {}));
  } catch (e) {
    next(e);
  }
});

r.post("/allocate", async (_req, res, next) => {
  try {
    const { applied, rows } = await runAllocationAndRead();
    res.json({ applied, suggestions: rows });
  } catch (e) {
    next(e);
  }
});

r.post("/push", async (_req, res, next) => {
  try {
    res.json(await pushAllocations());
  } catch (e) {
    next(e);
  }
});

export default r;
