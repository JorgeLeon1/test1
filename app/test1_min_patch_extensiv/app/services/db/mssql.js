import sql from "mssql";

let pool;
export async function getPool() {
  if (pool) return pool;
  pool = await sql.connect({
    server: process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: { trustServerCertificate: true },
    pool: { max: 10 }
  });
  return pool;
}

export { sql };
