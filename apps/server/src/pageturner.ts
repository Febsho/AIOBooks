import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { normalizeText, type MetadataProvider } from "@aiobooks/core";
import { TorBoxDownloadClient } from "@aiobooks/downloaders";
import { compatibilityKey, loadProfile, type AcquisitionQueue } from "./acquisition.js";
import { executeAcquisitionSearch } from "./acquisition-search.js";
import type { AppConfig } from "./config.js";
import type { CredentialCipher, EncryptedCredential } from "./credentials.js";
import type { Database } from "./database.js";
import { loadBookWork, persistMetadataWorks } from "./metadata-repository.js";
import { validateRemoteUrl } from "./network-security.js";
import { pageTurnerResults, prepareRemoteOutputsForRequest, type PageTurnerSourceType } from "./remote-output.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const sourceTypeSchema = z.enum(["torrent", "directDownload", "stream"]);
const searchSchema = z.object({ title: z.string().trim().min(1).max(300), author: z.string().trim().max(300).default(""), narrator: z.string().trim().max(300).optional(), asin: z.string().trim().max(30).optional(), isbn: z.string().trim().max(30).optional() });
const tokenParams = z.object({ token: z.string().min(32).max(200), type: sourceTypeSchema });
const outputParams = z.object({ token: z.string().min(32).max(200), id: z.string().uuid() });

interface TokenRow {
  id: string; owner_user_id: string; profile_id: string; key_version: number; encrypted_token: Buffer; nonce: Buffer; auth_tag: Buffer;
}

export function integrationTokenHash(token: string): Buffer { return createHash("sha256").update(token).digest(); }
export function pageTurnerCompatibilityKey(profileKey: string, ownerUserId: string): string { return createHash("sha256").update(`pageturner\0${ownerUserId}\0${profileKey}`).digest("hex"); }

export function buildPageTurnerSource(input: { id: string; token: string; type: PageTurnerSourceType; publicBaseUrl: string }) {
  const base = input.publicBaseUrl.replace(/\/+$/, "");
  const encoded = encodeURIComponent(input.token);
  const typeLabel = input.type === "directDownload" ? "Direct" : input.type === "torrent" ? "Torrent" : "Stream";
  return {
    id: `aiobooks-${input.type.toLocaleLowerCase()}-${input.id.slice(0, 8)}`,
    name: `AIOBooks ${typeLabel}`,
    version: "1.0.0",
    description: "Private, ranked audiobook results from your AIOBooks account",
    type: input.type,
    legal: { type: "user-content", disclaimer: "Results come from sources configured by the AIOBooks user." },
    request: { method: "GET", url: `${base}/api/integrations/pageturner/search/${encoded}/${input.type}?title={TITLE}&author={AUTHOR}&narrator={NARRATOR}&asin={ASIN}&isbn={ISBN}`, timeout: 120_000 },
    response: {
      type: "json", resultsPath: "items",
      mapping: input.type === "torrent"
        ? { title: "title", magnetUrl: "magnetUrl", size: "size", seeders: "seeders", leechers: "leechers", format: "format", source: "source", date: "date" }
        : { title: "title", url: "url", size: "size", format: "format", source: "source", date: "date" },
    },
    matching: { field: "title", threshold: 0.5, algorithm: "fuzzy" },
    rateLimit: { requestsPerMinute: 30, retryAfterMs: 2000 },
  };
}

function encryptedToken(row: TokenRow): EncryptedCredential {
  return { keyVersion: row.key_version, encryptedData: row.encrypted_token, nonce: row.nonce, authTag: row.auth_tag };
}

async function tokenForValue(sql: Database, token: string): Promise<TokenRow | null> {
  const rows = await sql<TokenRow[]>`
    SELECT id, owner_user_id, profile_id, key_version, encrypted_token, nonce, auth_tag FROM integration_tokens
    WHERE kind = 'PAGETURNER' AND token_hash = ${integrationTokenHash(token)} AND revoked_at IS NULL LIMIT 1
  `;
  if (rows[0]) await sql`UPDATE integration_tokens SET last_used_at = now() WHERE id = ${rows[0].id}`;
  return rows[0] ?? null;
}

async function accessibleProfile(sql: Database, ownerUserId: string, requested?: string) {
  const rows = await sql<{ id: string; name: string }[]>`
    SELECT profile.id, profile.name FROM profiles profile
    LEFT JOIN profile_permissions permission ON permission.profile_id = profile.id AND permission.user_id = ${ownerUserId}
    WHERE profile.media_type = 'AUDIOBOOK' AND (profile.owner_user_id = ${ownerUserId} OR (profile.scope = 'SHARED' AND permission.can_use = true))
      AND (${requested ?? null}::uuid IS NULL OR profile.id = ${requested ?? null})
    ORDER BY CASE WHEN profile.owner_user_id = ${ownerUserId} THEN 0 ELSE 1 END, profile.name LIMIT 1
  `;
  return rows[0] ?? null;
}

async function createRemoteRequest(input: { sql: Database; ownerUserId: string; integrationTokenId: string; profileId: string; bookId: string; outputType: PageTurnerSourceType; compatibilityKey: string }) {
  return input.sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${`${input.bookId}:AUDIOBOOK:${input.compatibilityKey}`}))`;
    let [job] = await transaction<{ id: string; state: string }[]>`
      SELECT id, state FROM acquisition_jobs WHERE book_id = ${input.bookId} AND media_type = 'AUDIOBOOK' AND compatibility_key = ${input.compatibilityKey}
        AND edition_id IS NULL AND state NOT IN ('AVAILABLE', 'FAILED') LIMIT 1
    `;
    const shouldSearch = !job || job.state === "WANTED";
    if (!job) {
      [job] = await transaction<{ id: string; state: string }[]>`INSERT INTO acquisition_jobs (book_id, edition_id, media_type, compatibility_key, state) VALUES (${input.bookId}, NULL, 'AUDIOBOOK', ${input.compatibilityKey}, 'SEARCHING') RETURNING id, state`;
    } else if (job.state === "WANTED") {
      await transaction`UPDATE acquisition_jobs SET state = 'SEARCHING', updated_at = now() WHERE id = ${job.id}`;
    }
    if (!job) throw new Error("Failed to create remote acquisition job");
    const initialState = shouldSearch || job.state === "SEARCHING" ? "SEARCHING" : "MATCHED";
    const [remote] = await transaction<{ id: string }[]>`
      INSERT INTO remote_requests (owner_user_id, integration_token_id, acquisition_job_id, profile_id, book_id, output_type, state)
      VALUES (${input.ownerUserId}, ${input.integrationTokenId}, ${job.id}, ${input.profileId}, ${input.bookId}, ${input.outputType}, ${initialState}) RETURNING id
    `;
    await transaction`INSERT INTO remote_request_events (remote_request_id, from_state, to_state, event_type, public_message) VALUES (${remote!.id}, NULL, ${initialState}, 'REMOTE_REQUEST_CREATED', ${initialState === "SEARCHING" ? "Searching configured sources" : "Using an existing ranked acquisition"})`;
    return { id: remote!.id, jobId: job.id, shouldSearch, state: initialState };
  });
}

export function registerPageTurnerRoutes(input: {
  app: FastifyInstance; sql: Database; config: AppConfig; guards: { requireAuth: Guard; requireCsrf: Guard };
  cipher?: CredentialCipher; queue?: AcquisitionQueue; metadata: MetadataProvider;
}) {
  const read = { preHandler: input.guards.requireAuth };
  const write = { preHandler: [input.guards.requireAuth, input.guards.requireCsrf] };

  input.app.get("/api/integrations/pageturner", read, async (request, reply) => {
    if (!input.cipher) return reply.code(503).send({ error: "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED" });
    const rows = await input.sql<(TokenRow & { profile_name: string; revoked_at: Date | null; last_used_at: Date | null })[]>`
      SELECT token.id, token.owner_user_id, token.profile_id, token.key_version, token.encrypted_token, token.nonce, token.auth_tag, token.revoked_at, token.last_used_at, profile.name AS profile_name
      FROM integration_tokens token JOIN profiles profile ON profile.id = token.profile_id
      WHERE token.owner_user_id = ${request.authUser!.id} AND token.kind = 'PAGETURNER' LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.revoked_at) return { enabled: false };
    const token = input.cipher.decrypt<{ token: string }>(encryptedToken(row)).token;
    const base = input.config.PUBLIC_BASE_URL.replace(/\/+$/, "");
    return { enabled: true, profileId: row.profile_id, profileName: row.profile_name, lastUsedAt: row.last_used_at, sourceUrls: { directDownload: `${base}/api/integrations/pageturner/source/${encodeURIComponent(token)}/directDownload.json`, torrent: `${base}/api/integrations/pageturner/source/${encodeURIComponent(token)}/torrent.json`, stream: `${base}/api/integrations/pageturner/source/${encodeURIComponent(token)}/stream.json` } };
  });

  input.app.post("/api/integrations/pageturner/token", write, async (request, reply) => {
    if (!input.cipher) return reply.code(503).send({ error: "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED" });
    const body = z.object({ profileId: z.string().uuid().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const profile = await accessibleProfile(input.sql, request.authUser!.id, body.data.profileId);
    if (!profile) return reply.code(409).send({ error: "AUDIOBOOK_PROFILE_REQUIRED" });
    const token = randomBytes(32).toString("base64url");
    const protectedToken = input.cipher.encrypt({ token });
    const rows = await input.sql<{ id: string }[]>`
      INSERT INTO integration_tokens (owner_user_id, profile_id, kind, token_hash, key_version, encrypted_token, nonce, auth_tag)
      VALUES (${request.authUser!.id}, ${profile.id}, 'PAGETURNER', ${integrationTokenHash(token)}, ${protectedToken.keyVersion}, ${protectedToken.encryptedData}, ${protectedToken.nonce}, ${protectedToken.authTag})
      ON CONFLICT (owner_user_id, kind) DO UPDATE SET profile_id = EXCLUDED.profile_id, token_hash = EXCLUDED.token_hash, key_version = EXCLUDED.key_version,
        encrypted_token = EXCLUDED.encrypted_token, nonce = EXCLUDED.nonce, auth_tag = EXCLUDED.auth_tag, revoked_at = NULL, last_used_at = NULL, updated_at = now()
      RETURNING id
    `;
    const base = input.config.PUBLIC_BASE_URL.replace(/\/+$/, "");
    return reply.code(201).send({ enabled: true, profileId: profile.id, profileName: profile.name, sourceUrls: { directDownload: `${base}/api/integrations/pageturner/source/${encodeURIComponent(token)}/directDownload.json`, torrent: `${base}/api/integrations/pageturner/source/${encodeURIComponent(token)}/torrent.json`, stream: `${base}/api/integrations/pageturner/source/${encodeURIComponent(token)}/stream.json` }, id: rows[0]!.id });
  });

  input.app.delete("/api/integrations/pageturner/token", write, async (request) => {
    await input.sql`UPDATE integration_tokens SET revoked_at = now(), updated_at = now() WHERE owner_user_id = ${request.authUser!.id} AND kind = 'PAGETURNER' AND revoked_at IS NULL`;
    return { enabled: false };
  });

  input.app.get("/api/integrations/pageturner/source/:token/:type.json", async (request, reply) => {
    const parsed = tokenParams.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: "SOURCE_NOT_FOUND" });
    const integration = await tokenForValue(input.sql, parsed.data.token);
    if (!integration) return reply.code(401).send({ error: "INVALID_INTEGRATION_TOKEN" });
    return buildPageTurnerSource({ id: integration.id, token: parsed.data.token, type: parsed.data.type, publicBaseUrl: input.config.PUBLIC_BASE_URL });
  });

  input.app.get("/api/integrations/pageturner/search/:token/:type", async (request, reply) => {
    if (!input.cipher) return reply.code(503).send({ error: "INTEGRATION_UNAVAILABLE" });
    const params = tokenParams.safeParse(request.params); const query = searchSchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "INVALID_SEARCH" });
    const integration = await tokenForValue(input.sql, params.data.token);
    if (!integration) return reply.code(401).send({ error: "INVALID_INTEGRATION_TOKEN" });
    const metadata = await input.metadata.search({ query: [query.data.title, query.data.author].filter(Boolean).join(" "), limit: 10 });
    const exact = metadata.items.find((work) => normalizeText(work.title) === normalizeText(query.data.title) && (!query.data.author || work.authors.some((author) => normalizeText(author.name).includes(normalizeText(query.data.author)))));
    const candidate = exact ?? metadata.items[0];
    if (!candidate) return { items: [], state: "WANTED" };
    const [persisted] = await persistMetadataWorks(input.sql, [candidate]);
    if (!persisted) return { items: [], state: "WANTED" };
    const user = { id: integration.owner_user_id, email: "integration@local.invalid", displayName: "PageTurner", role: "USER" as const };
    const profile = await loadProfile(input.sql, user.id, false, integration.profile_id);
    const work = await loadBookWork(input.sql, persisted.id);
    if (!profile || !work) return reply.code(409).send({ error: "INTEGRATION_PROFILE_UNAVAILABLE" });
    const remote = await createRemoteRequest({ sql: input.sql, ownerUserId: user.id, integrationTokenId: integration.id, profileId: profile.id, bookId: work.id, outputType: params.data.type, compatibilityKey: pageTurnerCompatibilityKey(compatibilityKey(profile), user.id) });
    let state = remote.state;
    if (remote.shouldSearch) state = (await executeAcquisitionSearch({ sql: input.sql, cipher: input.cipher, jobId: remote.jobId, correlationId: `pageturner:${remote.id}`, user, work, profile })).state;
    if (state === "MATCHED") {
      const tasks = await prepareRemoteOutputsForRequest(input.sql, input.cipher, remote.id);
      await Promise.all(tasks.map((id) => input.queue?.enqueueRemoteOutput(id)));
    }
    const items = await pageTurnerResults({ sql: input.sql, cipher: input.cipher, remoteRequestId: remote.id, ownerUserId: user.id, sourceType: params.data.type, publicBaseUrl: input.config.PUBLIC_BASE_URL, token: params.data.token });
    return { items, state: items.some((item) => item.state === "READY") ? "READY" : state };
  });

  input.app.get("/api/integrations/pageturner/output/:token/:id", async (request, reply) => {
    if (!input.cipher) return reply.code(503).send({ error: "INTEGRATION_UNAVAILABLE" });
    const params = outputParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "OUTPUT_NOT_FOUND" });
    const integration = await tokenForValue(input.sql, params.data.token);
    if (!integration) return reply.code(401).send({ error: "INVALID_INTEGRATION_TOKEN" });
    const rows = await input.sql<{
      id: string; state: string; external_job_id: string | null; output_manifest: Array<{ path: string; sizeBytes?: number }> | null;
      connection_id: string | null; base_url: string | null; owner_role: "ADMIN" | "USER" | null; key_version: number | null; encrypted_data: Buffer | null; nonce: Buffer | null; auth_tag: Buffer | null;
    }[]>`
      SELECT output.id, output.state, output.external_job_id, output.output_manifest, output.connection_id, connection.base_url, connection_owner.role AS owner_role,
        credentials.key_version, credentials.encrypted_data, credentials.nonce, credentials.auth_tag
      FROM remote_outputs output JOIN remote_requests remote ON remote.id = output.remote_request_id
      LEFT JOIN connections connection ON connection.id = output.connection_id AND connection.enabled = true
      LEFT JOIN users connection_owner ON connection_owner.id = connection.owner_user_id LEFT JOIN connection_credentials credentials ON credentials.connection_id = connection.id
      WHERE output.id = ${params.data.id} AND output.owner_user_id = ${integration.owner_user_id} AND remote.integration_token_id = ${integration.id} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "OUTPUT_NOT_FOUND" });
    if (row.state !== "READY" || !row.external_job_id || !row.output_manifest || !row.base_url || !row.owner_role || row.key_version === null || !row.encrypted_data || !row.nonce || !row.auth_tag) {
      return reply.code(row.state === "FAILED" ? 410 : 425).send({ error: "REMOTE_OUTPUT_NOT_READY", state: row.state, retryAfterSeconds: 15 });
    }
    try {
      const credentials = input.cipher.decrypt<{ apiKey?: string; token?: string }>({ keyVersion: row.key_version, encryptedData: row.encrypted_data, nonce: row.nonce, authTag: row.auth_tag });
      const apiKey = credentials.apiKey ?? credentials.token;
      if (!apiKey) throw new Error("Remote resolver credentials unavailable");
      const baseUrl = await validateRemoteUrl(row.base_url, row.owner_role === "ADMIN");
      const client = new TorBoxDownloadClient({ apiKey, baseUrl: baseUrl.toString(), validateDownloadUrl: async (value) => { await validateRemoteUrl(value, row.owner_role === "ADMIN"); } });
      const [resolved] = await client.resolveRemote(row.external_job_id, row.output_manifest);
      if (!resolved) throw new Error("No remote file is available");
      return reply.redirect(resolved.value);
    } catch (error) {
      await input.sql`UPDATE remote_outputs SET state = 'EXPIRED', last_error = ${error instanceof Error ? error.message : "Remote URL resolution failed"}, next_poll_at = now(), updated_at = now() WHERE id = ${row.id}`;
      await input.queue?.enqueueRemoteOutput(row.id);
      return reply.code(410).send({ error: "REMOTE_OUTPUT_EXPIRED", message: "The remote link expired and is being regenerated." });
    }
  });
}
