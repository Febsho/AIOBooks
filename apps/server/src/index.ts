import { buildApp } from "./app.js";
import { createAcquisitionQueue } from "./acquisition-queue.js";
import { loadConfig } from "./config.js";
import { CredentialCipher } from "./credentials.js";
import { bootstrapAdmin, createDatabase, runMigrations } from "./database.js";

const config = loadConfig();
const sql = createDatabase(config.DATABASE_URL);
await runMigrations(sql);
const bootstrapped = await bootstrapAdmin(sql, config);
const acquisitionQueue = config.CREDENTIAL_ENCRYPTION_KEY
  ? createAcquisitionQueue(
      { redisUrl: config.REDIS_URL, stagingPath: config.ACQUISITION_STAGING_PATH, libraryRootPath: config.LIBRARY_ROOT_PATH },
      sql,
      CredentialCipher.fromBase64(config.CREDENTIAL_ENCRYPTION_KEY),
    )
  : undefined;
const app = await buildApp(config, { sql, ...(acquisitionQueue ? { queue: acquisitionQueue } : {}) });
if (bootstrapped) app.log.info({ email: config.BOOTSTRAP_ADMIN_EMAIL }, "bootstrap administrator created; remove bootstrap password from configuration");
app.addHook("onClose", async () => { await acquisitionQueue?.close(); await sql.end({ timeout: 5 }); });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.SERVER_HOST, port: config.SERVER_PORT });
} catch (error) {
  app.log.fatal(error);
  process.exit(1);
}
