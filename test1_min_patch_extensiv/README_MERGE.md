
# Minimal Patch for Extensiv Import → Allocate → Push (Keep your UI)

This zip only contains the **new** files you need to add to your existing `test1` repo.
Nothing here will overwrite your UI or other features.

## Files in this patch (drop-in)

- `app/routes/extensiv.js`
- `app/services/db/mssql.js`
- `app/services/extensivClient.js`
- `app/services/allocService.js`
- `app/services/pushAllocations.js`
- `public/allocations.html`
- `.env.sample.append` (copy these keys into your `.env.sample` and `.env`)
- `package.json.fragment` (merge these deps into your `package.json`)

## How to apply

1. Copy all folders/files from this zip into your repo root, **creating folders if missing**.
2. Mount the route in your server entry (likely `index.js` at repo root):
   ```js
   import extensiv from './app/routes/extensiv.js';
   app.use('/extensiv', extensiv);
   ```
3. Merge dependencies into your `package.json` or run:
   ```bash
   npm i mssql axios
   ```
4. Add these env vars to `.env.sample` and `.env`:
   ```env
   # SQL Server
   SQL_SERVER=localhost
   SQL_DATABASE=Portal
   SQL_USER=sa
   SQL_PASSWORD=yourStrong(!)Password

   # Extensiv (3PL WMS)
   EXT_BASE_URL=https://public.3plcentral.com
   EXT_API_KEY=your-key
   EXT_API_SECRET=your-secret
   EXT_PUSH_MODE=custom   # or "standard"
   ```
5. Ensure your SQL tables exist (`OrderDetails`, `Inventory`, `SuggAlloc`) with columns used in the queries.
6. Start your app and visit `/allocations.html` to click **Import → Allocate → Push**.

If you need me to map fields to your exact SQL schema, send the table DDL and I'll regenerate the files.
