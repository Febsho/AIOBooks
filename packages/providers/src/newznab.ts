import type { ConnectionTestResult, ReleaseSearchContext, SearchProvider, SearchProviderResult } from "@aiobooks/core";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { normalizeRelease } from "./normalizer.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, isArray: (_name, path) => typeof path === "string" && (path.endsWith("channel.item") || path.endsWith("item.attr") || path.endsWith("categories.category")) });
const attrSchema = z.object({ "@_name": z.string(), "@_value": z.coerce.string() }).passthrough();
const itemSchema = z.object({
  title: z.string(), guid: z.union([z.string(), z.object({ "#text": z.string().optional() }).passthrough()]),
  link: z.string().optional(), pubDate: z.string().optional(), enclosure: z.object({ "@_url": z.string().optional(), "@_length": z.coerce.number().optional() }).optional(),
  attr: z.array(attrSchema).optional(), comments: z.string().optional(),
}).passthrough();

function scalarGuid(value: z.infer<typeof itemSchema>["guid"]): string { return typeof value === "string" ? value : value["#text"] ?? "unknown"; }
function attributes(item: z.infer<typeof itemSchema>): Map<string, string> { return new Map((item.attr ?? []).map((entry) => [entry["@_name"].toLocaleLowerCase("en"), entry["@_value"]])); }
function optionalNumber(value: string | undefined): number | undefined { if (value === undefined) return undefined; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }

export interface NewznabOptions {
  id: string; name: string; baseUrl: string; apiKey: string; categories?: string[]; priority?: number; fetch?: typeof globalThis.fetch;
}

export class NewznabSearchProvider implements SearchProvider {
  readonly id: string;
  readonly name: string;
  private readonly request: typeof globalThis.fetch;
  constructor(private readonly options: NewznabOptions) { this.id = options.id; this.name = options.name; this.request = options.fetch ?? globalThis.fetch; }

  private apiUrl(): URL { return new URL(this.options.baseUrl); }
  private async xml(url: URL, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.request(url, { signal, redirect: "error", headers: { accept: "application/rss+xml, application/xml;q=0.9" } });
    if (response.status === 401 || response.status === 403) throw new Error("AUTHENTICATION_FAILED");
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const body = parser.parse(await response.text()) as Record<string, unknown>;
    const error = body.error as { "@_code"?: string; "@_description"?: string } | undefined;
    if (error) throw new Error(`NEWZNAB_${error["@_code"] ?? "ERROR"}: ${error["@_description"] ?? "Unknown Newznab error"}`);
    return body;
  }

  async test(signal: AbortSignal): Promise<ConnectionTestResult> {
    const url = this.apiUrl(); url.searchParams.set("t", "caps"); url.searchParams.set("apikey", this.options.apiKey);
    try {
      const body = await this.xml(url, signal);
      if (!body.caps) return { ok: false, code: "INCOMPATIBLE_API", message: "The endpoint did not return Newznab capabilities." };
      return { ok: true, code: "CONNECTED", message: "Newznab capabilities loaded." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Newznab is unreachable.";
      if (signal.aborted) return { ok: false, code: "TIMEOUT", message: "Newznab connection timed out." };
      if (message === "AUTHENTICATION_FAILED" || /NEWZNAB_(100|101|102)/.test(message)) return { ok: false, code: "AUTHENTICATION_FAILED", message: "Newznab rejected the API key." };
      return { ok: false, code: message.startsWith("HTTP_") ? "INCOMPATIBLE_API" : "UNREACHABLE", message };
    }
  }

  async search(context: ReleaseSearchContext, signal: AbortSignal): Promise<SearchProviderResult> {
    const createUrl = (type: "book" | "search") => {
      const url = this.apiUrl();
      url.searchParams.set("t", type); url.searchParams.set("apikey", this.options.apiKey); url.searchParams.set("o", "xml");
      url.searchParams.set("q", [context.work.title, context.work.authors[0]?.name].filter(Boolean).join(" "));
      if (type === "book") {
        url.searchParams.set("title", context.work.title);
        if (context.work.authors[0]?.name) url.searchParams.set("author", context.work.authors[0].name);
      }
      if (this.options.categories?.length) url.searchParams.set("cat", this.options.categories.join(","));
      return url;
    };
    let body: Record<string, unknown>;
    try { body = await this.xml(createUrl("book"), signal); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("NEWZNAB_202")) throw error;
      body = await this.xml(createUrl("search"), signal);
    }
    const channel = (body.rss as { channel?: { item?: unknown[] } } | undefined)?.channel;
    const items = z.array(itemSchema).parse(channel?.item ?? []);
    return { releases: items.map((item) => {
      const attrs = attributes(item); const guid = scalarGuid(item.guid);
      const size = optionalNumber(attrs.get("size")) ?? item.enclosure?.["@_length"];
      const categories = [attrs.get("category")].filter((value): value is string => Boolean(value));
      return normalizeRelease({
        providerId: this.id, providerReleaseId: guid, rawTitle: item.title, work: context.work, protocol: "USENET",
        downloadRef: item.enclosure?.["@_url"] ?? item.link ?? guid, categories,
        ...(size !== undefined ? { sizeBytes: size } : {}),
        ...(optionalNumber(attrs.get("files")) !== undefined ? { files: optionalNumber(attrs.get("files"))! } : {}),
        ...(item.pubDate ? { publishedAt: new Date(item.pubDate).toISOString() } : {}),
        ...(optionalNumber(attrs.get("grabs")) !== undefined ? { grabs: optionalNumber(attrs.get("grabs"))! } : {}),
        ...(item.comments ? { infoUrl: item.comments } : {}),
        ...(this.options.priority !== undefined ? { sourcePriority: this.options.priority } : {}),
      });
    }) };
  }
}
