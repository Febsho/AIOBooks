import { aggregateReleases, ProfileRankingEngine, type AcquisitionProfile, type BookWork, type NormalizedRelease } from "@aiobooks/core";
import type { AuthUser } from "./auth.js";
import type { CredentialCipher } from "./credentials.js";
import type { Database } from "./database.js";
import { loadSearchProviders } from "./provider-factory.js";

const HOUR = 3_600_000;
const MAX_WANTED_DELAY = 7 * 24 * HOUR;

export function wantedRetryDelayMs(attempt: number, random = Math.random): number {
  const exponential = Math.min(MAX_WANTED_DELAY, 6 * HOUR * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.round(exponential * jitter);
}

function sanitizeRelease(release: NormalizedRelease) {
  const { downloadRef: _downloadRef, providerId: _providerId, providerReleaseId: _providerReleaseId, ...safe } = release;
  return safe;
}

export async function executeAcquisitionSearch(input: {
  sql: Database;
  cipher: CredentialCipher;
  jobId: string;
  correlationId: string;
  user: AuthUser;
  work: BookWork;
  profile: AcquisitionProfile;
}) {
  const loaded = await loadSearchProviders(input.sql, input.user, input.cipher);
  const timeoutById = new Map(loaded.map((entry) => [entry.provider.id, entry.timeoutMs]));
  const aggregation = await aggregateReleases(
    loaded.map((entry) => entry.provider),
    { work: input.work, profile: input.profile },
    new ProfileRankingEngine(),
    (provider) => timeoutById.get(provider.id) ?? 15_000,
  );
  const nextState = aggregation.ranked.length > 0 ? "MATCHED" : "WANTED";
  await input.sql.begin(async (transaction) => {
    const jobs = await transaction<{ attempt_count: number }[]>`SELECT attempt_count FROM acquisition_jobs WHERE id = ${input.jobId} FOR UPDATE`;
    const attempt = (jobs[0]?.attempt_count ?? 0) + 1;
    const [search] = await transaction<{ id: string }[]>`
      INSERT INTO release_searches (acquisition_job_id, correlation_id, diagnostics, result_count, expires_at)
      VALUES (${input.jobId}, ${input.correlationId}, ${transaction.json(JSON.parse(JSON.stringify(aggregation.diagnostics)))}, ${aggregation.ranked.length}, now() + interval '24 hours') RETURNING id
    `;
    for (const ranked of aggregation.ranked) {
      const safeRelease = JSON.parse(JSON.stringify(sanitizeRelease(ranked.release)));
      const matchData = JSON.parse(JSON.stringify({ ...ranked.match, scoreReasons: ranked.scoreReasons }));
      const [stored] = await transaction<{ id: string }[]>`
        INSERT INTO releases (release_search_id, provider_connection_id, provider_release_id, normalized_data, match_data, rank_score)
        VALUES (${search!.id}, ${ranked.release.providerId}, ${ranked.release.providerReleaseId}, ${transaction.json(safeRelease)}, ${transaction.json(matchData)}, ${ranked.score})
        RETURNING id
      `;
      const encrypted = input.cipher.encrypt({ downloadRef: ranked.release.downloadRef });
      await transaction`INSERT INTO release_secrets (release_id, key_version, encrypted_data, nonce, auth_tag) VALUES (${stored!.id}, ${encrypted.keyVersion}, ${encrypted.encryptedData}, ${encrypted.nonce}, ${encrypted.authTag})`;
    }
    const nextSearchAt = nextState === "WANTED" ? new Date(Date.now() + wantedRetryDelayMs(attempt)) : null;
    await transaction`UPDATE acquisition_jobs SET state = ${nextState}, attempt_count = ${attempt}, next_search_at = ${nextSearchAt}, updated_at = now() WHERE id = ${input.jobId}`;
    await transaction`UPDATE requests SET state = ${nextState}, updated_at = now() WHERE id IN (SELECT request_id FROM acquisition_job_requests WHERE acquisition_job_id = ${input.jobId}) AND state = 'SEARCHING'`;
    await transaction`
      INSERT INTO request_events (request_id, from_state, to_state, event_type, public_message, detail)
      SELECT request_id, 'SEARCHING', ${nextState}, 'SEARCH_COMPLETED', ${nextState === "MATCHED" ? "Suitable releases found" : "No acceptable release found"}, ${transaction.json(JSON.parse(JSON.stringify({ diagnostics: aggregation.diagnostics, attempt })))}
      FROM acquisition_job_requests WHERE acquisition_job_id = ${input.jobId}
    `;
    await transaction`
      INSERT INTO remote_request_events (remote_request_id, from_state, to_state, event_type, public_message, detail)
      SELECT id, 'SEARCHING', ${nextState}, 'SEARCH_COMPLETED', ${nextState === "MATCHED" ? "Suitable releases found" : "No compatible remote release found"}, ${transaction.json(JSON.parse(JSON.stringify({ diagnostics: aggregation.diagnostics, attempt })))}
      FROM remote_requests WHERE acquisition_job_id = ${input.jobId} AND state = 'SEARCHING'
    `;
    await transaction`UPDATE remote_requests SET state = ${nextState}, updated_at = now() WHERE acquisition_job_id = ${input.jobId} AND state = 'SEARCHING'`;
  });
  return { state: nextState, diagnostics: aggregation.diagnostics } as const;
}
