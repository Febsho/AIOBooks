import { createHash } from "node:crypto";
import { aggregateReleases, ProfileRankingEngine, type AcquisitionProfile, type MatchResult, type NormalizedRelease, type RankedRelease } from "@aiobooks/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CredentialCipher } from "./credentials.js";
import type { Database } from "./database.js";
import { loadBookWork } from "./metadata-repository.js";
import { loadSearchProviders } from "./provider-factory.js";
import { TorBoxDownloadClient } from "@aiobooks/downloaders";
import { validateRemoteUrl } from "./network-security.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const requestSchema = z.object({ profileId: z.string().uuid(), libraryId: z.string().uuid(), automatic: z.boolean().default(true) });
const idParams = z.object({ id: z.string().uuid() });
const releaseParams = z.object({ id: z.string().uuid(), releaseId: z.string().uuid() });

export interface AcquisitionQueue {
  enqueueDownload(downloadJobId: string): Promise<void>;
}

function compatibilityKey(profile: AcquisitionProfile): string {
  const contract = { mediaType: profile.mediaType, languages: profile.languages, formatOrder: profile.formatOrder, protocolOrder: profile.protocolOrder, minimumConfidence: profile.minimumConfidence, minimumSizeBytes: profile.minimumSizeBytes, maximumSizeBytes: profile.maximumSizeBytes, requireCached: profile.requireCached };
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

function sanitizeRelease(release: NormalizedRelease) {
  const { downloadRef: _downloadRef, providerId: _providerId, providerReleaseId: _providerReleaseId, ...safe } = release;
  return safe;
}

function publicRelease(item: RankedRelease) {
  const release = sanitizeRelease(item.release);
  return { release, match: item.match, score: item.score, scoreReasons: item.scoreReasons };
}

async function loadProfile(sql: Database, userId: string, isAdmin: boolean, profileId: string): Promise<AcquisitionProfile | null> {
  const rows = await sql<{ id: string; name: string; media_type: "AUDIOBOOK" | "EBOOK"; config: Omit<AcquisitionProfile, "id" | "name" | "mediaType"> }[]>`
    SELECT p.id, p.name, p.media_type, p.config FROM profiles p
    LEFT JOIN profile_permissions pp ON pp.profile_id = p.id AND pp.user_id = ${userId}
    WHERE p.id = ${profileId} AND (${isAdmin} OR p.owner_user_id = ${userId} OR (p.scope = 'SHARED' AND pp.can_use = true)) LIMIT 1
  `;
  const row = rows[0];
  return row ? { id: row.id, name: row.name, mediaType: row.media_type, ...row.config } : null;
}

async function libraryAccessible(sql: Database, userId: string, isAdmin: boolean, libraryId: string): Promise<boolean> {
  const rows = await sql<{ allowed: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM libraries l LEFT JOIN library_permissions lp ON lp.library_id = l.id AND lp.user_id = ${userId}
      WHERE l.id = ${libraryId} AND (${isAdmin} OR l.owner_user_id = ${userId} OR (l.scope = 'SHARED' AND lp.can_use = true))
    ) AS allowed
  `;
  return rows[0]?.allowed ?? false;
}

async function storedReleases(sql: Database, requestId: string, userId: string, isAdmin: boolean) {
  return sql<{ id: string; normalized_data: Omit<NormalizedRelease, "downloadRef" | "providerId" | "providerReleaseId">; match_data: MatchResult & { scoreReasons?: string[] }; rank_score: number }[]>`
    SELECT r.id, r.normalized_data, r.match_data, r.rank_score
    FROM requests req
    JOIN acquisition_job_requests ajr ON ajr.request_id = req.id
    JOIN release_searches rs ON rs.acquisition_job_id = ajr.acquisition_job_id
    JOIN releases r ON r.release_search_id = rs.id
    WHERE req.id = ${requestId} AND (${isAdmin} OR req.owner_user_id = ${userId})
      AND rs.id = (SELECT id FROM release_searches WHERE acquisition_job_id = ajr.acquisition_job_id ORDER BY created_at DESC LIMIT 1)
    ORDER BY r.rank_score DESC NULLS LAST
  `;
}

export function registerAcquisitionRoutes(
  app: FastifyInstance,
  sql: Database,
  guards: { requireAuth: Guard; requireCsrf: Guard },
  credentialCipher?: CredentialCipher,
  queue?: AcquisitionQueue,
) {
  const read = { preHandler: guards.requireAuth };
  const write = { preHandler: [guards.requireAuth, guards.requireCsrf] };

  app.get("/api/requests", read, async (request) => {
    const user = request.authUser!;
    const rows = await sql`
      SELECT r.id, r.book_id, r.edition_id, r.media_type, r.state, r.automatic, r.created_at, r.updated_at,
        b.title, b.cover_url, p.name AS profile_name, l.name AS library_name
      FROM requests r JOIN books b ON b.id = r.book_id JOIN profiles p ON p.id = r.profile_id JOIN libraries l ON l.id = r.library_id
      WHERE ${user.role === "ADMIN"} OR r.owner_user_id = ${user.id}
      ORDER BY r.created_at DESC
    `;
    return { items: rows };
  });

  app.get("/api/requests/:id/releases", read, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_REQUEST_ID" });
    const user = request.authUser!;
    const releases = await storedReleases(sql, params.data.id, user.id, user.role === "ADMIN");
    return { items: releases.map((row) => ({ id: row.id, release: row.normalized_data, match: row.match_data, score: row.rank_score, scoreReasons: row.match_data.scoreReasons ?? [] })) };
  });

  app.post("/api/requests/:id/releases/:releaseId/select", write, async (request, reply) => {
    if (!credentialCipher) return reply.code(503).send({ error: "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED" });
    if (!queue) return reply.code(503).send({ error: "ACQUISITION_QUEUE_NOT_CONFIGURED" });
    const params = releaseParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const user = request.authUser!;
    const selected = await sql.begin(async (transaction) => {
      const [row] = await transaction<{
        request_id: string; acquisition_job_id: string; acquisition_state: string; release_id: string;
        normalized_data: Omit<NormalizedRelease, "downloadRef" | "providerId" | "providerReleaseId">;
        provider_connection_id: string; provider_release_id: string;
      }[]>`
        SELECT req.id AS request_id, aj.id AS acquisition_job_id, aj.state AS acquisition_state,
          rel.id AS release_id, rel.normalized_data, rel.provider_connection_id, rel.provider_release_id
        FROM requests req
        JOIN acquisition_job_requests ajr ON ajr.request_id = req.id
        JOIN acquisition_jobs aj ON aj.id = ajr.acquisition_job_id
        JOIN release_searches rs ON rs.acquisition_job_id = aj.id
        JOIN releases rel ON rel.release_search_id = rs.id
        WHERE req.id = ${params.data.id} AND rel.id = ${params.data.releaseId}
          AND (${user.role === "ADMIN"} OR req.owner_user_id = ${user.id})
        FOR UPDATE OF aj
      `;
      if (!row) return null;
      if (row.acquisition_state !== "MATCHED") return { conflict: row.acquisition_state } as const;
      const [connection] = await transaction<{ id: string }[]>`
        SELECT c.id FROM connections c
        LEFT JOIN connection_permissions cp ON cp.connection_id = c.id AND cp.user_id = ${user.id}
        WHERE c.kind = 'TORBOX' AND c.enabled = true
          AND (${user.role === "ADMIN"} OR c.owner_user_id = ${user.id} OR (c.scope = 'SHARED' AND cp.can_use = true))
        ORDER BY COALESCE((c.public_config->>'priority')::integer, 50) DESC, c.created_at
        LIMIT 1
      `;
      if (!connection) return { noDownloader: true } as const;
      const [download] = await transaction<{ id: string }[]>`
        INSERT INTO download_jobs (acquisition_job_id, owner_user_id, connection_id, state, next_poll_at)
        VALUES (${row.acquisition_job_id}, ${user.id}, ${connection.id}, 'QUEUED', now())
        ON CONFLICT (acquisition_job_id) DO UPDATE SET updated_at = now()
        RETURNING id
      `;
      await transaction`
        UPDATE acquisition_jobs SET selected_release_id = ${row.release_id}, selected_release = ${transaction.json(JSON.parse(JSON.stringify(row.normalized_data)))}, state = 'QUEUED', updated_at = now()
        WHERE id = ${row.acquisition_job_id}
      `;
      await transaction`
        INSERT INTO request_events (request_id, actor_user_id, from_state, to_state, event_type, public_message, detail)
        SELECT req.id, ${user.id}, req.state, 'QUEUED', 'RELEASE_SELECTED', 'Release queued for download', ${transaction.json({ releaseId: row.release_id })}
        FROM requests req JOIN acquisition_job_requests ajr ON ajr.request_id = req.id
        WHERE ajr.acquisition_job_id = ${row.acquisition_job_id} AND req.state = 'MATCHED'
      `;
      await transaction`
        UPDATE requests SET state = 'QUEUED', updated_at = now()
        WHERE id IN (SELECT request_id FROM acquisition_job_requests WHERE acquisition_job_id = ${row.acquisition_job_id})
          AND state = 'MATCHED'
      `;
      return { downloadJobId: download!.id, requestId: row.request_id } as const;
    });
    if (!selected) return reply.code(404).send({ error: "RELEASE_NOT_FOUND" });
    if ("conflict" in selected) return reply.code(409).send({ error: "REQUEST_NOT_SELECTABLE", state: selected.conflict });
    if ("noDownloader" in selected) return reply.code(409).send({ error: "NO_DOWNLOAD_CLIENT_AVAILABLE" });
    await queue.enqueueDownload(selected.downloadJobId);
    return reply.code(202).send({ requestId: selected.requestId, state: "QUEUED" });
  });

  app.post("/api/books/:id/request", write, async (request, reply) => {
    if (!credentialCipher) return reply.code(503).send({ error: "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED" });
    const params = idParams.safeParse(request.params);
    const input = requestSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const user = request.authUser!;
    const work = await loadBookWork(sql, params.data.id);
    if (!work) return reply.code(404).send({ error: "BOOK_NOT_FOUND" });
    const profile = await loadProfile(sql, user.id, user.role === "ADMIN", input.data.profileId);
    if (!profile) return reply.code(403).send({ error: "PROFILE_NOT_ACCESSIBLE" });
    if (!(await libraryAccessible(sql, user.id, user.role === "ADMIN", input.data.libraryId))) return reply.code(403).send({ error: "LIBRARY_NOT_ACCESSIBLE" });

    const key = compatibilityKey(profile);
    const attached = await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${`${work.id}:${profile.mediaType}:${key}`}))`;
      let [job] = await transaction<{ id: string; state: string }[]>`
        SELECT id, state FROM acquisition_jobs WHERE book_id = ${work.id} AND media_type = ${profile.mediaType} AND compatibility_key = ${key}
          AND edition_id IS NULL AND state NOT IN ('AVAILABLE', 'FAILED') LIMIT 1
      `;
      const shouldSearch = !job || job.state === "WANTED";
      if (!job) {
        [job] = await transaction<{ id: string; state: string }[]>`
          INSERT INTO acquisition_jobs (book_id, edition_id, media_type, compatibility_key, state)
          VALUES (${work.id}, NULL, ${profile.mediaType}, ${key}, 'SEARCHING') RETURNING id, state
        `;
      } else if (job.state === "WANTED") {
        await transaction`UPDATE acquisition_jobs SET state = 'SEARCHING', updated_at = now() WHERE id = ${job.id}`;
      }
      if (!job) throw new Error("Failed to create acquisition job");
      const initialState = shouldSearch || job.state === "SEARCHING" ? "SEARCHING" : job.state;
      const [createdRequest] = await transaction<{ id: string }[]>`
        INSERT INTO requests (owner_user_id, book_id, edition_id, profile_id, library_id, media_type, state, automatic)
        VALUES (${user.id}, ${work.id}, NULL, ${profile.id}, ${input.data.libraryId}, ${profile.mediaType}, ${initialState}, ${input.data.automatic}) RETURNING id
      `;
      await transaction`INSERT INTO acquisition_job_requests (acquisition_job_id, request_id) VALUES (${job!.id}, ${createdRequest!.id})`;
      await transaction`
        INSERT INTO request_events (request_id, actor_user_id, from_state, to_state, event_type, public_message)
        VALUES (${createdRequest!.id}, ${user.id}, NULL, ${initialState}, 'REQUEST_CREATED', ${initialState === "SEARCHING" ? "Searching configured sources" : "Attached to an existing acquisition"})
      `;
      return { requestId: createdRequest!.id, jobId: job!.id, shouldSearch, state: initialState };
    });

    if (!attached.shouldSearch) {
      const releases = await storedReleases(sql, attached.requestId, user.id, user.role === "ADMIN");
      return reply.code(attached.state === "SEARCHING" ? 202 : 201).send({ requestId: attached.requestId, state: attached.state, releases: releases.map((row) => ({ id: row.id, release: row.normalized_data, match: row.match_data, score: row.rank_score, scoreReasons: row.match_data.scoreReasons ?? [] })) });
    }

    const loaded = await loadSearchProviders(sql, user, credentialCipher);
    const timeoutById = new Map(loaded.map((entry) => [entry.provider.id, entry.timeoutMs]));
    const aggregation = await aggregateReleases(loaded.map((entry) => entry.provider), { work, profile }, new ProfileRankingEngine(), (provider) => timeoutById.get(provider.id) ?? 15_000);
    const nextState = aggregation.ranked.length > 0 ? "MATCHED" : "WANTED";
    await sql.begin(async (transaction) => {
      const [search] = await transaction<{ id: string }[]>`
        INSERT INTO release_searches (acquisition_job_id, correlation_id, diagnostics, result_count, expires_at)
        VALUES (${attached.jobId}, ${request.id}, ${transaction.json(JSON.parse(JSON.stringify(aggregation.diagnostics)))}, ${aggregation.ranked.length}, now() + interval '24 hours') RETURNING id
      `;
      for (const ranked of aggregation.ranked) {
        const safeRelease = sanitizeRelease(ranked.release);
        const [stored] = await transaction<{ id: string }[]>`
          INSERT INTO releases (release_search_id, provider_connection_id, provider_release_id, normalized_data, match_data, rank_score)
          VALUES (${search!.id}, ${ranked.release.providerId}, ${ranked.release.providerReleaseId}, ${transaction.json(JSON.parse(JSON.stringify(safeRelease)))}, ${transaction.json(JSON.parse(JSON.stringify({ ...ranked.match, scoreReasons: ranked.scoreReasons })))}, ${ranked.score})
          RETURNING id
        `;
        const encrypted = credentialCipher.encrypt({ downloadRef: ranked.release.downloadRef });
        await transaction`
          INSERT INTO release_secrets (release_id, key_version, encrypted_data, nonce, auth_tag)
          VALUES (${stored!.id}, ${encrypted.keyVersion}, ${encrypted.encryptedData}, ${encrypted.nonce}, ${encrypted.authTag})
        `;
      }
      await transaction`UPDATE acquisition_jobs SET state = ${nextState}, next_search_at = ${nextState === "WANTED" ? new Date(Date.now() + 6 * 3_600_000) : null}, updated_at = now() WHERE id = ${attached.jobId}`;
      await transaction`
        UPDATE requests SET state = ${nextState}, updated_at = now()
        WHERE id IN (SELECT request_id FROM acquisition_job_requests WHERE acquisition_job_id = ${attached.jobId}) AND state = 'SEARCHING'
      `;
      await transaction`
        INSERT INTO request_events (request_id, from_state, to_state, event_type, public_message, detail)
        SELECT request_id, 'SEARCHING', ${nextState}, 'SEARCH_COMPLETED', ${nextState === "MATCHED" ? "Suitable releases found" : "No acceptable release found"}, ${transaction.json(JSON.parse(JSON.stringify({ diagnostics: aggregation.diagnostics })))}
        FROM acquisition_job_requests WHERE acquisition_job_id = ${attached.jobId}
      `;
    });
    const persisted = await storedReleases(sql, attached.requestId, user.id, user.role === "ADMIN");
    return reply.code(201).send({ requestId: attached.requestId, state: nextState, releases: persisted.map((row) => ({ id: row.id, release: row.normalized_data, match: row.match_data, score: row.rank_score, scoreReasons: row.match_data.scoreReasons ?? [] })), diagnostics: aggregation.diagnostics });
  });

  app.post("/api/connections/:id/test", write, async (request, reply) => {
    if (!credentialCipher) return reply.code(503).send({ error: "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED" });
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_CONNECTION_ID" });
    const user = request.authUser!;
    const direct = await sql<{
      id: string; kind: string; base_url: string; owner_role: "ADMIN" | "USER"; key_version: number; encrypted_data: Buffer; nonce: Buffer; auth_tag: Buffer;
    }[]>`
      SELECT c.id, c.kind, c.base_url, owner.role AS owner_role, cc.key_version, cc.encrypted_data, cc.nonce, cc.auth_tag
      FROM connections c JOIN connection_credentials cc ON cc.connection_id = c.id
      JOIN users owner ON owner.id = c.owner_user_id
      LEFT JOIN connection_permissions cp ON cp.connection_id = c.id AND cp.user_id = ${user.id}
      WHERE c.id = ${params.data.id} AND (${user.role === "ADMIN"} OR c.owner_user_id = ${user.id} OR (c.scope = 'SHARED' AND cp.can_use = true))
      LIMIT 1
    `;
    const directConnection = direct[0];
    if (directConnection?.kind === "TORBOX") {
      const credentials = credentialCipher.decrypt<{ apiKey?: string; token?: string }>({ keyVersion: directConnection.key_version, encryptedData: directConnection.encrypted_data, nonce: directConnection.nonce, authTag: directConnection.auth_tag });
      const apiKey = credentials.apiKey ?? credentials.token;
      if (!apiKey) return reply.code(400).send({ ok: false, code: "MISCONFIGURED", message: "TorBox API key is missing" });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const baseUrl = await validateRemoteUrl(directConnection.base_url, directConnection.owner_role === "ADMIN");
        return await new TorBoxDownloadClient({ apiKey, baseUrl: baseUrl.toString() }).test(controller.signal);
      }
      finally { clearTimeout(timer); }
    }
    const loaded = await loadSearchProviders(sql, user, credentialCipher, params.data.id);
    const selected = loaded[0];
    if (!selected) return reply.code(404).send({ error: "CONNECTION_NOT_FOUND" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
    try { return await selected.provider.test(controller.signal); }
    finally { clearTimeout(timer); }
  });
}
