import { describe, expect, it } from "vitest";
import { buildPageTurnerSource, integrationTokenHash, pageTurnerCompatibilityKey } from "../src/pageturner.js";
import { isRemoteReleaseCompatible, outputIsExpired } from "../src/remote-output.js";

describe("PageTurner source integration", () => {
  it("generates an importable source using the documented mapping contract", () => {
    const source = buildPageTurnerSource({ id: "12345678-1234-1234-1234-123456789abc", token: "personal-token", type: "torrent", publicBaseUrl: "https://books.example" });
    expect(source).toMatchObject({ type: "torrent", response: { type: "json", resultsPath: "items", mapping: { title: "title", magnetUrl: "magnetUrl" } } });
    expect(source.request.url).toContain("title={TITLE}");
    expect(source.request.url).toContain("author={AUTHOR}");
    expect(source.request.url).toContain("personal-token");
  });

  it("keeps provider credentials out of generated config", () => {
    const source = buildPageTurnerSource({ id: "12345678-1234-1234-1234-123456789abc", token: "integration-token", type: "directDownload", publicBaseUrl: "https://books.example" });
    expect(JSON.stringify(source)).not.toContain("prowlarr-secret");
    expect(JSON.stringify(source)).not.toContain("torbox-secret");
    expect(source.response.mapping).toMatchObject({ title: "title", url: "url" });
  });

  it("uses isolated random-token hashes", () => {
    expect(integrationTokenHash("alice")).not.toEqual(integrationTokenHash("bob"));
    expect(integrationTokenHash("alice")).toEqual(integrationTokenHash("alice"));
  });

  it("isolates integration acquisition jobs between users", () => {
    expect(pageTurnerCompatibilityKey("profile-contract", "alice")).not.toBe(pageTurnerCompatibilityKey("profile-contract", "bob"));
    expect(pageTurnerCompatibilityKey("profile-contract", "alice")).toBe(pageTurnerCompatibilityKey("profile-contract", "alice"));
  });
});

describe("remote output policy", () => {
  it("exposes magnets without requiring a downloader", () => {
    expect(isRemoteReleaseCompatible({ downloadProtocol: "TORRENT", downloadRef: "magnet:?xt=urn:btih:abc" }, "torrent", false)).toBe(true);
  });

  it("omits Usenet direct output when no remote downloader is configured", () => {
    expect(isRemoteReleaseCompatible({ downloadProtocol: "USENET", downloadRef: "https://indexer.example/file.nzb" }, "directDownload", false)).toBe(false);
    expect(isRemoteReleaseCompatible({ downloadProtocol: "USENET", downloadRef: "https://indexer.example/file.nzb" }, "directDownload", true)).toBe(true);
  });

  it("distinguishes expired results without treating them as available", () => {
    expect(outputIsExpired(new Date("2025-01-01T00:00:00Z"), new Date("2025-01-02T00:00:00Z"))).toBe(true);
    expect(outputIsExpired(new Date("2025-01-03T00:00:00Z"), new Date("2025-01-02T00:00:00Z"))).toBe(false);
  });
});
