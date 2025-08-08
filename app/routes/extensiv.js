import { Router } from "express";
import { fetchAndUpsertOrders } from "../services/extensivClient.js";
import { runAllocationAndRead } from "../services/allocService.js";
import { pushAllocations } from "../services/pushAllocations.js";

const r = Router();

r.post("/import", async (req, res, next) => {
  try {
    const { modifiedSince, status, pageSize } = req.body || {};
    const result = await fetchAndUpsertOrders({ modifiedSince, status, pageSize });
    res.json(result);
  } catch (e) { next(e); }
});

r.post("/allocate", async (_req, res, next) => {
  try {
    const { applied, rows } = await runAllocationAndRead();
    res.json({ applied, suggestions: rows });
  } catch (e) { next(e); }
});

r.post("/push", async (_req, res, next) => {
  try {
    const result = await pushAllocations();
    res.json(result);
  } catch (e) { next(e); }
});

export default r;
