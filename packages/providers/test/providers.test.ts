import { describe, expect, it } from "vitest";
import type { AcquisitionProfile, BookWork, ReleaseSearchContext } from "@aiobooks/core";
import { NewznabSearchProvider, ProwlarrSearchProvider, detectFormat, detectMediaType } from "../src/index.js";

const work: BookWork = { id: "w", title: "Atomic Habits", authors: [{ name: "James Clear" }], genres: [], identifiers: [], editions: [] };
const profile: AcquisitionProfile = { id: "p", name: "Audio", mediaType: "AUDIOBOOK", languages: ["en"], formatOrder: ["M4B", "MP3"], protocolOrder: ["USENET", "TORRENT"], minimumConfidence: 60, preferredNarrators: [] };
const context: ReleaseSearchContext = { work, profile };

describe("release detection", () => {
  it("detects audiobook and ebook formats without video assumptions", () => {
    expect(detectFormat("Atomic.Habits.Unabridged.M4B")).toBe("M4B");
    expect(detectMediaType("Atomic Habits", "M4B")).toBe("AUDIOBOOK");
    expect(detectMediaType("Atomic Habits", "EPUB")).toBe("EBOOK");
  });
});

describe("ProwlarrSearchProvider", () => {
  it("uses the official book search contract and normalizes releases", async () => {
    let requested = "";
    const provider = new ProwlarrSearchProvider({ id: "c1", name: "Prowlarr", baseUrl: "http://prowlarr:9696", apiKey: "key", categories: ["3030"], fetch: async (input) => {
      requested = String(input);
      return new Response(JSON.stringify([{ id: 7, guid: "guid-7", title: "Atomic.Habits.James.Clear.English.M4B", size: 500, protocol: "usenet", downloadUrl: "http://download/7", categories: [{ id: 3030, name: "Audio/Audiobook" }] }]), { status: 200, headers: { "content-type": "application/json" } });
    } });
    const result = await provider.search(context, new AbortController().signal);
    expect(requested).toContain("type=book");
    expect(requested).toContain("categories=3030");
    expect(result.releases[0]).toMatchObject({ mediaType: "AUDIOBOOK", format: "M4B", authors: ["James Clear"], downloadProtocol: "USENET" });
  });
});

describe("NewznabSearchProvider", () => {
  it("parses RSS and extended attributes into the same release model", async () => {
    let requested = "";
    const xml = `<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><item><title>Atomic.Habits.James.Clear.English.MP3</title><guid>nzb-1</guid><link>https://indexer/api?t=get&amp;id=nzb-1</link><pubDate>Mon, 01 Sep 2025 10:00:00 GMT</pubDate><newznab:attr name="size" value="1000"/><newznab:attr name="category" value="3030"/></item></channel></rss>`;
    const provider = new NewznabSearchProvider({ id: "c2", name: "Newznab", baseUrl: "https://indexer.example/api", apiKey: "secret", fetch: async (input) => { requested = String(input); return new Response(xml, { status: 200 }); } });
    const result = await provider.search(context, new AbortController().signal);
    expect(requested).toContain("t=book");
    expect(requested).toContain("title=Atomic+Habits");
    expect(result.releases[0]).toMatchObject({ providerReleaseId: "nzb-1", mediaType: "AUDIOBOOK", format: "MP3", sizeBytes: 1000 });
  });
});
