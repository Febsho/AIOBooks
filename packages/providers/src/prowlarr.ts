import type { ConnectionTestResult, ReleaseSearchContext, SearchProvider, SearchProviderResult } from "@aiobooks/core";
import { z } from "zod";
import { normalizeRelease } from "./normalizer.js";

const releaseSchema = z.object({
  id: z.number().optional(), guid: z.string().nullish(), releaseHash: z.string().nullish(), title: z.string(),
  size: z.number().nonnegative().optional(), files: z.number().int().nullish(), grabs: z.number().int().nullish(),
  indexerId: z.number().int().optional(), indexer: z.string().nullish(), publishDate: z.string().optional(),
  downloadUrl: z.string().nullish(), infoUrl: z.string().nullish(), magnetUrl: z.string().nullish(), infoHash: z.string().nullish(),
  seeders: z.number().int().nullish(), leechers: z.number().int().nullish(), protocol: z.enum(["usenet", "torrent"]),
  categories: z.array(z.object({ id: z.number().int().optional(), name: z.string().nullish() }).passthrough()).nullish(),
}).passthrough();

export interface ProwlarrOptions {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  categories?: string[];
  priority?: number;
  fetch?: typeof globalThis.fetch;
}

export class ProwlarrSearchProvider implements SearchProvider {
  readonly id: string;
  readonly name: string;
  private readonly request: typeof globalThis.fetch;
  constructor(private readonly options: ProwlarrOptions) { this.id = options.id; this.name = options.name; this.request = options.fetch ?? globalThis.fetch; }

  private url(path: string): URL { return new URL(path, this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`); }
  private headers(): HeadersInit { return { accept: "application/json", "x-api-key": this.options.apiKey }; }

  async test(signal: AbortSignal): Promise<ConnectionTestResult> {
    try {
      const response = await this.request(this.url("api/v1/system/status"), { signal, headers: this.headers(), redirect: "error" });
      if (response.status === 401 || response.status === 403) return { ok: false, code: "AUTHENTICATION_FAILED", message: "Prowlarr rejected the API key." };
      if (!response.ok) return { ok: false, code: "INCOMPATIBLE_API", message: `Prowlarr returned HTTP ${response.status}.` };
      const body = z.object({ appName: z.string().nullish(), version: z.string().nullish() }).passthrough().parse(await response.json());
      return { ok: true, code: "CONNECTED", message: `${body.appName ?? "Prowlarr"}${body.version ? ` ${body.version}` : ""}` };
    } catch (error) {
      if (signal.aborted) return { ok: false, code: "TIMEOUT", message: "Prowlarr connection timed out." };
      return { ok: false, code: "UNREACHABLE", message: error instanceof Error ? error.message : "Prowlarr is unreachable." };
    }
  }

  async search(context: ReleaseSearchContext, signal: AbortSignal): Promise<SearchProviderResult> {
    const url = this.url("api/v1/search");
    url.searchParams.set("query", [context.work.title, context.work.authors[0]?.name].filter(Boolean).join(" "));
    url.searchParams.set("type", "book");
    url.searchParams.set("limit", "100");
    for (const category of this.options.categories ?? []) url.searchParams.append("categories", category);
    const response = await this.request(url, { signal, headers: this.headers(), redirect: "error" });
    if (!response.ok) throw new Error(`Prowlarr search returned HTTP ${response.status}`);
    const items = z.array(releaseSchema).parse(await response.json());
    return { releases: items.map((item) => normalizeRelease({
      providerId: this.id,
      providerReleaseId: item.guid ?? item.releaseHash ?? `${item.indexerId ?? 0}:${item.id ?? item.title}`,
      rawTitle: item.title,
      work: context.work,
      protocol: item.protocol === "usenet" ? "USENET" : "TORRENT",
      downloadRef: item.downloadUrl ?? item.magnetUrl ?? item.guid ?? "",
      categories: (item.categories ?? []).flatMap((category) => [category.id?.toString(), category.name ?? undefined].filter((value): value is string => Boolean(value))),
      ...(item.size !== undefined ? { sizeBytes: item.size } : {}),
      ...(item.files != null ? { files: item.files } : {}),
      ...(item.publishDate ? { publishedAt: item.publishDate } : {}),
      ...(item.grabs != null ? { grabs: item.grabs } : {}),
      ...(item.seeders != null ? { seeders: item.seeders } : {}),
      ...(item.leechers != null ? { leechers: item.leechers } : {}),
      ...(item.infoUrl ? { infoUrl: item.infoUrl } : {}),
      ...(this.options.priority !== undefined ? { sourcePriority: this.options.priority } : {}),
    })) };
  }
}
