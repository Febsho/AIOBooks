const RELEASE_NOISE = new Set([
  "unabridged", "abridged", "audiobook", "ebook", "retail", "proper", "repack",
  "web", "webrip", "scene", "complete", "m4b", "m4a", "mp3", "flac", "epub",
  "azw3", "mobi", "pdf", "eng", "english", "deu", "ger", "german",
]);

export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[._+\-–—()[\]{}]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function meaningfulTokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !RELEASE_NOISE.has(token));
}

export function tokenSimilarity(left: string, right: string): number {
  const a = new Set(meaningfulTokens(left));
  const b = new Set(meaningfulTokens(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function namesMatch(left: string, right: string): boolean {
  const a = meaningfulTokens(left);
  const b = meaningfulTokens(right);
  if (a.length === 0 || b.length === 0) return false;
  return a.every((token) => b.includes(token)) || b.every((token) => a.includes(token));
}

export function canonicalIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}
