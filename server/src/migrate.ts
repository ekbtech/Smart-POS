import "./env.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "./db.js";

async function migrate(): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      "CREATE TABLE IF NOT EXISTS migration_versions (version VARCHAR(100) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB",
    );
    const directory = join(process.cwd(), "migrations");
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const [rows] = await connection.execute<Array<{ version: string } & import("mysql2").RowDataPacket>>(
        "SELECT version FROM migration_versions WHERE version = ?",
        [file],
      );
      if (rows.length) continue;
      const statements = (await readFile(join(directory, file), "utf8"))
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) await connection.query(statement);
      await connection.execute("INSERT INTO migration_versions (version) VALUES (?)", [file]);
      console.info(`Applied migration ${file}`);
    }
  } finally {
    connection.release();
    await pool.end();
  }
}

void migrate().catch((error: unknown) => {
  console.error("Database migration failed.", error);
  process.exitCode = 1;
});
