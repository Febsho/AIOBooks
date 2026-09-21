import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "@node-rs/argon2";
import postgres, { type Sql } from "postgres";
import type { AppConfig } from "./config.js";

export type Database = Sql;

export function createDatabase(connectionString: string): Database {
  return postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => undefined,
    transform: { undefined: null },
  });
}

const DEFAULT_MIGRATION_DIRECTORY = fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url));

export async function runMigrations(sql: Database, directory = DEFAULT_MIGRATION_DIRECTORY): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  await sql`SELECT pg_advisory_lock(hashtext('aiobooks:migrations'))`;
  try {
    const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((row) => row.name));
    const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of files) {
      if (applied.has(name)) continue;
      const raw = await readFile(resolve(directory, name), "utf8");
      const migration = raw.replace(/^\s*BEGIN;\s*$/gim, "").replace(/^\s*COMMIT;\s*$/gim, "");
      await sql.begin(async (transaction) => {
        await transaction.unsafe(migration);
        await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`;
      });
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('aiobooks:migrations'))`;
  }
}

export async function bootstrapAdmin(sql: Database, config: AppConfig): Promise<boolean> {
  if (!config.BOOTSTRAP_ADMIN_EMAIL || !config.BOOTSTRAP_ADMIN_PASSWORD) return false;
  const passwordHash = await hash(config.BOOTSTRAP_ADMIN_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
  const email = config.BOOTSTRAP_ADMIN_EMAIL.toLocaleLowerCase("en");
  return sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('aiobooks:bootstrap-admin'))`;
    const count = (await transaction<{ count: number }[]>`SELECT count(*)::int AS count FROM users`)[0]?.count ?? 0;
    if (count !== 0) return false;
    await transaction`
      INSERT INTO users (email, display_name, password_hash, role)
      VALUES (${email}, ${email.split("@")[0] ?? "Admin"}, ${passwordHash}, 'ADMIN')
    `;
    return true;
  });
}
