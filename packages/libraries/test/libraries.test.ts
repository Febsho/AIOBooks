import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookEdition } from "@aiobooks/core";
import { AudiobookshelfLibraryProvider, FilesystemLibraryProvider, safeSegment } from "../src/index.js";

const edition: BookEdition = { id: "e", workId: "w", title: "A / Book", authors: [{ name: "An: Author" }], narrators: [], languages: ["en"], mediaTypes: ["AUDIOBOOK"], identifiers: [] };
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });

describe("library adapters", () => {
  it("atomically organizes files with traversal-safe names", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "aiobooks-library-")); cleanup.push(temp);
    const source = path.join(temp, "source.m4b"); const root = path.join(temp, "library");
    await writeFile(source, "audio"); await (await import("node:fs/promises")).mkdir(root);
    const provider = new FilesystemLibraryProvider({ rootPath: root });
    const imported = await provider.import({ edition, files: [{ path: source }], idempotencyKey: "acquisition-1" });
    expect(imported.itemId).toBe(path.join("An Author", "A Book"));
    await expect(readFile(path.join(root, "An Author", "A Book", "source.m4b"), "utf8")).resolves.toBe("audio");
    await expect(provider.import({ edition, files: [{ path: source }], idempotencyKey: "acquisition-1" })).resolves.toEqual(imported);
    await expect(provider.import({ edition, files: [{ path: source }], idempotencyKey: "another-acquisition" })).rejects.toThrow("already exists");
    expect(safeSegment("../../escape")).not.toContain("/");
  });

  it("scans Audiobookshelf only after placing files", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "aiobooks-abs-")); cleanup.push(temp);
    const source = path.join(temp, "source.m4b"); const root = path.join(temp, "library");
    await writeFile(source, "audio"); await (await import("node:fs/promises")).mkdir(root);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const provider = new AudiobookshelfLibraryProvider({ baseUrl: "https://abs.example", apiToken: "secret", libraryId: "lib_1", rootPath: root, fetch: fetcher });
    await provider.import({ edition, files: [{ path: source }] });
    expect(fetcher).toHaveBeenCalledWith("https://abs.example/api/libraries/lib_1/scan", expect.objectContaining({ method: "POST", redirect: "error", headers: { authorization: "Bearer secret" } }));
  });
});
