import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NormalizedRelease } from "@aiobooks/core";
import { TorBoxDownloadClient } from "../src/torbox.js";

const release: NormalizedRelease = {
  id: "r1", providerId: "p1", providerReleaseId: "x", rawTitle: "Book", authors: [], narrators: [], mediaType: "AUDIOBOOK", format: "M4B", languages: ["en"], downloadProtocol: "USENET", downloadRef: "https://indexer.example/download/1", identifiers: [],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("TorBoxDownloadClient", () => {
  it("creates a Usenet download without leaking the token into the URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ success: true, data: { usenetdownloadId: "42" } }));
    const client = new TorBoxDownloadClient({ apiKey: "secret", fetch: fetcher });
    await expect(client.enqueue({ release, idempotencyKey: "once" })).resolves.toEqual({ externalId: "usenet:42", state: "QUEUED", progress: 0 });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.torbox.app/v1/api/usenet/createusenetdownload");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("secret");
  });

  it("uses downloadFinished rather than the display state for completion", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ success: true, data: [{ id: 42, active: false, downloadFinished: true, downloadPresent: true, downloadState: "completed", progress: 1, files: [{ id: 7, shortName: "book.m4b", size: 12 }] }] }));
    const client = new TorBoxDownloadClient({ apiKey: "secret", fetch: fetcher });
    await expect(client.status("usenet:42")).resolves.toEqual({ externalId: "usenet:42", state: "COMPLETED", progress: 100, outputFiles: [{ path: "torbox://usenet/42/7/book.m4b", sizeBytes: 12 }] });
  });

  it("does not submit HTTP torrent references as magnets", async () => {
    const client = new TorBoxDownloadClient({ apiKey: "secret", fetch: vi.fn<typeof fetch>() });
    await expect(client.enqueue({ release: { ...release, downloadProtocol: "TORRENT" }, idempotencyKey: "once" })).resolves.toMatchObject({ state: "FAILED" });
  });

  it("does not mistake an account-queue id for an active download id", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ success: true, data: { queuedId: 9 } }));
    const client = new TorBoxDownloadClient({ apiKey: "secret", fetch: fetcher });
    await expect(client.enqueue({ release, idempotencyKey: "once" })).resolves.toMatchObject({ state: "FAILED", error: expect.stringContaining("account queue") });
  });

  it("requests short-lived file links and atomically materializes outputs", async () => {
    const destination = await mkdtemp(path.join(tmpdir(), "aiobooks-torbox-"));
    const validate = vi.fn(async () => undefined);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ success: true, data: "https://cdn.example/book.m4b" }))
      .mockResolvedValueOnce(new Response("audio", { status: 200, headers: { "content-length": "5" } }));
    const client = new TorBoxDownloadClient({ apiKey: "secret", fetch: fetcher, validateDownloadUrl: validate });
    try {
      const files = await client.materialize("usenet:42", [{ path: "torbox://usenet/42/7/book.m4b", sizeBytes: 5 }], destination);
      expect(await readFile(files[0]!.path, "utf8")).toBe("audio");
      expect(validate).toHaveBeenCalledWith("https://cdn.example/book.m4b");
      expect(String(fetcher.mock.calls[0]?.[0])).toContain("token=secret");
      expect(String(fetcher.mock.calls[1]?.[0])).not.toContain("secret");
    } finally { await rm(destination, { recursive: true, force: true }); }
  });
});
