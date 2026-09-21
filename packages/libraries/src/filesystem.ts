import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BookEdition, ConnectionTestResult, LibraryProvider } from "@aiobooks/core";

export interface FilesystemLibraryOptions {
  rootPath: string;
}

function safeSegment(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.replace(/^\.+$/, "_").slice(0, 160) || "Unknown";
}

function editionFolder(edition: BookEdition): string[] {
  const author = edition.authors[0]?.name ?? "Unknown Author";
  return [safeSegment(author), safeSegment(edition.title)];
}

export class FilesystemLibraryProvider implements LibraryProvider {
  readonly id = "filesystem";
  constructor(private readonly options: FilesystemLibraryOptions) {}

  async import(input: { edition: BookEdition; files: Array<{ path: string; sizeBytes?: number }>; idempotencyKey?: string }, signal?: AbortSignal): Promise<{ itemId?: string }> {
    if (input.files.length === 0) throw new Error("No files were provided for import");
    if (signal?.aborted) throw signal.reason;
    const root = path.resolve(this.options.rootPath);
    const destination = path.join(root, ...editionFolder(input.edition));
    const relative = path.relative(root, destination);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe library destination");
    const staging = `${destination}.aiobooks-${crypto.randomUUID()}.partial`;
    try {
      const marker = JSON.parse(await readFile(path.join(destination, ".aiobooks-import.json"), "utf8")) as { idempotencyKey?: string };
      if (input.idempotencyKey && marker.idempotencyKey === input.idempotencyKey) return { itemId: relative };
      throw new Error(`Library item already exists: ${destination}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(staging, { recursive: true });
    try {
      const used = new Set<string>();
      for (const file of input.files) {
        if (signal?.aborted) throw signal.reason;
        const source = path.resolve(file.path);
        const sourceInfo = await stat(source);
        if (!sourceInfo.isFile()) throw new Error(`Import source is not a regular file: ${source}`);
        let name = safeSegment(path.basename(source));
        let suffix = 2;
        while (used.has(name)) {
          const extension = path.extname(name);
          name = `${path.basename(name, extension)} (${suffix++})${extension}`;
        }
        used.add(name);
        await copyFile(source, path.join(staging, name));
      }
      await writeFile(path.join(staging, ".aiobooks-import.json"), JSON.stringify({ idempotencyKey: input.idempotencyKey ?? null }), { encoding: "utf8", mode: 0o600 });
      await mkdir(path.dirname(destination), { recursive: true });
      try { await stat(destination); throw new Error(`Library item already exists: ${destination}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(staging, destination);
      return { itemId: relative };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async test(_signal: AbortSignal): Promise<ConnectionTestResult> {
    try {
      const root = path.resolve(this.options.rootPath);
      const info = await stat(root);
      return info.isDirectory()
        ? { ok: true, code: "CONNECTED", message: "Library directory is available" }
        : { ok: false, code: "MISCONFIGURED", message: "Library root is not a directory" };
    } catch {
      return { ok: false, code: "MISCONFIGURED", message: "Library root is not accessible" };
    }
  }
}

export { safeSegment };
