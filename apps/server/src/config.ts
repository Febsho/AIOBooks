import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  SERVER_HOST: z.string().default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1).default("postgresql://aiobooks:change-me@localhost:5432/aiobooks"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  ACQUISITION_STAGING_PATH: z.string().min(1).default("/data/staging"),
  LIBRARY_ROOT_PATH: z.string().min(1).default("/data/libraries"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  BOOTSTRAP_ADMIN_EMAIL: z.preprocess((value) => value === "" ? undefined : value, z.string().email().optional()),
  BOOTSTRAP_ADMIN_PASSWORD: z.preprocess((value) => value === "" ? undefined : value, z.string().min(12).optional()),
  CREDENTIAL_ENCRYPTION_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  OPENLIBRARY_USER_AGENT: z.string().min(8).default("AIOBooks/dev (admin@example.invalid)"),
}).superRefine((value, context) => {
  const hasEmail = Boolean(value.BOOTSTRAP_ADMIN_EMAIL);
  const hasPassword = Boolean(value.BOOTSTRAP_ADMIN_PASSWORD);
  if (hasEmail !== hasPassword) context.addIssue({ code: "custom", message: "BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together" });
  if (value.CREDENTIAL_ENCRYPTION_KEY) {
    let decoded: Buffer;
    try { decoded = Buffer.from(value.CREDENTIAL_ENCRYPTION_KEY, "base64"); } catch { decoded = Buffer.alloc(0); }
    if (decoded.length !== 32) context.addIssue({ code: "custom", path: ["CREDENTIAL_ENCRYPTION_KEY"], message: "must be a base64-encoded 32-byte key" });
  }
});

export type AppConfig = z.infer<typeof configSchema>;
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(environment);
}
