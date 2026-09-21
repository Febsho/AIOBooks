import type { BookEdition, ConnectionTestResult, LibraryProvider } from "@aiobooks/core";
import { FilesystemLibraryProvider } from "./filesystem.js";

export interface AudiobookshelfOptions {
  baseUrl: string;
  apiToken: string;
  libraryId: string;
  rootPath: string;
  fetch?: typeof globalThis.fetch;
}

export class AudiobookshelfLibraryProvider implements LibraryProvider {
  readonly id = "audiobookshelf";
  private readonly filesystem: FilesystemLibraryProvider;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: AudiobookshelfOptions) {
    this.filesystem = new FilesystemLibraryProvider({ rootPath: options.rootPath });
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private request(pathname: string, method: "GET" | "POST", signal?: AbortSignal): Promise<Response> {
    return this.fetcher(`${this.baseUrl}${pathname}`, { method, ...(signal ? { signal } : {}), redirect: "error", headers: { authorization: `Bearer ${this.options.apiToken}` } });
  }

  async import(input: { edition: BookEdition; files: Array<{ path: string; sizeBytes?: number }>; idempotencyKey?: string }, signal?: AbortSignal): Promise<{ itemId?: string }> {
    const imported = await this.filesystem.import(input, signal);
    const response = await this.request(`/api/libraries/${encodeURIComponent(this.options.libraryId)}/scan`, "POST", signal);
    if (!response.ok) throw new Error(`Audiobookshelf scan failed (${response.status})`);
    return imported;
  }

  async test(signal: AbortSignal): Promise<ConnectionTestResult> {
    try {
      const response = await this.request("/api/authorize", "GET", signal);
      if (response.status === 401 || response.status === 403) return { ok: false, code: "AUTHENTICATION_FAILED", message: "Audiobookshelf rejected the API token" };
      if (!response.ok) return { ok: false, code: "INCOMPATIBLE_API", message: `Audiobookshelf returned ${response.status}` };
      const filesystem = await this.filesystem.test(signal);
      if (!filesystem.ok) return filesystem;
      return { ok: true, code: "CONNECTED", message: "Connected to Audiobookshelf and library storage" };
    } catch (error) {
      if (signal.aborted) return { ok: false, code: "TIMEOUT", message: "Audiobookshelf connection timed out" };
      return { ok: false, code: "UNREACHABLE", message: error instanceof Error ? error.message : "Audiobookshelf connection failed" };
    }
  }
}
