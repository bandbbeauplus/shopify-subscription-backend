require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("./db");

async function migrate() {
  const schemaPath = path.join(__dirname, "..", "schema.sql");
  const schema = await fs.readFile(schemaPath, "utf8");

  await pool.query(schema);
  console.log("Database schema is up to date");
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error("Database migration failed", error);
      await pool.end().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = migrate;
