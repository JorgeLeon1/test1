import axios from "axios";
import qs from "qs";

// Cached token & expiry
let tokenCache = { token: null, expires: 0 };

async function getBearerToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expires) {
    return tokenCache.token;
  }

  const payload = {
    grant_type: "client_credentials",
    client_id: process.env.EXT_CLIENT_ID,
    client_secret: process.env.EXT_CLIENT_SECRET,
    user_login: process.env.EXT_USER_LOGIN,
    tplguid: process.env.EXT_TPL_GUID
  };

  try {
    const { data } = await axios.post(
      `${process.env.EXT_BASE_URL}/api/v1/oauth/token`,
      qs.stringify(payload),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    if (!data?.access_token) {
      throw new Error("No access_token in OAuth response: " + JSON.stringify(data));
    }

    tokenCache.token = data.access_token;
    tokenCache.expires = now + (data.expires_in ? data.expires_in * 1000 : 10 * 60 * 1000);

    return tokenCache.token;
  } catch (err) {
    console.error("OAuth token fetch failed:", err.response?.data || err.message);
    throw err;
  }
}

export async function fetchOrders({ modifiedSince, status, pageSize = 100 } = {}) {
  const token = await getBearerToken();
  let page = 1;
  let allOrders = [];

  while (true) {
    const { data } = await axios.get(
      `${process.env.EXT_BASE_URL}/api/v1/orders`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        },
        params: {
          modifiedDateStart: modifiedSince,
          status,
          page,
          pageSize,
          facilityIDs: process.env.EXT_FACILITY_IDS,
          customerIDs: process.env.EXT_CUSTOMER_IDS
        }
      }
    );

    const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    if (!list.length) break;

    allOrders.push(...list);
    if (list.length < pageSize) break;
    page++;
  }

  return allOrders;
}

export async function fetchAndUpsertOrdersToDB(db) {
  const orders = await fetchOrders({ pageSize: 50 });
  console.log(`Fetched ${orders.length} orders from Extensiv`);

  // Insert into your SQL here if needed
  return orders.length;
}
