// ---- Token cache (url + mode) ----
let tokenCache = { access_token: null, exp: 0, winner: null };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.exp - 60_000) {
    return tokenCache.access_token;
  }

  const base = (process.env.EXT_BASE_URL || "").replace(/\/+$/, "");
  const clientId = process.env.EXT_CLIENT_ID;
  const clientSecret = process.env.EXT_CLIENT_SECRET;
  const userLogin = process.env.EXT_USER_LOGIN;
  const tplguid   = process.env.EXT_TPL_GUID;
  const userLoginId = process.env.EXT_USER_LOGIN_ID;

  if (!clientId || !clientSecret) throw new Error("Missing EXT_CLIENT_ID / EXT_CLIENT_SECRET");
  if (!userLogin || !tplguid) throw new Error("Missing EXT_USER_LOGIN / EXT_TPL_GUID");

  // Candidate token endpoints commonly seen in sandbox/box
  const urls = [
    `${base}/api/v1/oauth/token`,
    `${base}/oauth/token`,
    `${base}/api/oauth/token`,
  ];

  // Two auth styles:
  //  A) Basic header + minimal body
  //  B) No Basic; put client_id/secret in the body
  const authModes = [
    { name: "basic+body", makeHeaders: () => ({
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
      }),
      makeBody: (tplKeyName, uliKeyName) => {
        const p = new URLSearchParams({ grant_type: "client_credentials", user_login: userLogin });
        p.append(tplKeyName, tplguid);
        if (userLoginId) p.append(uliKeyName, userLoginId);
        return p;
      }
    },
    { name: "body-only", makeHeaders: () => ({
        "Content-Type": "application/x-www-form-urlencoded"
      }),
      makeBody: (tplKeyName, uliKeyName) => {
        const p = new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
          user_login: userLogin
        });
        p.append(tplKeyName, tplguid);
        if (userLoginId) p.append(uliKeyName, userLoginId);
        return p;
      }
    }
  ];

  // Some tenants use tplguid / tpl ; user_login_id / userLoginId
  const tplParamNames = ["tplguid", "tpl"];
  const uliParamNames = ["user_login_id", "userLoginId"];

  const errors = [];
  for (const url of urls) {
    for (const mode of authModes) {
      for (const tplKey of tplParamNames) {
        for (const uliKey of uliParamNames) {
          try {
            const form = mode.makeBody(tplKey, uliKey);
            const resp = await axios.post(url, form, { headers: mode.makeHeaders(), timeout: 20000 });
            const { access_token, expires_in = 3600 } = resp.data || {};
            if (!access_token) throw new Error(`No access_token in response from ${url} (${mode.name}, ${tplKey}, ${uliKey})`);
            tokenCache = {
              access_token,
              exp: Date.now() + expires_in * 1000,
              winner: { url, mode: mode.name, tplKey, uliKey }
            };
            if (process.env.LOG_TOKEN_DEBUG === "true") {
              console.log("[OAuth winner]", tokenCache.winner);
            }
            return access_token;
          } catch (e) {
            errors.push({
              url, mode: mode.name, tplKey, uliKey,
              status: e.response?.status || null,
              data: e.response?.data || String(e.message)
            });
          }
        }
      }
    }
  }

  // If we got here, none worked — throw a concise error with first few failures
  throw new Error("OAuth token failed. Tried combos:\n" + JSON.stringify(errors.slice(0, 4), null, 2));
}
