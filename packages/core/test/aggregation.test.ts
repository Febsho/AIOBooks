import { describe, expect, it } from "vitest";
import { aggregateReleases, ProfileRankingEngine, type AcquisitionProfile, type BookWork, type SearchProvider } from "../src/index.js";

const work: BookWork = { id: "w", title: "Project Hail Mary", authors: [{ name: "Andy Weir" }], genres: [], identifiers: [], editions: [] };
const profile: AcquisitionProfile = { id: "p", name: "audio", mediaType: "AUDIOBOOK", languages: ["en"], formatOrder: ["M4B"], protocolOrder: ["USENET"], minimumConfidence: 60, preferredNarrators: [] };

describe("aggregateReleases", () => {
  it("isolates provider failures and retains successful results", async () => {
    const good: SearchProvider = {
      id: "good", name: "Good",
      test: async () => ({ ok: true, code: "CONNECTED", message: "ok" }),
      search: async () => ({ releases: [{ id: "r", providerId: "good", providerReleaseId: "1", rawTitle: "Andy.Weir.Project.Hail.Mary.M4B", parsedTitle: "Project Hail Mary", authors: ["Andy Weir"], narrators: [], mediaType: "AUDIOBOOK", format: "M4B", languages: ["en"], downloadProtocol: "USENET", downloadRef: "ref", identifiers: [] }] }),
    };
    const failing: SearchProvider = {
      id: "bad", name: "Bad",
      test: async () => ({ ok: false, code: "UNREACHABLE", message: "down" }),
      search: async () => { throw new Error("503"); },
    };
    const result = await aggregateReleases([good, failing], { work, profile }, new ProfileRankingEngine(), 100);
    expect(result.ranked).toHaveLength(1);
    expect(result.diagnostics.map((item) => item.outcome).sort()).toEqual(["ERROR", "SUCCESS"]);
  });
});
