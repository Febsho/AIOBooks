import type { BookEdition, BookWork, ExternalIdentifier, MetadataProvider, MetadataSearchQuery, MetadataSearchResult } from "@aiobooks/core";
import { z } from "zod";

const editionSchema = z.object({
  key: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  author_name: z.array(z.string()).optional(),
  isbn: z.array(z.string()).optional(),
  language: z.array(z.string()).optional(),
  publisher: z.array(z.string()).optional(),
  publish_date: z.array(z.string()).optional(),
}).passthrough();

const documentSchema = z.object({
  key: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  author_name: z.array(z.string()).optional(),
  first_publish_year: z.number().int().optional(),
  cover_i: z.number().int().optional(),
  isbn: z.array(z.string()).optional(),
  language: z.array(z.string()).optional(),
  subject: z.array(z.string()).optional(),
  editions: z.object({ docs: z.array(editionSchema) }).optional(),
}).passthrough();

const responseSchema = z.object({
  numFound: z.number().int().optional(),
  num_found: z.number().int().optional(),
  start: z.number().int().default(0),
  docs: z.array(documentSchema),
});

function openLibraryId(key: string): string {
  return key.split("/").filter(Boolean).at(-1) ?? key;
}

function identifiers(values: string[] | undefined, openLibraryKey: string): ExternalIdentifier[] {
  const isbn = (values ?? []).map((value): ExternalIdentifier => ({ type: value.replace(/\D/g, "").length === 10 ? "ISBN_10" : "ISBN_13", value }));
  return [{ type: "OPEN_LIBRARY", value: openLibraryId(openLibraryKey) }, ...isbn];
}

function mapEdition(raw: z.infer<typeof editionSchema>, workId: string): BookEdition {
  const id = openLibraryId(raw.key);
  const result: BookEdition = {
    id: `openlibrary:${id}`,
    workId,
    title: raw.title,
    authors: (raw.author_name ?? []).map((name) => ({ name })),
    narrators: [],
    languages: raw.language ?? [],
    mediaTypes: ["EBOOK"],
    identifiers: identifiers(raw.isbn, raw.key),
  };
  if (raw.subtitle) result.subtitle = raw.subtitle;
  if (raw.publisher?.[0]) result.publisher = raw.publisher[0];
  if (raw.publish_date?.[0]) result.publishedAt = raw.publish_date[0];
  return result;
}

function mapWork(raw: z.infer<typeof documentSchema>): BookWork {
  const externalId = openLibraryId(raw.key);
  const id = `openlibrary:${externalId}`;
  const result: BookWork = {
    id,
    title: raw.title,
    authors: (raw.author_name ?? []).map((name) => ({ name })),
    genres: (raw.subject ?? []).slice(0, 12),
    identifiers: identifiers(raw.isbn, raw.key),
    editions: (raw.editions?.docs ?? []).map((edition) => mapEdition(edition, id)),
  };
  if (raw.subtitle) result.subtitle = raw.subtitle;
  if (raw.first_publish_year) result.firstPublishedYear = raw.first_publish_year;
  if (raw.cover_i) result.coverUrl = `https://covers.openlibrary.org/b/id/${raw.cover_i}-L.jpg`;
  return result;
}

export interface OpenLibraryOptions {
  userAgent: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class OpenLibraryMetadataProvider implements MetadataProvider {
  readonly id = "openlibrary";
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(private readonly options: OpenLibraryOptions) {
    this.baseUrl = options.baseUrl ?? "https://openlibrary.org";
    this.request = options.fetch ?? globalThis.fetch;
  }

  async search(query: MetadataSearchQuery, signal?: AbortSignal): Promise<MetadataSearchResult> {
    const url = new URL("/search.json", this.baseUrl);
    url.searchParams.set("q", query.query);
    url.searchParams.set("limit", String(Math.min(query.limit ?? 20, 50)));
    url.searchParams.set("offset", String(Math.max(query.offset ?? 0, 0)));
    url.searchParams.set("fields", "key,title,subtitle,author_name,first_publish_year,cover_i,isbn,language,subject,editions,editions.key,editions.title,editions.subtitle,editions.author_name,editions.isbn,editions.language,editions.publisher,editions.publish_date");
    if (query.language) url.searchParams.set("lang", query.language);
    const response = await this.request(url, { ...(signal ? { signal } : {}), headers: { accept: "application/json", "user-agent": this.options.userAgent } });
    if (!response.ok) throw new Error(`Open Library search failed with HTTP ${response.status}`);
    const parsed = responseSchema.parse(await response.json());
    return { items: parsed.docs.map(mapWork), total: parsed.numFound ?? parsed.num_found ?? parsed.docs.length, offset: parsed.start };
  }

  async getWork(id: string, signal?: AbortSignal): Promise<BookWork | null> {
    const externalId = id.replace(/^openlibrary:/, "");
    const url = new URL(`/works/${encodeURIComponent(externalId)}.json`, this.baseUrl);
    const response = await this.request(url, { ...(signal ? { signal } : {}), headers: { accept: "application/json", "user-agent": this.options.userAgent } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Open Library work lookup failed with HTTP ${response.status}`);
    const raw = documentSchema.parse(await response.json());
    return mapWork({ ...raw, key: raw.key || `/works/${externalId}` });
  }
}
