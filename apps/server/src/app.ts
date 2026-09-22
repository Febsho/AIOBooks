import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController } from "fastify";
import { existsSync } from "node:fs";
import { z } from "zod";
import { OpenLibraryMetadataProvider } from "@aiobooks/metadata";
import { registerAuth } from "./auth.js";
import { registerAcquisitionRoutes } from "./acquisition.js";
import type { AcquisitionQueue } from "./acquisition.js";
import type { AppConfig } from "./config.js";
import { CredentialCipher } from "./credentials.js";
import type { Database } from "./database.js";
import { persistMetadataWorks } from "./metadata-repository.js";
import { registerResourceRoutes } from "./resources.js";
import { registerPageTurnerRoutes } from "./pageturner.js";

export async function buildApp(config: AppConfig, dependencies: { sql: Database; queue?: AcquisitionQueue }) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie", "headers.x-api-key", "*.apiKey", "*.token", "*.secret"] },
    requestIdHeader: "x-request-id",
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  const metadata = new OpenLibraryMetadataProvider({ userAgent: config.OPENLIBRARY_USER_AGENT, baseUrl: config.OPENLIBRARY_BASE_URL });
  app.get("/api/health", async () => ({ status: "ok", service: "aiobooks-server" }));
  app.get("/api/ready", async (_request, reply) => {
    try { await dependencies.sql`SELECT 1`; return { status: "ready" }; }
    catch { return reply.code(503).send({ status: "not-ready" }); }
  });

  const guards = await registerAuth(app, dependencies.sql, config);
  const credentialCipher = config.CREDENTIAL_ENCRYPTION_KEY ? CredentialCipher.fromBase64(config.CREDENTIAL_ENCRYPTION_KEY) : undefined;
  registerResourceRoutes(app, dependencies.sql, guards, credentialCipher);
  registerAcquisitionRoutes(app, dependencies.sql, guards, credentialCipher, dependencies.queue);
  registerPageTurnerRoutes({ app, sql: dependencies.sql, config, guards, metadata, ...(credentialCipher ? { cipher: credentialCipher } : {}), ...(dependencies.queue ? { queue: dependencies.queue } : {}) });

  const searchQuery = z.object({ q: z.string().trim().min(2).max(200), language: z.string().trim().min(2).max(8).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).default(0) });
  app.get("/api/search", { preHandler: guards.requireAuth }, async (request, reply) => {
    const parsed = searchQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_QUERY", details: parsed.error.flatten() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const result = await metadata.search({
        query: parsed.data.q,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        ...(parsed.data.language ? { language: parsed.data.language } : {}),
      }, controller.signal);
      return { ...result, items: await persistMetadataWorks(dependencies.sql, result.items) };
    } catch (error) {
      request.log.error({ err: error, provider: metadata.id }, "metadata search failed");
      return reply.code(502).send({ error: "METADATA_PROVIDER_FAILED", message: "The metadata provider did not return a usable response." });
    } finally {
      clearTimeout(timer);
    }
  });
  if (existsSync(config.WEB_DIST_PATH)) {
    await app.register(fastifyStatic, { root: config.WEB_DIST_PATH, wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "NOT_FOUND" }) : reply.sendFile("index.html"));
  }
  return app;
}
