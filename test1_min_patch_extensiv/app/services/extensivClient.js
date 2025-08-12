import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

// token probe: returns token length + first/last chars (not the token itself)
r.get('/token', async (req, res) => {
  try {
    const { authHeaders } = await import('../services/extensivClient.js');
    const h = await authHeaders(); // forces token fetch inside
    const bearer = h.Authorization?.split(' ')[1] || '';
    res.json({
      ok: true,
      tokenLen: bearer.length,
      tokenHead: bearer.slice(0, 12),
      tokenTail: bearer.slice(-8),
      usedBaseUrl: process.env.EXT_BASE_URL,
      user_login: !!process.env.EXT_USER_LOGIN,
      tplguid: !!process.env.EXT_TPL_GUID
    });
  } catch (e) {
    console.error('[token probe]', e.response?.status, e.response?.data || e.message);
    res.status(500).json({ ok:false, status:e.response?.status, data:e.response?.data || e.message });
  }
});

let tokenCache = { access_token: null, exp: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.exp - 60_000) return tokenCache.access_token;

  const id = process.env.EXT_CLIENT_ID;
  const secret = process.env.EXT_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Missing EXT_CLIENT_ID / EXT_CLIENT_SECRET");

  const basic = Buffer.from(`${id}:${secret}`).toString("base64");

  // Box (secure-wms) sandbox typically requires: grant_type + user_login (+ user_login_id) + tplguid
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    user_login: process.env.EXT_USER_LOGIN || "",
    tplguid: process.env.EXT_TPL_GUID || ""
  });
  if (process.env.EXT_USER_LOGIN_ID) params.append("user_login_id", process.env.EXT_USER_LOGIN_ID);

  const resp = await axios.post(
    `${process.env.EXT_BASE_URL}/oauth/token`,
    params,
    { headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const { access_token, expires_in = 3600 } = resp.data || {};
  if (!access_token) throw new Error("No access_token in OAuth response");
  tokenCache = { access_token, exp: Date.now() + expires_in * 1000 };
  return access_token;
}

export async function authHeaders() {
  const bearer = await getAccessToken();
  const h = {
    Authorization: `Bearer ${bearer}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  // Many box endpoints expect these tenant scoping headers
  if (process.env.EXT_CUSTOMER_IDS) h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS; // e.g., ALL or comma-separated
  if (process.env.EXT_FACILITY_IDS) h["FacilityIds"] = process.env.EXT_FACILITY_IDS; // e.g., ALL or comma-separated
  return h;
}

export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  let page = 1, imported = 0;
  const pool = await getPool();

  while (true) {
    // ----- call orders API -----
    let list = [];
    try {
      const headers = await authHeaders();
      const resp = await axios.get(`${process.env.EXT_BASE_URL}/orders`, {
        headers,
        params: { modifiedDateStart: modifiedSince, status, page, pageSize }
      });
      const data = resp.data;
      list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("[Extensiv import] HTTP error", err.response?.status, err.response?.data || err.message);
      throw err;
    }
    if (!list.length) break;

    // ----- upsert into SQL -----
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const req = new sql.Request(tx);
      for (const o of list) {
        for (const it of (o.items || [])) {
          await req
            .input("OrderItemID", sql.Int, it.id ?? it.orderItemId ?? null)
            .input("ItemID", sql.VarChar(100), it.sku ?? "")
            .input("Qualifier", sql.VarChar(50), it.qualifier ?? "")
            .input("OrderedQty", sql.Int, Number(it.quantity ?? 0))
            .query(`
              MERGE [dbo].[OrderDetails] AS t
              USING (SELECT @OrderItemID AS OrderItemID) s
              ON t.OrderItemID = s.OrderItemID
              WHEN MATCHED THEN 
                UPDATE SET ItemID=@ItemID, Qualifier=@Qualifier, OrderedQTY=@OrderedQty
              WHEN NOT MATCHED THEN 
                INSERT (OrderItemID, ItemID, Qualifier, OrderedQTY)
                VALUES (@OrderItemID, @ItemID, @Qualifier, @OrderedQty);
            `);
        }
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      console.error("[SQL upsert error]", e);
      throw e;
    }

    imported += list.length;
    if (list.length < pageSize) break;
    page++;
  }

  return { imported };
}
