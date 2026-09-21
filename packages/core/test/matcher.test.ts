import { describe, expect, it } from "vitest";
import { BookReleaseMatcher, ProfileRankingEngine, type AcquisitionProfile, type BookWork, type NormalizedRelease } from "../src/index.js";

const work: BookWork = {
  id: "work:atomic-habits",
  title: "Atomic Habits",
  authors: [{ name: "James Clear" }],
  genres: [],
  identifiers: [{ type: "ISBN_13", value: "9780735211292" }],
  editions: [],
};

function release(id: string, rawTitle: string, authors: string[] = [], overrides: Partial<NormalizedRelease> = {}): NormalizedRelease {
  return {
    id,
    providerId: "fixture",
    providerReleaseId: id,
    rawTitle,
    authors,
    narrators: [],
    mediaType: "AUDIOBOOK",
    format: "M4B",
    languages: ["en"],
    downloadProtocol: "USENET",
    downloadRef: `fixture:${id}`,
    identifiers: [],
    ...overrides,
  };
}

describe("BookReleaseMatcher", () => {
  const matcher = new BookReleaseMatcher();
  const target = { work, mediaType: "AUDIOBOOK" as const };

  it("accepts an exact normalized title and author", () => {
    const result = matcher.match(target, release("good", "Atomic.Habits.James.Clear.Unabridged.M4B", ["James Clear"]));
    expect(result.accepted).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(90);
  });

  it.each([
    "The.Atomic.Weight.of.Love",
    "The.7.Habits.of.Highly.Effective.People",
    "Tiny.Habits",
    "Atomic.Bomb",
  ])("rejects unrelated release %s", (title) => {
    expect(matcher.match(target, release(title, title)).accepted).toBe(false);
  });

  it("lets an exact identifier dominate incomplete text metadata", () => {
    const result = matcher.match(target, release("isbn", "Atomic Habits Retail", [], { identifiers: [{ type: "ISBN_13", value: "978-0-7352-1129-2" }] }));
    expect(result.accepted).toBe(true);
    expect(result.matchedIdentifiers).toHaveLength(1);
  });

  it("hard rejects the wrong media type", () => {
    const result = matcher.match(target, release("ebook", "Atomic Habits", ["James Clear"], { mediaType: "EBOOK", format: "EPUB" }));
    expect(result.accepted).toBe(false);
    expect(result.confidence).toBe(0);
  });
});

describe("ProfileRankingEngine", () => {
  const profile: AcquisitionProfile = {
    id: "profile:default",
    name: "Default audiobook",
    mediaType: "AUDIOBOOK",
    languages: ["en"],
    formatOrder: ["M4B", "M4A", "MP3"],
    protocolOrder: ["USENET", "TORRENT"],
    minimumConfidence: 70,
    preferredNarrators: [],
  };

  it("applies filters before configurable format ranking", () => {
    const ranking = new ProfileRankingEngine();
    const ranked = ranking.rank(
      { work, mediaType: "AUDIOBOOK" },
      [release("mp3", "Atomic Habits", ["James Clear"], { format: "MP3" }), release("m4b", "Atomic Habits", ["James Clear"])],
      profile,
    );
    expect(ranked.map((item) => item.release.id)).toEqual(["m4b", "mp3"]);
  });
});
