// src/app/services/db/mssql.js
import mssql from "mssql";

const cfg = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: process.env.SQL_SERVER,     // e.g. "72.167.50.108"
  database: process.env.SQL_DATABASE, // e.g. "master"
  port: 1433,
  options: { encrypt: true, trustServerCertificate: true },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

let _pool;
export async function getPool() {
  if (_pool && _pool.connected) return _pool;
  _pool = await mssql.connect(cfg);
  return _pool;
}

export const sql = mssql;
