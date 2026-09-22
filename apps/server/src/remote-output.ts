import type { NormalizedRelease } from "@aiobooks/core";
import type { CredentialCipher, EncryptedCredential } from "./credentials.js";
import type { Database } from "./database.js";

export type PageTurnerSourceType = "torrent" | "directDownload" | "stream";

interface ReleaseRow {
  id: string;
  normalized_data: Omit<NormalizedRelease, "downloadRef" | "providerId" | "providerReleaseId">;
  key_version: number;
  encrypted_data: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
}

export interface PageTurnerResult {
  id: string;
  title: string;
  url?: string;
  magnetUrl?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  quality?: string;
  format?: string;
  source: string;
  date?: string;
  state: string;
}

function encrypted(row: { key_version: number; encrypted_data: Buffer; nonce: Buffer; auth_tag: Buffer }): EncryptedCredential {
  return { keyVersion: row.key_version, encryptedData: row.encrypted_data, nonce: row.nonce, authTag: row.auth_tag };
}

export function outputIsExpired(expiresAt: Date | null, now = new Date()): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

export function isRemoteReleaseCompatible(release: Pick<NormalizedRelease, "downloadProtocol" | "downloadRef">, sourceType: PageTurnerSourceType, hasRemoteDownloader: boolean): boolean {
  if (sourceType === "torrent") return release.downloadProtocol === "TORRENT" && release.downloadRef.startsWith("magnet:?");
  if (sourceType === "directDownload") return release.downloadProtocol === "USENET" && hasRemoteDownloader;
  return false;
}

export async function prepareRemoteOutputsForRequest(sql: Database, cipher: CredentialCipher, remoteRequestId: string): Promise<string[]> {
  const requests = await sql<{ id: string; owner_user_id: string; acquisition_job_id: string; output_type: PageTurnerSourceType }[]>`
    SELECT id, owner_user_id, acquisition_job_id, output_type FROM remote_requests WHERE id = ${remoteRequestId} AND state IN ('MATCHED', 'READY', 'QUEUED', 'RESOLVING')
  `;
  const request = requests[0];
  if (!request) return [];
  const releases = await sql<ReleaseRow[]>`
    SELECT rel.id, rel.normalized_data, sec.key_version, sec.encrypted_data, sec.nonce, sec.auth_tag
    FROM releases rel JOIN release_searches search ON search.id = rel.release_search_id
    JOIN release_secrets sec ON sec.release_id = rel.id
    WHERE search.acquisition_job_id = ${request.acquisition_job_id}
    ORDER BY search.created_at DESC, rel.rank_score DESC NULLS LAST, rel.created_at LIMIT 50
  `;
  const tasks: string[] = [];
  for (const release of releases) {
    const secret = cipher.decrypt<{ downloadRef: string }>(encrypted(release));
    if (isRemoteReleaseCompatible({ downloadProtocol: release.normalized_data.downloadProtocol, downloadRef: secret.downloadRef }, request.output_type, false)) {
      const protectedReference = cipher.encrypt({ value: secret.downloadRef });
      await sql`
        INSERT INTO remote_outputs (remote_request_id, owner_user_id, release_id, kind, state, key_version, encrypted_reference, nonce, auth_tag)
        VALUES (${request.id}, ${request.owner_user_id}, ${release.id}, 'MAGNET', 'READY', ${protectedReference.keyVersion}, ${protectedReference.encryptedData}, ${protectedReference.nonce}, ${protectedReference.authTag})
        ON CONFLICT (remote_request_id, release_id, kind) DO UPDATE SET state = 'READY', last_error = NULL, updated_at = now()
      `;
      continue;
    }
    if (request.output_type === "directDownload" && release.normalized_data.downloadProtocol === "USENET") {
      const reusable = await sql<{
        connection_id: string; external_job_id: string; output_manifest: Array<{ path: string; sizeBytes?: number }>;
      }[]>`
        SELECT existing.connection_id, existing.external_job_id, existing.output_manifest
        FROM remote_outputs existing JOIN remote_requests previous ON previous.id = existing.remote_request_id
        WHERE previous.acquisition_job_id = ${request.acquisition_job_id} AND existing.owner_user_id = ${request.owner_user_id}
          AND existing.release_id = ${release.id} AND existing.kind = 'DIRECT_DOWNLOAD' AND existing.state = 'READY'
          AND existing.connection_id IS NOT NULL AND existing.external_job_id IS NOT NULL AND existing.output_manifest IS NOT NULL
        ORDER BY existing.updated_at DESC LIMIT 1
      `;
      if (reusable[0]) {
        await sql`
          INSERT INTO remote_outputs (remote_request_id, owner_user_id, release_id, connection_id, kind, state, external_job_id, output_manifest)
          VALUES (${request.id}, ${request.owner_user_id}, ${release.id}, ${reusable[0].connection_id}, 'DIRECT_DOWNLOAD', 'READY', ${reusable[0].external_job_id}, ${sql.json(reusable[0].output_manifest)})
          ON CONFLICT (remote_request_id, release_id, kind) DO UPDATE SET state = 'READY', external_job_id = EXCLUDED.external_job_id, output_manifest = EXCLUDED.output_manifest, last_error = NULL, updated_at = now()
        `;
        continue;
      }
      const connections = await sql<{ id: string }[]>`
        SELECT c.id FROM connections c LEFT JOIN connection_permissions permission ON permission.connection_id = c.id AND permission.user_id = ${request.owner_user_id}
        WHERE c.kind = 'TORBOX' AND c.enabled = true AND (c.owner_user_id = ${request.owner_user_id} OR (c.scope = 'SHARED' AND permission.can_use = true))
        ORDER BY COALESCE((c.public_config->>'priority')::integer, 50) DESC, c.created_at LIMIT 1
      `;
      if (!connections[0]) continue;
      const rows = await sql<{ id: string }[]>`
        INSERT INTO remote_outputs (remote_request_id, owner_user_id, release_id, connection_id, kind, state, next_poll_at)
        VALUES (${request.id}, ${request.owner_user_id}, ${release.id}, ${connections[0].id}, 'DIRECT_DOWNLOAD', 'QUEUED', now())
        ON CONFLICT (remote_request_id, release_id, kind) DO UPDATE SET updated_at = now()
        RETURNING id
      `;
      if (rows[0]) tasks.push(rows[0].id);
    }
  }
  const states = await sql<{ ready: number; pending: number }[]>`
    SELECT count(*) FILTER (WHERE state = 'READY')::int AS ready, count(*) FILTER (WHERE state IN ('QUEUED', 'RESOLVING', 'EXPIRED'))::int AS pending
    FROM remote_outputs WHERE remote_request_id = ${request.id}
  `;
  const state = (states[0]?.ready ?? 0) > 0 ? "READY" : (states[0]?.pending ?? 0) > 0 ? "QUEUED" : "MATCHED";
  await sql`UPDATE remote_requests SET state = ${state}, updated_at = now() WHERE id = ${request.id}`;
  return tasks;
}

export async function prepareRemoteOutputsForJob(sql: Database, cipher: CredentialCipher, acquisitionJobId: string): Promise<string[]> {
  const requests = await sql<{ id: string }[]>`SELECT id FROM remote_requests WHERE acquisition_job_id = ${acquisitionJobId} AND state = 'MATCHED'`;
  const nested = await Promise.all(requests.map((request) => prepareRemoteOutputsForRequest(sql, cipher, request.id)));
  return nested.flat();
}

export async function pageTurnerResults(input: {
  sql: Database;
  cipher: CredentialCipher;
  remoteRequestId: string;
  ownerUserId: string;
  sourceType: PageTurnerSourceType;
  publicBaseUrl: string;
  token: string;
}): Promise<PageTurnerResult[]> {
  const rows = await input.sql<{
    id: string; kind: "MAGNET" | "DIRECT_DOWNLOAD" | "STREAM" | "REFERENCE"; state: string; expires_at: Date | null;
    key_version: number | null; encrypted_reference: Buffer | null; nonce: Buffer | null; auth_tag: Buffer | null;
    normalized_data: Omit<NormalizedRelease, "downloadRef" | "providerId" | "providerReleaseId">;
  }[]>`
    SELECT output.id, output.kind, output.state, output.expires_at, output.key_version, output.encrypted_reference, output.nonce, output.auth_tag, release.normalized_data
    FROM remote_outputs output JOIN releases release ON release.id = output.release_id
    WHERE output.remote_request_id = ${input.remoteRequestId} AND output.owner_user_id = ${input.ownerUserId}
    ORDER BY release.rank_score DESC NULLS LAST, output.created_at
  `;
  return rows.flatMap((row): PageTurnerResult[] => {
    if (row.kind === "MAGNET" && input.sourceType === "torrent" && row.encrypted_reference && row.key_version !== null && row.nonce && row.auth_tag) {
      const reference = input.cipher.decrypt<{ value: string }>({ keyVersion: row.key_version, encryptedData: row.encrypted_reference, nonce: row.nonce, authTag: row.auth_tag });
      return [{ id: row.id, title: row.normalized_data.rawTitle, magnetUrl: reference.value, ...(row.normalized_data.sizeBytes === undefined ? {} : { size: row.normalized_data.sizeBytes }), ...(row.normalized_data.seeders === undefined ? {} : { seeders: row.normalized_data.seeders }), ...(row.normalized_data.leechers === undefined ? {} : { leechers: row.normalized_data.leechers }), format: row.normalized_data.format, source: "AIOBooks", ...(row.normalized_data.publishedAt ? { date: row.normalized_data.publishedAt } : {}), state: row.state }];
    }
    if (row.kind === "DIRECT_DOWNLOAD" && input.sourceType === "directDownload" && row.state === "READY" && !outputIsExpired(row.expires_at)) {
      const base = input.publicBaseUrl.replace(/\/+$/, "");
      return [{ id: row.id, title: row.normalized_data.rawTitle, url: `${base}/api/integrations/pageturner/output/${encodeURIComponent(input.token)}/${row.id}`, ...(row.normalized_data.sizeBytes === undefined ? {} : { size: row.normalized_data.sizeBytes }), format: row.normalized_data.format, source: "AIOBooks", ...(row.normalized_data.publishedAt ? { date: row.normalized_data.publishedAt } : {}), state: row.state }];
    }
    return [];
  });
}
