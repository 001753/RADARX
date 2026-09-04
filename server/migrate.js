const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. PostgreSQL is the system source of truth.");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    console.log("Database schema is ready.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});