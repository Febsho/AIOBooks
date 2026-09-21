export type IdentifierType =
  | "ISBN_10"
  | "ISBN_13"
  | "ASIN"
  | "OPEN_LIBRARY"
  | "GOOGLE_BOOKS"
  | "AUDIBLE";

export interface ExternalIdentifier {
  type: IdentifierType;
  value: string;
}

export interface Contributor {
  id?: string;
  name: string;
}

export interface BookWork {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  authors: Contributor[];
  firstPublishedYear?: number;
  coverUrl?: string;
  series?: { name: string; position?: number };
  genres: string[];
  identifiers: ExternalIdentifier[];
  editions: BookEdition[];
}

export interface BookEdition {
  id: string;
  workId: string;
  title: string;
  subtitle?: string;
  authors: Contributor[];
  narrators: Contributor[];
  publisher?: string;
  publishedAt?: string;
  languages: string[];
  mediaTypes: Exclude<MediaType, "UNKNOWN">[];
  durationSeconds?: number;
  identifiers: ExternalIdentifier[];
}

export type MediaType = "AUDIOBOOK" | "EBOOK" | "UNKNOWN";
export type ReleaseFormat = "M4B" | "M4A" | "MP3" | "FLAC" | "EPUB" | "AZW3" | "MOBI" | "PDF" | "UNKNOWN";
export type DownloadProtocol = "USENET" | "TORRENT";

export interface NormalizedRelease {
  id: string;
  providerId: string;
  providerReleaseId: string;
  rawTitle: string;
  parsedTitle?: string;
  authors: string[];
  narrators: string[];
  mediaType: MediaType;
  format: ReleaseFormat;
  languages: string[];
  sizeBytes?: number;
  files?: number;
  publishedAt?: string;
  grabs?: number;
  seeders?: number;
  leechers?: number;
  downloadProtocol: DownloadProtocol;
  downloadRef: string;
  infoUrl?: string;
  identifiers: ExternalIdentifier[];
  cached?: boolean;
  sourcePriority?: number;
}

export interface MatchTarget {
  work: BookWork;
  edition?: BookEdition;
  mediaType: Exclude<MediaType, "UNKNOWN">;
}

export interface MatchResult {
  confidence: number;
  accepted: boolean;
  matchedIdentifiers: ExternalIdentifier[];
  reasons: string[];
  rejections: string[];
}

export interface AcquisitionProfile {
  id: string;
  name: string;
  mediaType: Exclude<MediaType, "UNKNOWN">;
  languages: string[];
  formatOrder: ReleaseFormat[];
  protocolOrder: DownloadProtocol[];
  minimumConfidence: number;
  minimumSizeBytes?: number;
  maximumSizeBytes?: number;
  maximumAgeDays?: number;
  requireCached?: boolean;
  preferredNarrators: string[];
}

export interface RankedRelease {
  release: NormalizedRelease;
  match: MatchResult;
  score: number;
  scoreReasons: string[];
}
