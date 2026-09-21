import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hash } from "@node-rs/argon2";
import { z } from "zod";
import type { CredentialCipher } from "./credentials.js";
import type { Database } from "./database.js";
import { validateRemoteUrl } from "./network-security.js";
import path from "node:path";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const profileConfigSchema = z.object({
  languages: z.array(z.string().trim().min(2).max(8)).min(1).max(12),
  formatOrder: z.array(z.enum(["M4B", "M4A", "MP3", "FLAC", "EPUB", "AZW3", "MOBI", "PDF"])).min(1),
  protocolOrder: z.array(z.enum(["USENET", "TORRENT"])).min(1),
  minimumConfidence: z.number().int().min(0).max(100).default(75),
  preferredNarrators: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  minimumSizeBytes: z.number().int().nonnegative().optional(),
  maximumSizeBytes: z.number().int().positive().optional(),
  maximumAgeDays: z.number().int().positive().optional(),
  requireCached: z.boolean().optional(),
});

const createProfileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["PRIVATE", "SHARED"]).default("PRIVATE"),
  mediaType: z.enum(["AUDIOBOOK", "EBOOK"]),
  config: profileConfigSchema,
});

const createConnectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["PRIVATE", "SHARED"]).default("PRIVATE"),
  kind: z.enum(["PROWLARR", "NEWZNAB", "TORZNAB", "NZBHYDRA", "TORBOX", "SABNZBD", "NZBGET", "QBITTORRENT", "AUDIOBOOKSHELF", "FILESYSTEM", "WEBDAV"]),
  baseUrl: z.string().url().max(2048),
  publicConfig: z.object({
    timeoutMs: z.number().int().min(500).max(120_000).optional(),
    priority: z.number().int().min(0).max(100).optional(),
    categories: z.array(z.string().trim().min(1).max(50)).max(100).optional(),
  }).strict().default({}),
  credentials: z.record(z.string(), z.string().min(1).max(4096)).refine((value) => Object.keys(value).length > 0, "At least one credential is required"),
});

const createUserSchema = z.object({
  email: z.string().email().transform((value) => value.toLocaleLowerCase("en")),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(1024),
  role: z.enum(["ADMIN", "USER"]).default("USER"),
});

const createLibrarySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["PRIVATE", "SHARED"]).default("PRIVATE"),
  kind: z.enum(["AUDIOBOOKSHELF", "FILESYSTEM", "WEBDAV"]),
  connectionId: z.string().uuid().optional(),
  externalLibraryId: z.string().trim().min(1).max(500).optional(),
  config: z.object({
    rootPath: z.string().trim().min(1).max(500).refine((value) => !path.isAbsolute(value) && !value.split(/[\\/]+/).includes(".."), "rootPath must be a safe path relative to the configured library root").optional(),
    organize: z.boolean().optional(),
  }).strict().default({}),
});

function invalid(reply: FastifyReply, details: unknown) {
  return reply.code(400).send({ error: "INVALID_INPUT", details });
}

export function registerResourceRoutes(
  app: FastifyInstance,
  sql: Database,
  guards: { requireAuth: Guard; requireCsrf: Guard },
  credentialCipher?: CredentialCipher,
) {
  const read = { preHandler: guards.requireAuth };
  const write = { preHandler: [guards.requireAuth, guards.requireCsrf] };

  app.get("/api/users", read, async (request, reply) => {
    if (request.authUser!.role !== "ADMIN") return reply.code(403).send({ error: "ADMIN_REQUIRED" });
    const rows = await sql<{ id: string; email: string; display_name: string; role: "ADMIN" | "USER"; disabled_at: Date | null; created_at: Date }[]>`
      SELECT id, email, display_name, role, disabled_at, created_at FROM users ORDER BY created_at
    `;
    return { items: rows.map((row) => ({ id: row.id, email: row.email, displayName: row.display_name, role: row.role, disabled: row.disabled_at !== null, createdAt: row.created_at })) };
  });

  app.post("/api/users", write, async (request, reply) => {
    if (request.authUser!.role !== "ADMIN") return reply.code(403).send({ error: "ADMIN_REQUIRED" });
    const input = createUserSchema.safeParse(request.body);
    if (!input.success) return invalid(reply, input.error.flatten());
    const passwordHash = await hash(input.data.password, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
    try {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (email, display_name, password_hash, role)
        VALUES (${input.data.email}, ${input.data.displayName}, ${passwordHash}, ${input.data.role}) RETURNING id
      `;
      return reply.code(201).send({ id: row!.id });
    } catch (error) {
      request.log.warn({ err: error, email: input.data.email }, "user creation failed");
      return reply.code(409).send({ error: "USER_ALREADY_EXISTS" });
    }
  });

  app.get("/api/profiles", read, async (request) => {
    const user = request.authUser!;
    const rows = await sql<{
      id: string; owner_user_id: string; scope: "PRIVATE" | "SHARED"; name: string; media_type: "AUDIOBOOK" | "EBOOK"; config: unknown; created_at: Date; updated_at: Date;
    }[]>`
      SELECT DISTINCT p.id, p.owner_user_id, p.scope, p.name, p.media_type, p.config, p.created_at, p.updated_at
      FROM profiles p
      LEFT JOIN profile_permissions pp ON pp.profile_id = p.id AND pp.user_id = ${user.id}
      WHERE ${user.role === "ADMIN"} OR p.owner_user_id = ${user.id} OR (p.scope = 'SHARED' AND pp.can_use = true)
      ORDER BY p.name
    `;
    return { items: rows.map((row) => ({ id: row.id, ownerUserId: row.owner_user_id, scope: row.scope, name: row.name, mediaType: row.media_type, config: row.config, createdAt: row.created_at, updatedAt: row.updated_at })) };
  });

  app.post("/api/profiles", write, async (request, reply) => {
    const input = createProfileSchema.safeParse(request.body);
    if (!input.success) return invalid(reply, input.error.flatten());
    const user = request.authUser!;
    if (input.data.scope === "SHARED" && user.role !== "ADMIN") return reply.code(403).send({ error: "ADMIN_REQUIRED_FOR_SHARED_RESOURCE" });
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO profiles (owner_user_id, scope, name, media_type, config)
      VALUES (${user.id}, ${input.data.scope}, ${input.data.name}, ${input.data.mediaType}, ${sql.json(input.data.config)})
      RETURNING id
    `;
    return reply.code(201).send({ id: row!.id });
  });

  app.get("/api/connections", read, async (request) => {
    const user = request.authUser!;
    const rows = await sql<{
      id: string; owner_user_id: string; scope: "PRIVATE" | "SHARED"; kind: string; name: string; base_url: string; public_config: unknown; enabled: boolean; has_credentials: boolean; created_at: Date; updated_at: Date;
    }[]>`
      SELECT DISTINCT c.id, c.owner_user_id, c.scope, c.kind, c.name, c.base_url, c.public_config, c.enabled,
        (cc.connection_id IS NOT NULL) AS has_credentials, c.created_at, c.updated_at
      FROM connections c
      LEFT JOIN connection_permissions cp ON cp.connection_id = c.id AND cp.user_id = ${user.id}
      LEFT JOIN connection_credentials cc ON cc.connection_id = c.id
      WHERE ${user.role === "ADMIN"} OR c.owner_user_id = ${user.id} OR (c.scope = 'SHARED' AND cp.can_use = true)
      ORDER BY c.name
    `;
    return { items: rows.map((row) => ({ id: row.id, ownerUserId: row.owner_user_id, scope: row.scope, kind: row.kind, name: row.name, baseUrl: row.base_url, publicConfig: row.public_config, enabled: row.enabled, hasCredentials: row.has_credentials, createdAt: row.created_at, updatedAt: row.updated_at })) };
  });

  app.post("/api/connections", write, async (request, reply) => {
    if (!credentialCipher) return reply.code(503).send({ error: "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED" });
    const input = createConnectionSchema.safeParse(request.body);
    if (!input.success) return invalid(reply, input.error.flatten());
    const user = request.authUser!;
    if (input.data.scope === "SHARED" && user.role !== "ADMIN") return reply.code(403).send({ error: "ADMIN_REQUIRED_FOR_SHARED_RESOURCE" });
    let baseUrl: URL;
    try { baseUrl = await validateRemoteUrl(input.data.baseUrl, user.role === "ADMIN"); }
    catch (error) { return invalid(reply, { baseUrl: error instanceof Error ? error.message : "Unsafe URL" }); }
    const encrypted = credentialCipher.encrypt(input.data.credentials);
    const connectionId = await sql.begin(async (transaction) => {
      const [connection] = await transaction<{ id: string }[]>`
        INSERT INTO connections (owner_user_id, scope, kind, name, base_url, public_config)
        VALUES (${user.id}, ${input.data.scope}, ${input.data.kind}, ${input.data.name}, ${baseUrl.toString()}, ${transaction.json(input.data.publicConfig)})
        RETURNING id
      `;
      await transaction`
        INSERT INTO connection_credentials (connection_id, key_version, encrypted_data, nonce, auth_tag)
        VALUES (${connection!.id}, ${encrypted.keyVersion}, ${encrypted.encryptedData}, ${encrypted.nonce}, ${encrypted.authTag})
      `;
      return connection!.id;
    });
    return reply.code(201).send({ id: connectionId });
  });

  app.get("/api/libraries", read, async (request) => {
    const user = request.authUser!;
    const rows = await sql<{
      id: string; owner_user_id: string; scope: "PRIVATE" | "SHARED"; connection_id: string | null; kind: string; name: string; external_library_id: string | null; config: unknown; created_at: Date; updated_at: Date;
    }[]>`
      SELECT DISTINCT l.id, l.owner_user_id, l.scope, l.connection_id, l.kind, l.name, l.external_library_id, l.config, l.created_at, l.updated_at
      FROM libraries l
      LEFT JOIN library_permissions lp ON lp.library_id = l.id AND lp.user_id = ${user.id}
      WHERE ${user.role === "ADMIN"} OR l.owner_user_id = ${user.id} OR (l.scope = 'SHARED' AND lp.can_use = true)
      ORDER BY l.name
    `;
    return { items: rows.map((row) => ({ id: row.id, ownerUserId: row.owner_user_id, scope: row.scope, connectionId: row.connection_id, kind: row.kind, name: row.name, externalLibraryId: row.external_library_id, config: row.config, createdAt: row.created_at, updatedAt: row.updated_at })) };
  });

  app.post("/api/libraries", write, async (request, reply) => {
    const input = createLibrarySchema.safeParse(request.body);
    if (!input.success) return invalid(reply, input.error.flatten());
    const user = request.authUser!;
    if (input.data.scope === "SHARED" && user.role !== "ADMIN") return reply.code(403).send({ error: "ADMIN_REQUIRED_FOR_SHARED_RESOURCE" });
    if (input.data.kind !== "FILESYSTEM" && !input.data.connectionId) return reply.code(400).send({ error: "LIBRARY_CONNECTION_REQUIRED" });
    if (input.data.kind === "FILESYSTEM" && input.data.connectionId) return reply.code(400).send({ error: "FILESYSTEM_LIBRARY_MUST_NOT_HAVE_CONNECTION" });
    if (input.data.connectionId) {
      const accessible = await sql<{ allowed: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM connections c
          LEFT JOIN connection_permissions cp ON cp.connection_id = c.id AND cp.user_id = ${user.id}
          WHERE c.id = ${input.data.connectionId}
            AND c.kind = ${input.data.kind}
            AND (${user.role === "ADMIN"} OR c.owner_user_id = ${user.id} OR (c.scope = 'SHARED' AND cp.can_use = true))
        ) AS allowed
      `;
      if (!accessible[0]?.allowed) return reply.code(403).send({ error: "CONNECTION_NOT_ACCESSIBLE" });
    }
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO libraries (owner_user_id, scope, connection_id, kind, name, external_library_id, config)
      VALUES (${user.id}, ${input.data.scope}, ${input.data.connectionId ?? null}, ${input.data.kind}, ${input.data.name}, ${input.data.externalLibraryId ?? null}, ${sql.json(input.data.config)})
      RETURNING id
    `;
    return reply.code(201).send({ id: row!.id });
  });
}
