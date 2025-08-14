// src/app/services/extensivClient.js
import axios from "axios";

/* ------------------------ shared helpers / auth ------------------------ */

const trimBase = (u) => (u || "").replace(/\/+$/, "");
const BASE =
  trimBase(process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://box.secure-wms.com");

function basicHeaderFromEnv() {
  const b64 = process.env.EXT_BASIC_AUTH_B64 || "";
  return b64 ? `Basic ${b64}` : null;
}

async function getBearerViaOAuth() {
  const tokenUrl = process.env.EXT_TOKEN_URL;
  if (!tokenUrl) return null;

  try {
    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");
    if (process.env.EXT_USER_LOGIN) form.set("user_login", process.env.EXT_USER_LOGIN);
    if (process.env.EXT_USER_LOGIN_ID) form.set("user_login_id", process.env.EXT_USER_LOGIN_ID);
    if (process.env.EXT_TPL_GUID) form.set("tplguid", process.env.EXT_TPL_GUID);

    const auth = basicHeaderFromEnv(); // base64(clientId:clientSecret)
    const resp = await axios.post(tokenUrl, form, {
      headers: {
        Authorization: auth || "",
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (resp.status >= 200 && resp.status < 300 && resp.data?.access_token) {
      return `Bearer ${resp.data.access_token}`;
    }
    return null;
  } catch {
    return null;
  }
}

export async function authHeaders() {
  const mode = (process.env.EXT_AUTH_MODE || "").toLowerCase();
  if (mode === "bearer" || process.env.EXT_TOKEN_URL) {
    const bearer = await getBearerViaOAuth();
    if (bearer) {
      return {
        Authorization: bearer,
        Accept: "application/hal+json, application/json",
        "Content-Type": "application/hal+json; charset=utf-8",
      };
    }
  }
  const basic = basicHeaderFromEnv();
  if (!basic) {
    throw new Error("No auth configured: set EXT_BASIC_AUTH_B64 or EXT_TOKEN_URL (+ client id/secret).");
  }
  return {
    Authorization: basic,
    Accept: "application/hal+json, application/json",
    "Content-Type": "application/hal+json; charset=utf-8",
  };
}

/* ---------------------------- order + inv API --------------------------- */

export async function getOrderWithItems(orderId) {
  const headers = await authHeaders();
  const { data } = await axios.get(`${BASE}/orders/${orderId}`, {
    headers,
    params: { detail: "All", itemdetail: "All" },
    timeout: 20000,
  });
  return data;
}

export function extractOrderItems(order) {
  const em = order?._embedded;
  if (em && Array.isArray(em["http://api.3plcentral.com/rels/orders/item"])) {
    return em["http://api.3plcentral.com/rels/orders/item"];
  }
  return [];
}

// Receive-level inventory with receiveItemId for a single SKU (optionally filter by facility)
export async function getReceiveInventoryBySku({ sku, facilityId, pageSize = 1000 }) {
  const headers = await authHeaders();
  const rql = facilityId
    ? `itemIdentifier.sku==${sku};facilityIdentifier.id==${facilityId}`
    : `itemIdentifier.sku==${sku}`;

  const { data } = await axios.get(`${BASE}/inventory`, {
    headers,
    params: { pgsiz: pageSize, pgnum: 1, rql },
    timeout: 20000,
  });

  const list = data?._embedded?.item;
  return Array.isArray(list) ? list : [];
}

/* ------------------------------ allocator -------------------------------- */

function planForOneItem({ needQty, invRows }) {
  const sorted = [...invRows].sort((a, b) => {
    const da = new Date(a.receivedDate).getTime() || 0;
    const db = new Date(b.receivedDate).getTime() || 0;
    return da - db; // FIFO
  });

  const chunks = [];
  let remaining = Number(needQty) || 0;

  for (const row of sorted) {
    if (remaining <= 0) break;
    const avail = Math.max(0, Number(row.availableQty) || 0);
    if (!avail) continue;

    const take = Math.min(remaining, avail);
    chunks.push({ receiveItemId: row.receiveItemId, qty: take });
    remaining -= take;
  }
  return { chunks, remaining };
}

export async function buildAllocationPlan(order) {
  const orderId =
    order?.readOnly?.orderId ?? order?.ReadOnly?.OrderId ?? order?.orderId ?? null;
  const facilityId =
    order?.readOnly?.facilityIdentifier?.id ??
    order?.ReadOnly?.FacilityIdentifier?.Id ??
    null;

  const items = extractOrderItems(order);

  const plan = [];
  const debug = [];

  for (const it of items) {
    const orderItemId =
      it?.readOnly?.orderItemId ?? it?.ReadOnly?.OrderItemId ?? it?.orderItemId;
    const sku =
      it?.itemIdentifier?.sku ??
      it?.ItemIdentifier?.Sku ??
      it?.sku;
    const already = Array.isArray(it?.readOnly?.allocations) ? it.readOnly.allocations : [];
    const alreadyQty = already.reduce((s, a) => s + (Number(a?.qty) || 0), 0);
    const needQty = Math.max(0, (Number(it?.qty) || 0) - alreadyQty);

    if (!orderItemId || !sku || needQty <= 0) {
      debug.push({ orderItemId, sku, skipped: true, reason: "no need or missing ids", needQty });
      continue;
    }

    const inv = await getReceiveInventoryBySku({ sku, facilityId });
    const availableRows = inv.filter(r => (Number(r.availableQty) || 0) > 0);

    const { chunks, remaining } = planForOneItem({ needQty, invRows: availableRows });

    debug.push({
      orderItemId,
      sku,
      needQty,
      availableBins: availableRows.length,
      plannedBins: chunks.length,
      remaining,
    });

    if (chunks.length) {
      plan.push({ orderItemId, proposedAllocations: chunks });
    }
  }

  return { orderId, plan, debug };
}

export async function postAllocation(orderId, plan) {
  const headers = await authHeaders();
  const url = `${BASE}/orders/${orderId}/allocator`;
  const body = { proposedAllocations: plan };

  const resp = await axios.post(url, body, {
    headers,
    timeout: 20000,
    validateStatus: () => true,
  });

  return { status: resp.status, data: resp.data };
}

/* ------------------------------ 1-shot API ------------------------------ */

export async function allocateOrderById(orderId) {
  const order = await getOrderWithItems(orderId);
  const { plan, debug } = await buildAllocationPlan(order);

  if (!plan.length) {
    return { ok: false, posted: false, reason: "Nothing to allocate", debug };
  }

  const post = await postAllocation(orderId, plan);
  const ok = post.status >= 200 && post.status < 300;

  return {
    ok,
    posted: true,
    status: post.status,
    response: post.data,
    summary: {
      orderId,
      itemsPlanned: plan.length,
      totalChunks: plan.reduce((s, p) => s + p.proposedAllocations.length, 0),
      totalQty: plan
        .flatMap(p => p.proposedAllocations)
        .reduce((s, c) => s + (Number(c.qty) || 0), 0),
    },
    debug,
    postedPayload: { proposedAllocations: plan },
  };
}
