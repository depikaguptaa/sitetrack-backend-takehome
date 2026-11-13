import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "../src/db.js";

const migrationsDir = join(process.cwd(), "db", "migrations");

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const applied = new Set(
      (
        await client.query<{ name: string }>(
          "SELECT name FROM schema_migrations",
        )
      ).rows.map((r) => r.name),
    );
    const files = (await readdir(migrationsDir))
      .filter((f) => /^\d+_[\w-]+\.sql$/.test(f))
      .sort();
    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = await readFile(join(migrationsDir, name), "utf8");
      console.info(`applying migration ${name}`);
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL statement_timeout = '10min'");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [
          name,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.info("database schema is up to date");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  console.error("database migration failed", error);
  process.exitCode = 1;
});
