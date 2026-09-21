import type { RankedRelease } from "./domain.js";
import type { RankingEngine, ReleaseSearchContext, SearchProvider } from "./interfaces.js";
import { deduplicateReleases } from "./ranking.js";

export interface ProviderDiagnostic {
  providerId: string;
  outcome: "SUCCESS" | "TIMEOUT" | "ERROR";
  durationMs: number;
  releaseCount: number;
  message?: string;
}

export interface AggregationResult {
  ranked: RankedRelease[];
  diagnostics: ProviderDiagnostic[];
}

export async function aggregateReleases(
  providers: SearchProvider[],
  context: ReleaseSearchContext,
  ranking: RankingEngine,
  timeoutMs: number | ((provider: SearchProvider) => number),
): Promise<AggregationResult> {
  const tasks = providers.map(async (provider) => {
    const started = performance.now();
    const controller = new AbortController();
    const providerTimeoutMs = typeof timeoutMs === "function" ? timeoutMs(provider) : timeoutMs;
    const timeout = setTimeout(() => controller.abort(new Error("provider timeout")), providerTimeoutMs);
    try {
      const result = await provider.search(context, controller.signal);
      return {
        releases: result.releases,
        diagnostic: { providerId: provider.id, outcome: "SUCCESS", durationMs: Math.round(performance.now() - started), releaseCount: result.releases.length } satisfies ProviderDiagnostic,
      };
    } catch (error) {
      const timedOut = controller.signal.aborted;
      return {
        releases: [],
        diagnostic: {
          providerId: provider.id,
          outcome: timedOut ? "TIMEOUT" : "ERROR",
          durationMs: Math.round(performance.now() - started),
          releaseCount: 0,
          message: error instanceof Error ? error.message : "unknown provider error",
        } satisfies ProviderDiagnostic,
      };
    } finally {
      clearTimeout(timeout);
    }
  });
  const settled = await Promise.all(tasks);
  const releases = deduplicateReleases(settled.flatMap((result) => result.releases));
  return {
    ranked: ranking.rank({ work: context.work, ...(context.edition ? { edition: context.edition } : {}), mediaType: context.profile.mediaType }, releases, context.profile),
    diagnostics: settled.map((result) => result.diagnostic),
  };
}
