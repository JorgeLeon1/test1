// app/services/extensivClient.js
import axios from "axios";
import { getPool, sql } from "./db/mssql.js";

let tokenCache = { access_token: null, exp: 0 };

function apiBase() {
  // prefer EXT_API_BASE; else EXT_BASE_URL; else secure-wms.com
  return (process.env.EXT_API_BASE || process.env.EXT_BASE_URL || "https://secure-wms.com").replace(/\/+$/,"");
}

export async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.exp - 60_000) return tokenCache.access_token;

  const clientId = process.env.EXT_CLIENT_ID;
  const clientSecret = process.env.EXT_CLIENT_SECRET;
  const tplId = process.env.EXT_TPL || process.env.EXT_TPL_ID;    // e.g. "8179"
  const tplGuid = process.env.EXT_TPL_GUID;                        // optional GUID
  const userLoginId = process.env.EXT_USER_LOGIN_ID;               // e.g. "246"
  if (!clientId || !clientSecret) throw new Error("Missing EXT_CLIENT_ID / EXT_CLIENT_SECRET");
  if (!userLoginId) throw new Error("Missing EXT_USER_LOGIN_ID");
  if (!tplId && !tplGuid) throw new Error("Missing EXT_TPL or EXT_TPL_GUID");

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenUrl = "https://secure-wms.com/AuthServer/api/Token";  // per docs

  const body = {
    grant_type: "client_credentials",
    user_login_id: userLoginId,
    ...(tplGuid ? { tplguid: tplGuid } : { tpl: tplId })
  };

  const resp = await axios.post(tokenUrl, body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Accept": "application/json",
      "Authorization": `Basic ${basic}`
    },
    timeout: 20000
  });

  const { access_token, expires_in = 1800 } = resp.data || {};
  if (!access_token) throw new Error("No access_token in token response");
  tokenCache = { access_token, exp: Date.now() + expires_in * 1000 };
  return access_token;
}

export async function authHeaders() {
  const token = await getAccessToken();
  const h = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (process.env.EXT_CUSTOMER_IDS) h["CustomerIds"] = process.env.EXT_CUSTOMER_IDS; // "ALL" or "1,2,3"
  if (process.env.EXT_FACILITY_IDS) h["FacilityIds"] = process.env.EXT_FACILITY_IDS; // "ALL" or "10,20"
  if (process.env.EXT_WAREHOUSE_ID) h["3PL-Warehouse-Id"] = process.env.EXT_WAREHOUSE_ID;
  if (process.env.EXT_CUSTOMER_ID)  h["3PL-Customer-Id"]  = process.env.EXT_CUSTOMER_ID;
  return h;
}

export async function fetchAndUpsertOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  const pool = await getPool();
  const base = apiBase();
  let page = 1, imported = 0;

  while (true) {
    // try modern and legacy paths
    const headers = await authHeaders();
    let dataList = [];
    try {
      let r = await axios.get(`${base}/api/v1/orders`, {
        headers, params: { page, pageSize, ...(modifiedSince && { modifiedDateStart: modifiedSince }), ...(status && { status }) }, timeout: 20000
      });
      const d = r.data;
      dataList = Array.isArray(d?.data) ? d.data : (Array.isArray(d) ? d : []);
    } catch (e1) {
      if (e1.response?.status === 404) {
        const r = await axios.get(`${base}/orders`, {
          headers, params: { page, pageSize, ...(modifiedSince && { modifiedDateStart: modifiedSince }), ...(status && { status }) }, timeout: 20000
        });
        const d = r.data;
        dataList = Array.isArray(d?.data) ? d.data : (Array.isArray(d) ? d : []);
      } else {
        throw e1;
      }
    }
    if (!dataList.length) break;

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const req = new sql.Request(tx);
      for (const o of dataList) {
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
              WHEN MATCHED THEN UPDATE SET ItemID=@ItemID, Qualifier=@Qualifier, OrderedQTY=@OrderedQty
              WHEN NOT MATCHED THEN INSERT (OrderItemID, ItemID, Qualifier, OrderedQTY)
              VALUES (@OrderItemID, @ItemID, @Qualifier, @OrderedQty);
            `);
        }
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }

    imported += dataList.length;
    if (dataList.length < pageSize) break;
    page++;
  }
  return { imported };
}
