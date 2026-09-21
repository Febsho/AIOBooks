import { randomUUID } from "node:crypto";
import path from "node:path";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { TorBoxDownloadClient } from "@aiobooks/downloaders";
import { AudiobookshelfLibraryProvider, FilesystemLibraryProvider } from "@aiobooks/libraries";
import type { BookEdition, DownloadJobStatus, LibraryProvider, NormalizedRelease } from "@aiobooks/core";
import type { AcquisitionQueue } from "./acquisition.js";
import type { CredentialCipher, EncryptedCredential } from "./credentials.js";
import type { Database } from "./database.js";
import { loadBookWork } from "./metadata-repository.js";
import { validateRemoteUrl } from "./network-security.js";

type PipelineKind = "download" | "materialize" | "deliver";
interface PipelineTask { kind: PipelineKind; id: string }
interface PipelineResult { delayMs?: number; tasks?: PipelineTask[] }

interface DownloadRow {
  id: string; acquisition_job_id: string; external_job_id: string | null; state: "QUEUED" | "DOWNLOADING";
  connection_id: string; base_url: string; owner_role: "ADMIN" | "USER";
  credential_key_version: number; credential_encrypted_data: Buffer; credential_nonce: Buffer; credential_auth_tag: Buffer;
  secret_key_version: number; secret_encrypted_data: Buffer; secret_nonce: Buffer; secret_auth_tag: Buffer;
  normalized_data: Omit<NormalizedRelease, "downloadRef" | "providerId" | "providerReleaseId">;
  provider_connection_id: string; provider_release_id: string;
}

interface DeliveryRow {
  id: string; request_id: string; acquisition_job_id: string; library_id: string; book_id: string; edition_id: string | null;
  media_type: "AUDIOBOOK" | "EBOOK"; kind: "FILESYSTEM" | "AUDIOBOOKSHELF"; external_library_id: string | null;
  library_config: { rootPath?: string }; connection_base_url: string | null; connection_owner_role: "ADMIN" | "USER" | null;
  key_version: number | null; encrypted_data: Buffer | null; nonce: Buffer | null; auth_tag: Buffer | null;
  output_manifest: Array<{ path: string; sizeBytes?: number }>; attempt_count: number;
}

function retryDelay(attempt: number): number { return Math.min(120_000, 5_000 * 2 ** Math.min(attempt, 4)); }

function encrypted(row: { key_version: number | null; encrypted_data: Buffer | null; nonce: Buffer | null; auth_tag: Buffer | null }): EncryptedCredential {
  if (row.key_version === null || !row.encrypted_data || !row.nonce || !row.auth_tag) throw new Error("Connection credentials are unavailable");
  return { keyVersion: row.key_version, encryptedData: row.encrypted_data, nonce: row.nonce, authTag: row.auth_tag };
}

async function updateRequests(sql: Database, acquisitionJobId: string, from: string[], to: string, eventType: string, message: string, detail: object = {}) {
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO request_events (request_id, from_state, to_state, event_type, public_message, detail)
      SELECT req.id, req.state, ${to}, ${eventType}, ${message}, ${transaction.json(JSON.parse(JSON.stringify(detail)))}
      FROM requests req JOIN acquisition_job_requests ajr ON ajr.request_id = req.id
      WHERE ajr.acquisition_job_id = ${acquisitionJobId} AND req.state IN ${transaction(from)}
    `;
    await transaction`UPDATE requests SET state = ${to}, updated_at = now() WHERE id IN (SELECT request_id FROM acquisition_job_requests WHERE acquisition_job_id = ${acquisitionJobId}) AND state IN ${transaction(from)}`;
    await transaction`UPDATE acquisition_jobs SET state = ${to}, updated_at = now() WHERE id = ${acquisitionJobId}`;
  });
}

async function persistStatus(sql: Database, row: DownloadRow, status: DownloadJobStatus): Promise<PipelineResult> {
  if (status.state === "FAILED") {
    await sql`UPDATE download_jobs SET state = 'FAILED', progress = ${status.progress ?? null}, last_error = ${status.error ?? "Download failed"}, next_poll_at = NULL, updated_at = now() WHERE id = ${row.id}`;
    await updateRequests(sql, row.acquisition_job_id, ["QUEUED", "DOWNLOADING"], "FAILED", "DOWNLOAD_FAILED", "Download failed", { code: "DOWNLOAD_CLIENT_FAILED" });
    return {};
  }
  if (status.state === "COMPLETED") {
    if (row.state === "QUEUED") await updateRequests(sql, row.acquisition_job_id, ["QUEUED"], "DOWNLOADING", "DOWNLOAD_STARTED", "Download started");
    await sql`UPDATE download_jobs SET state = 'COMPLETED', external_job_id = ${status.externalId}, progress = 100, output_manifest = ${sql.json(status.outputFiles ?? [])}, next_poll_at = NULL, updated_at = now() WHERE id = ${row.id}`;
    await updateRequests(sql, row.acquisition_job_id, ["DOWNLOADING"], "PROCESSING", "DOWNLOAD_COMPLETED", "Download completed and is ready for processing");
    return { tasks: [{ kind: "materialize", id: row.id }] };
  }
  const attempts = await sql<{ attempt_count: number }[]>`
    UPDATE download_jobs SET state = ${status.state}, external_job_id = ${status.externalId}, progress = ${status.progress ?? null}, attempt_count = attempt_count + 1,
      next_poll_at = now() + (${retryDelay(1)} * interval '1 millisecond'), updated_at = now() WHERE id = ${row.id} RETURNING attempt_count
  `;
  if (status.state === "DOWNLOADING" && row.state === "QUEUED") await updateRequests(sql, row.acquisition_job_id, ["QUEUED"], "DOWNLOADING", "DOWNLOAD_STARTED", "Download started");
  return { delayMs: retryDelay(attempts[0]?.attempt_count ?? 1) };
}

async function loadDownloadRow(sql: Database, downloadJobId: string): Promise<DownloadRow | undefined> {
  const rows = await sql<DownloadRow[]>`
    SELECT dj.id, dj.acquisition_job_id, dj.external_job_id, dj.state, dj.connection_id, c.base_url, connection_owner.role AS owner_role,
      cc.key_version AS credential_key_version, cc.encrypted_data AS credential_encrypted_data, cc.nonce AS credential_nonce, cc.auth_tag AS credential_auth_tag,
      sec.key_version AS secret_key_version, sec.encrypted_data AS secret_encrypted_data, sec.nonce AS secret_nonce, sec.auth_tag AS secret_auth_tag,
      rel.normalized_data, rel.provider_connection_id, rel.provider_release_id
    FROM download_jobs dj JOIN acquisition_jobs aj ON aj.id = dj.acquisition_job_id JOIN releases rel ON rel.id = aj.selected_release_id
    JOIN release_secrets sec ON sec.release_id = rel.id JOIN connections c ON c.id = dj.connection_id AND c.kind = 'TORBOX' AND c.enabled = true
    JOIN connection_credentials cc ON cc.connection_id = c.id JOIN users connection_owner ON connection_owner.id = c.owner_user_id
    WHERE dj.id = ${downloadJobId}
  `;
  return rows[0];
}

async function torBoxClient(row: DownloadRow, cipher: CredentialCipher): Promise<TorBoxDownloadClient> {
  const credentials = cipher.decrypt<{ apiKey?: string; token?: string }>({ keyVersion: row.credential_key_version, encryptedData: row.credential_encrypted_data, nonce: row.credential_nonce, authTag: row.credential_auth_tag });
  const apiKey = credentials.apiKey ?? credentials.token;
  if (!apiKey) throw new Error("TorBox API key is missing");
  const baseUrl = await validateRemoteUrl(row.base_url, row.owner_role === "ADMIN");
  return new TorBoxDownloadClient({ apiKey, baseUrl: baseUrl.toString(), validateDownloadUrl: async (value) => { await validateRemoteUrl(value, false); } });
}

async function processDownload(sql: Database, cipher: CredentialCipher, downloadJobId: string): Promise<PipelineResult> {
  const claimed = await sql<{ id: string }[]>`UPDATE download_jobs SET next_poll_at = now() + interval '5 minutes', updated_at = now() WHERE id = ${downloadJobId} AND state IN ('QUEUED', 'DOWNLOADING') AND (next_poll_at IS NULL OR next_poll_at <= now()) RETURNING id`;
  if (!claimed[0]) return {};
  const row = await loadDownloadRow(sql, downloadJobId);
  if (!row) {
    await sql`UPDATE download_jobs SET state = 'FAILED', last_error = 'Download configuration is unavailable', next_poll_at = NULL, updated_at = now() WHERE id = ${downloadJobId}`;
    return {};
  }
  try {
    const client = await torBoxClient(row, cipher);
    const secret = cipher.decrypt<{ downloadRef: string }>({ keyVersion: row.secret_key_version, encryptedData: row.secret_encrypted_data, nonce: row.secret_nonce, authTag: row.secret_auth_tag });
    const status = row.external_job_id ? await client.status(row.external_job_id) : await client.enqueue({ idempotencyKey: row.id, release: { ...row.normalized_data, providerId: row.provider_connection_id, providerReleaseId: row.provider_release_id, downloadRef: secret.downloadRef } });
    return await persistStatus(sql, row, status);
  } catch (error) {
    const attempts = await sql<{ attempt_count: number }[]>`UPDATE download_jobs SET attempt_count = attempt_count + 1, last_error = ${error instanceof Error ? error.message : "Download client error"}, next_poll_at = now() + (${retryDelay(1)} * interval '1 millisecond'), updated_at = now() WHERE id = ${row.id} RETURNING attempt_count`;
    return { delayMs: retryDelay(attempts[0]?.attempt_count ?? 1) };
  }
}

async function processMaterialize(sql: Database, cipher: CredentialCipher, stagingRoot: string, downloadJobId: string): Promise<PipelineResult> {
  const claimed = await sql<{ id: string }[]>`
    UPDATE download_jobs SET materialization_started_at = now(), updated_at = now() WHERE id = ${downloadJobId} AND state = 'COMPLETED' AND materialized_at IS NULL
      AND (materialization_started_at IS NULL OR materialization_started_at < now() - interval '10 minutes') RETURNING id
  `;
  if (!claimed[0]) return {};
  const row = await loadDownloadRow(sql, downloadJobId);
  const manifests = await sql<{ output_manifest: Array<{ path: string; sizeBytes?: number }>; external_job_id: string; acquisition_job_id: string }[]>`SELECT output_manifest, external_job_id, acquisition_job_id FROM download_jobs WHERE id = ${downloadJobId} AND state = 'COMPLETED'`;
  const manifest = manifests[0];
  if (!row || !manifest?.external_job_id || !Array.isArray(manifest.output_manifest)) throw new Error("Completed download manifest is unavailable");
  try {
    const client = await torBoxClient(row, cipher);
    const localFiles = await client.materialize(manifest.external_job_id, manifest.output_manifest, path.resolve(stagingRoot, downloadJobId));
    const deliveryIds = await sql.begin(async (transaction) => {
      await transaction`UPDATE download_jobs SET output_manifest = ${transaction.json(JSON.parse(JSON.stringify(localFiles)))}, materialized_at = now(), materialization_started_at = NULL, last_error = NULL, updated_at = now() WHERE id = ${downloadJobId}`;
      const deliveries = await transaction<{ id: string }[]>`
        INSERT INTO delivery_jobs (request_id, acquisition_job_id, library_id, state, next_attempt_at)
        SELECT req.id, ajr.acquisition_job_id, req.library_id, 'QUEUED', now() FROM requests req JOIN acquisition_job_requests ajr ON ajr.request_id = req.id
        WHERE ajr.acquisition_job_id = ${manifest.acquisition_job_id} ON CONFLICT (request_id) DO UPDATE SET updated_at = now() RETURNING id
      `;
      await transaction`INSERT INTO request_events (request_id, from_state, to_state, event_type, public_message) SELECT req.id, req.state, 'IMPORTING', 'FILES_MATERIALIZED', 'Files are ready for library import' FROM requests req JOIN acquisition_job_requests ajr ON ajr.request_id = req.id WHERE ajr.acquisition_job_id = ${manifest.acquisition_job_id} AND req.state = 'PROCESSING'`;
      await transaction`UPDATE requests SET state = 'IMPORTING', updated_at = now() WHERE id IN (SELECT request_id FROM acquisition_job_requests WHERE acquisition_job_id = ${manifest.acquisition_job_id}) AND state = 'PROCESSING'`;
      await transaction`UPDATE acquisition_jobs SET state = 'IMPORTING', updated_at = now() WHERE id = ${manifest.acquisition_job_id} AND state = 'PROCESSING'`;
      return deliveries.map((delivery) => delivery.id);
    });
    return { tasks: deliveryIds.map((id) => ({ kind: "deliver", id })) };
  } catch (error) {
    await sql`UPDATE download_jobs SET materialization_started_at = NULL, last_error = ${error instanceof Error ? error.message : "File materialization failed"}, updated_at = now() WHERE id = ${downloadJobId}`;
    return { delayMs: retryDelay(1) };
  }
}

function libraryPath(configuredRoot: string, libraryId: string, configuredSubpath?: string): string {
  const root = path.resolve(configuredRoot);
  const destination = path.resolve(root, configuredSubpath ?? libraryId);
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Library path escapes the configured root");
  return destination;
}

async function processDelivery(sql: Database, cipher: CredentialCipher, configuredLibraryRoot: string, deliveryJobId: string): Promise<PipelineResult> {
  const claimed = await sql<{ id: string }[]>`UPDATE delivery_jobs SET state = 'IMPORTING', next_attempt_at = now() + interval '10 minutes', updated_at = now() WHERE id = ${deliveryJobId} AND state IN ('QUEUED', 'IMPORTING') AND (next_attempt_at IS NULL OR next_attempt_at <= now()) RETURNING id`;
  if (!claimed[0]) return {};
  const rows = await sql<DeliveryRow[]>`
    SELECT delivery.id, delivery.request_id, delivery.acquisition_job_id, delivery.library_id, req.book_id, req.edition_id, req.media_type,
      l.kind, l.external_library_id, l.config AS library_config, c.base_url AS connection_base_url, owner.role AS connection_owner_role,
      cc.key_version, cc.encrypted_data, cc.nonce, cc.auth_tag, down.output_manifest, delivery.attempt_count
    FROM delivery_jobs delivery JOIN requests req ON req.id = delivery.request_id JOIN libraries l ON l.id = delivery.library_id
    JOIN download_jobs down ON down.acquisition_job_id = delivery.acquisition_job_id LEFT JOIN connections c ON c.id = l.connection_id AND c.enabled = true
    LEFT JOIN users owner ON owner.id = c.owner_user_id LEFT JOIN connection_credentials cc ON cc.connection_id = c.id WHERE delivery.id = ${deliveryJobId}
  `;
  const row = rows[0];
  if (!row || !Array.isArray(row.output_manifest)) return {};
  try {
    const work = await loadBookWork(sql, row.book_id);
    if (!work) throw new Error("Book metadata is unavailable");
    const edition: BookEdition = work.editions.find((item) => item.id === row.edition_id) ?? {
      id: row.edition_id ?? `work:${work.id}`, workId: work.id, title: work.title, ...(work.subtitle ? { subtitle: work.subtitle } : {}),
      authors: work.authors, narrators: [], languages: [], mediaTypes: [row.media_type], identifiers: work.identifiers,
    };
    const rootPath = libraryPath(configuredLibraryRoot, row.library_id, row.library_config.rootPath);
    let provider: LibraryProvider;
    if (row.kind === "FILESYSTEM") {
      provider = new FilesystemLibraryProvider({ rootPath });
    } else {
      if (!row.connection_base_url || !row.connection_owner_role || !row.external_library_id) throw new Error("Audiobookshelf library configuration is incomplete");
      const credentials = cipher.decrypt<{ apiToken?: string; token?: string }>(encrypted(row));
      const apiToken = credentials.apiToken ?? credentials.token;
      if (!apiToken) throw new Error("Audiobookshelf API token is missing");
      const baseUrl = await validateRemoteUrl(row.connection_base_url, row.connection_owner_role === "ADMIN");
      provider = new AudiobookshelfLibraryProvider({ baseUrl: baseUrl.toString(), apiToken, libraryId: row.external_library_id, rootPath });
    }
    const imported = await provider.import({ edition, files: row.output_manifest, idempotencyKey: row.acquisition_job_id });
    await sql.begin(async (transaction) => {
      await transaction`UPDATE delivery_jobs SET state = 'AVAILABLE', imported_item_id = ${imported.itemId ?? null}, next_attempt_at = NULL, last_error = NULL, updated_at = now() WHERE id = ${row.id}`;
      await transaction`UPDATE requests SET state = 'AVAILABLE', updated_at = now() WHERE id = ${row.request_id} AND state = 'IMPORTING'`;
      await transaction`INSERT INTO request_events (request_id, from_state, to_state, event_type, public_message, detail) VALUES (${row.request_id}, 'IMPORTING', 'AVAILABLE', 'LIBRARY_IMPORT_COMPLETED', 'Available in the configured library', ${transaction.json({ itemId: imported.itemId ?? null })})`;
      const remaining = await transaction<{ count: number }[]>`SELECT count(*)::int AS count FROM delivery_jobs WHERE acquisition_job_id = ${row.acquisition_job_id} AND state <> 'AVAILABLE'`;
      if ((remaining[0]?.count ?? 0) === 0) await transaction`UPDATE acquisition_jobs SET state = 'AVAILABLE', updated_at = now() WHERE id = ${row.acquisition_job_id}`;
    });
    return {};
  } catch (error) {
    const nextAttempt = row.attempt_count + 1;
    const terminal = nextAttempt >= 5;
    await sql.begin(async (transaction) => {
      await transaction`UPDATE delivery_jobs SET state = ${terminal ? "FAILED" : "QUEUED"}, attempt_count = ${nextAttempt}, next_attempt_at = ${terminal ? null : new Date(Date.now() + retryDelay(nextAttempt))}, last_error = ${error instanceof Error ? error.message : "Library import failed"}, updated_at = now() WHERE id = ${row.id}`;
      if (terminal) {
        await transaction`UPDATE requests SET state = 'FAILED', updated_at = now() WHERE id = ${row.request_id} AND state = 'IMPORTING'`;
        await transaction`INSERT INTO request_events (request_id, from_state, to_state, event_type, public_message, detail) VALUES (${row.request_id}, 'IMPORTING', 'FAILED', 'LIBRARY_IMPORT_FAILED', 'Library import failed after retries', ${transaction.json({ code: "LIBRARY_IMPORT_FAILED" })})`;
      }
    });
    return terminal ? {} : { delayMs: retryDelay(nextAttempt) };
  }
}

export interface AcquisitionQueueRuntime extends AcquisitionQueue { close(): Promise<void> }

export function createAcquisitionQueue(options: { redisUrl: string; stagingPath: string; libraryRootPath: string }, sql: Database, cipher: CredentialCipher): AcquisitionQueueRuntime {
  const producerConnection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("aiobooks-acquisition", { connection: producerConnection });
  const enqueue = async (task: PipelineTask, delay = 0) => { await queue.add(task.kind, task, { delay, jobId: randomUUID(), removeOnComplete: 1000, removeOnFail: 1000 }); };
  const worker = new Worker<PipelineTask>("aiobooks-acquisition", async (job) => {
    const result = job.data.kind === "download" ? await processDownload(sql, cipher, job.data.id)
      : job.data.kind === "materialize" ? await processMaterialize(sql, cipher, options.stagingPath, job.data.id)
        : await processDelivery(sql, cipher, options.libraryRootPath, job.data.id);
    for (const task of result.tasks ?? []) await enqueue(task);
    if (result.delayMs !== undefined) await enqueue(job.data, result.delayMs);
  }, { connection: workerConnection, concurrency: 4 });
  producerConnection.on("error", () => undefined); workerConnection.on("error", () => undefined); worker.on("error", () => undefined);
  const recovery = setInterval(() => {
    void Promise.all([
      sql<{ id: string }[]>`SELECT id FROM download_jobs WHERE state IN ('QUEUED', 'DOWNLOADING') AND (next_poll_at IS NULL OR next_poll_at <= now()) LIMIT 100`.then((rows) => Promise.all(rows.map((row) => enqueue({ kind: "download", id: row.id })))),
      sql<{ id: string }[]>`SELECT id FROM download_jobs WHERE state = 'COMPLETED' AND materialized_at IS NULL AND (materialization_started_at IS NULL OR materialization_started_at < now() - interval '10 minutes') LIMIT 100`.then((rows) => Promise.all(rows.map((row) => enqueue({ kind: "materialize", id: row.id })))),
      sql<{ id: string }[]>`SELECT id FROM delivery_jobs WHERE state IN ('QUEUED', 'IMPORTING') AND (next_attempt_at IS NULL OR next_attempt_at <= now()) LIMIT 100`.then((rows) => Promise.all(rows.map((row) => enqueue({ kind: "deliver", id: row.id })))),
    ]).catch(() => undefined);
  }, 30_000);
  recovery.unref();
  return {
    enqueueDownload: (downloadJobId) => enqueue({ kind: "download", id: downloadJobId }),
    async close() { clearInterval(recovery); await worker.close(); await queue.close(); await Promise.all([producerConnection.quit(), workerConnection.quit()]); },
  };
}
