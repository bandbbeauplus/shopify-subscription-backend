const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase (and most managed Postgres hosts) require SSL on every connection,
  // including local development, since you're always connecting to their remote DB.
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle database client", err);
});

module.exports = pool;
