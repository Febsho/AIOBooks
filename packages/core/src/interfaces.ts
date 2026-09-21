import type {
  AcquisitionProfile,
  BookEdition,
  BookWork,
  MatchResult,
  MatchTarget,
  NormalizedRelease,
  RankedRelease,
} from "./domain.js";

export interface MetadataSearchQuery {
  query: string;
  language?: string;
  limit?: number;
  offset?: number;
}

export interface MetadataSearchResult {
  items: BookWork[];
  total: number;
  offset: number;
}

export interface MetadataProvider {
  readonly id: string;
  search(query: MetadataSearchQuery, signal?: AbortSignal): Promise<MetadataSearchResult>;
  getWork(id: string, signal?: AbortSignal): Promise<BookWork | null>;
}

export interface ReleaseSearchContext {
  work: BookWork;
  edition?: BookEdition;
  profile: AcquisitionProfile;
}

export interface SearchProviderResult {
  releases: NormalizedRelease[];
}

export interface ConnectionTestResult {
  ok: boolean;
  code: "CONNECTED" | "AUTHENTICATION_FAILED" | "INCOMPATIBLE_API" | "TIMEOUT" | "UNREACHABLE" | "MISCONFIGURED";
  message: string;
}

export interface SearchProvider {
  readonly id: string;
  readonly name: string;
  search(context: ReleaseSearchContext, signal: AbortSignal): Promise<SearchProviderResult>;
  test(signal: AbortSignal): Promise<ConnectionTestResult>;
}

export interface ReleaseParser<TRaw = unknown> {
  parse(raw: TRaw): NormalizedRelease;
}

export interface ReleaseMatcher {
  match(target: MatchTarget, release: NormalizedRelease): MatchResult;
}

export interface RankingEngine {
  rank(target: MatchTarget, releases: NormalizedRelease[], profile: AcquisitionProfile): RankedRelease[];
}

export interface EnqueueDownloadInput {
  release: NormalizedRelease;
  idempotencyKey: string;
}

export interface DownloadJobStatus {
  externalId: string;
  state: "QUEUED" | "DOWNLOADING" | "COMPLETED" | "FAILED";
  progress?: number;
  outputFiles?: Array<{ path: string; sizeBytes?: number }>;
  error?: string;
}

export interface DownloadClient {
  readonly id: string;
  enqueue(input: EnqueueDownloadInput, signal?: AbortSignal): Promise<DownloadJobStatus>;
  status(externalId: string, signal?: AbortSignal): Promise<DownloadJobStatus>;
  materialize?(externalId: string, files: NonNullable<DownloadJobStatus["outputFiles"]>, destinationDirectory: string, signal?: AbortSignal): Promise<Array<{ path: string; sizeBytes?: number }>>;
  test(signal: AbortSignal): Promise<ConnectionTestResult>;
}

export interface LibraryProvider {
  readonly id: string;
  import(input: { edition: BookEdition; files: Array<{ path: string; sizeBytes?: number }>; idempotencyKey?: string }, signal?: AbortSignal): Promise<{ itemId?: string }>;
  test(signal: AbortSignal): Promise<ConnectionTestResult>;
}
