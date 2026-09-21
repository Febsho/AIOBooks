import type { ConnectionTestResult, DownloadClient, DownloadJobStatus, EnqueueDownloadInput } from "@aiobooks/core";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { z } from "zod";

const envelopeSchema = z.object({
  success: z.boolean().optional(),
  detail: z.string().optional(),
  error: z.unknown().optional(),
  data: z.unknown().optional(),
});

const createSchema = z.object({
  torrentId: z.union([z.number(), z.string()]).optional(),
  usenetdownloadId: z.union([z.number(), z.string()]).optional(),
  queuedId: z.union([z.number(), z.string()]).optional(),
});

const fileSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().optional(),
  shortName: z.string().optional(),
  size: z.number().optional(),
});

const itemSchema = z.object({
  id: z.union([z.number(), z.string()]),
  active: z.boolean().optional(),
  downloadFinished: z.boolean().optional(),
  downloadPresent: z.boolean().optional(),
  downloadState: z.string().optional(),
  progress: z.number().optional(),
  files: z.array(fileSchema).optional(),
});

export interface TorBoxOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  validateDownloadUrl?: (url: string) => Promise<void>;
}

type TorBoxKind = "torrent" | "usenet";

function parseExternalId(value: string): { kind: TorBoxKind; id: string } {
  const match = /^(torrent|usenet):(.+)$/.exec(value);
  if (!match) throw new Error("Invalid TorBox external job id");
  return { kind: match[1] as TorBoxKind, id: match[2]! };
}

function failed(message: string): DownloadJobStatus {
  return { externalId: "unassigned", state: "FAILED", error: message };
}

export class TorBoxDownloadClient implements DownloadClient {
  readonly id = "torbox";
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly options: TorBoxOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.torbox.app/v1").replace(/\/+$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<z.infer<typeof envelopeSchema>> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      ...(signal ? { signal } : {}),
      redirect: "error",
      headers: { authorization: `Bearer ${this.options.apiKey}`, ...init.headers },
    });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new Error(`TorBox returned a non-JSON response (${response.status})`); }
    const parsed = envelopeSchema.safeParse(body);
    if (!parsed.success) throw new Error("TorBox returned an incompatible response");
    if (!response.ok || parsed.data.success === false) throw new Error(parsed.data.detail ?? `TorBox request failed (${response.status})`);
    return parsed.data;
  }

  async enqueue(input: EnqueueDownloadInput, signal?: AbortSignal): Promise<DownloadJobStatus> {
    const form = new FormData();
    let kind: TorBoxKind;
    let endpoint: string;
    if (input.release.downloadProtocol === "USENET") {
      kind = "usenet";
      endpoint = "/api/usenet/createusenetdownload";
      form.set("link", input.release.downloadRef);
    } else {
      kind = "torrent";
      endpoint = "/api/torrents/createtorrent";
      if (!input.release.downloadRef.startsWith("magnet:?")) {
        return failed("TorBox torrent acquisition currently requires a magnet reference");
      }
      form.set("magnet", input.release.downloadRef);
    }
    const envelope = await this.request(endpoint, { method: "POST", body: form, headers: { "x-idempotency-key": input.idempotencyKey } }, signal);
    const created = createSchema.safeParse(envelope.data);
    if (!created.success) return failed("TorBox did not return a download identifier");
    const value = kind === "torrent" ? created.data.torrentId : created.data.usenetdownloadId;
    if (value === undefined && created.data.queuedId !== undefined) {
      return failed("TorBox accepted the item into its account queue but did not return an active download identifier");
    }
    if (value === undefined) return failed("TorBox did not return a download identifier");
    return { externalId: `${kind}:${value}`, state: "QUEUED", progress: 0 };
  }

  async status(externalId: string, signal?: AbortSignal): Promise<DownloadJobStatus> {
    const { kind, id } = parseExternalId(externalId);
    const path = kind === "torrent" ? "/api/torrents/mylist" : "/api/usenet/mylist";
    const envelope = await this.request(`${path}?id=${encodeURIComponent(id)}`, { method: "GET" }, signal);
    const candidate = Array.isArray(envelope.data) ? envelope.data[0] : envelope.data;
    const parsed = itemSchema.safeParse(candidate);
    if (!parsed.success) return { externalId, state: "FAILED", error: "TorBox download was not found" };
    const item = parsed.data;
    const normalizedProgress = item.progress === undefined ? undefined : Math.max(0, Math.min(100, item.progress <= 1 ? item.progress * 100 : item.progress));
    if (item.downloadFinished && item.downloadPresent !== false) {
      return {
        externalId,
        state: "COMPLETED",
        ...(normalizedProgress === undefined ? {} : { progress: normalizedProgress }),
        outputFiles: (item.files ?? []).map((file) => ({ path: `torbox://${kind}/${id}/${file.id}/${encodeURIComponent(file.shortName ?? file.name ?? String(file.id))}`, ...(file.size === undefined ? {} : { sizeBytes: file.size }) })),
      };
    }
    const state = (item.downloadState ?? "").toLocaleLowerCase("en");
    if (["error", "failed", "dead"].some((token) => state.includes(token))) return { externalId, state: "FAILED", ...(normalizedProgress === undefined ? {} : { progress: normalizedProgress }), error: item.downloadState ?? "TorBox download failed" };
    return { externalId, state: item.active ? "DOWNLOADING" : "QUEUED", ...(normalizedProgress === undefined ? {} : { progress: normalizedProgress }) };
  }

  async materialize(externalId: string, files: NonNullable<DownloadJobStatus["outputFiles"]>, destinationDirectory: string, signal?: AbortSignal): Promise<Array<{ path: string; sizeBytes?: number }>> {
    const external = parseExternalId(externalId);
    await mkdir(destinationDirectory, { recursive: true });
    const materialized: Array<{ path: string; sizeBytes?: number }> = [];
    try {
      for (const [position, file] of files.entries()) {
        if (signal?.aborted) throw signal.reason;
        const parsed = /^torbox:\/\/(torrent|usenet)\/([^/]+)\/([^/]+)\/(.+)$/.exec(file.path);
        if (!parsed || parsed[1] !== external.kind || parsed[2] !== external.id) throw new Error("Invalid TorBox output file reference");
        const fileId = parsed[3]!;
        const rawName = decodeURIComponent(parsed[4]!);
        const safeName = rawName.normalize("NFKC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || `file-${position + 1}`;
        const query = new URLSearchParams({ token: this.options.apiKey, file_id: fileId });
        query.set(external.kind === "torrent" ? "torrent_id" : "usenet_id", external.id);
        const envelope = await this.request(`/api/${external.kind === "torrent" ? "torrents" : "usenet"}/requestdl?${query}`, { method: "GET" }, signal);
        if (typeof envelope.data !== "string") throw new Error("TorBox did not return a download URL");
        const downloadUrl = new URL(envelope.data);
        if (downloadUrl.protocol !== "https:" && downloadUrl.protocol !== "http:") throw new Error("TorBox returned an unsafe download URL");
        await this.options.validateDownloadUrl?.(downloadUrl.toString());
        const destination = path.join(destinationDirectory, `${String(position + 1).padStart(3, "0")}-${safeName}`);
        const partial = `${destination}.partial`;
        const response = await this.fetcher(downloadUrl, { ...(signal ? { signal } : {}), redirect: "error" });
        if (!response.ok || !response.body) throw new Error(`TorBox file download failed (${response.status})`);
        const declared = Number(response.headers.get("content-length"));
        if (file.sizeBytes !== undefined && Number.isFinite(declared) && declared !== file.sizeBytes) throw new Error("TorBox file size does not match the completed manifest");
        try {
          await response.body.pipeTo(Writable.toWeb(createWriteStream(partial)), ...(signal ? [{ signal }] : []));
          await rename(partial, destination);
        } catch (error) {
          await rm(partial, { force: true });
          throw error;
        }
        materialized.push({ path: destination, ...(file.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes }) });
      }
      return materialized;
    } catch (error) {
      await Promise.all(materialized.map((file) => rm(file.path, { force: true })));
      throw error;
    }
  }

  async test(signal: AbortSignal): Promise<ConnectionTestResult> {
    try {
      await this.request("/api/user/me", { method: "GET" }, signal);
      return { ok: true, code: "CONNECTED", message: "Connected to TorBox" };
    } catch (error) {
      if (signal.aborted) return { ok: false, code: "TIMEOUT", message: "TorBox connection timed out" };
      const message = error instanceof Error ? error.message : "TorBox connection failed";
      return { ok: false, code: message.includes("401") || message.toLocaleLowerCase("en").includes("auth") ? "AUTHENTICATION_FAILED" : "UNREACHABLE", message };
    }
  }
}
