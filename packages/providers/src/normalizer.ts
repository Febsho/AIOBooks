import { createHash } from "node:crypto";
import type { BookWork, DownloadProtocol, ExternalIdentifier, MediaType, NormalizedRelease, ReleaseFormat } from "@aiobooks/core";
import { normalizeText } from "@aiobooks/core";

const formatPatterns: Array<[ReleaseFormat, RegExp]> = [
  ["M4B", /(?:^|[\s._-])m4b(?:$|[\s._-])/i], ["M4A", /(?:^|[\s._-])m4a(?:$|[\s._-])/i],
  ["MP3", /(?:^|[\s._-])mp3(?:$|[\s._-])/i], ["FLAC", /(?:^|[\s._-])flac(?:$|[\s._-])/i],
  ["EPUB", /(?:^|[\s._-])epub(?:$|[\s._-])/i], ["AZW3", /(?:^|[\s._-])azw3(?:$|[\s._-])/i],
  ["MOBI", /(?:^|[\s._-])mobi(?:$|[\s._-])/i], ["PDF", /(?:^|[\s._-])pdf(?:$|[\s._-])/i],
];

const languagePatterns: Array<[string, RegExp]> = [
  ["en", /(?:^|[\s._\[(-])(english|eng)(?:$|[\s._\])+-])/i],
  ["de", /(?:^|[\s._\[(-])(german|deutsch|ger|deu)(?:$|[\s._\])+-])/i],
  ["fr", /(?:^|[\s._\[(-])(french|francais|fre|fra)(?:$|[\s._\])+-])/i],
  ["es", /(?:^|[\s._\[(-])(spanish|espanol|spa)(?:$|[\s._\])+-])/i],
];

export function detectFormat(title: string): ReleaseFormat {
  return formatPatterns.find(([, pattern]) => pattern.test(` ${title} `))?.[0] ?? "UNKNOWN";
}

export function detectLanguages(title: string): string[] {
  return languagePatterns.filter(([, pattern]) => pattern.test(` ${title} `)).map(([language]) => language);
}

export function detectMediaType(title: string, format: ReleaseFormat, categories: string[] = []): MediaType {
  if (["M4B", "M4A", "MP3", "FLAC"].includes(format) || /audio\s*book|unabridged|abridged/i.test(title) || categories.some((value) => value === "3030" || /audio.*book/i.test(value))) return "AUDIOBOOK";
  if (["EPUB", "AZW3", "MOBI", "PDF"].includes(format) || /e[ -]?book/i.test(title) || categories.some((value) => value === "7020" || /e-?book/i.test(value))) return "EBOOK";
  return "UNKNOWN";
}

export function inferWorkSignals(work: BookWork, title: string): { parsedTitle?: string; authors: string[] } {
  const normalizedRelease = ` ${normalizeText(title)} `;
  const normalizedTitle = normalizeText(work.title);
  const parsedTitle = normalizedRelease.includes(` ${normalizedTitle} `) ? work.title : undefined;
  const authors = work.authors.filter((author) => normalizedRelease.includes(` ${normalizeText(author.name)} `)).map((author) => author.name);
  return { ...(parsedTitle ? { parsedTitle } : {}), authors };
}

export interface RawReleaseInput {
  providerId: string;
  providerReleaseId: string;
  rawTitle: string;
  work: BookWork;
  protocol: DownloadProtocol;
  downloadRef: string;
  categories?: string[];
  sizeBytes?: number;
  files?: number;
  publishedAt?: string;
  grabs?: number;
  seeders?: number;
  leechers?: number;
  infoUrl?: string;
  identifiers?: ExternalIdentifier[];
  sourcePriority?: number;
}

export function normalizeRelease(input: RawReleaseInput): NormalizedRelease {
  const format = detectFormat(input.rawTitle);
  const signals = inferWorkSignals(input.work, input.rawTitle);
  const id = createHash("sha256").update(`${input.providerId}\0${input.providerReleaseId}`).digest("hex").slice(0, 32);
  return {
    id,
    providerId: input.providerId,
    providerReleaseId: input.providerReleaseId,
    rawTitle: input.rawTitle,
    ...signals,
    narrators: [],
    mediaType: detectMediaType(input.rawTitle, format, input.categories),
    format,
    languages: detectLanguages(input.rawTitle),
    downloadProtocol: input.protocol,
    downloadRef: input.downloadRef,
    identifiers: input.identifiers ?? [],
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    ...(input.files !== undefined ? { files: input.files } : {}),
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.grabs !== undefined ? { grabs: input.grabs } : {}),
    ...(input.seeders !== undefined ? { seeders: input.seeders } : {}),
    ...(input.leechers !== undefined ? { leechers: input.leechers } : {}),
    ...(input.infoUrl ? { infoUrl: input.infoUrl } : {}),
    ...(input.sourcePriority !== undefined ? { sourcePriority: input.sourcePriority } : {}),
  };
}
