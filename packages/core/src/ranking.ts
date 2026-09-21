import type { AcquisitionProfile, MatchTarget, NormalizedRelease, RankedRelease } from "./domain.js";
import type { RankingEngine } from "./interfaces.js";
import { BookReleaseMatcher } from "./matcher.js";
import { namesMatch } from "./text.js";

export function passesProfile(release: NormalizedRelease, confidence: number, profile: AcquisitionProfile): boolean {
  if (release.mediaType !== profile.mediaType) return false;
  if (confidence < profile.minimumConfidence) return false;
  if (profile.languages.length && release.languages.length && !release.languages.some((language) => profile.languages.includes(language))) return false;
  if (profile.formatOrder.length && !profile.formatOrder.includes(release.format)) return false;
  if (profile.minimumSizeBytes !== undefined && (release.sizeBytes ?? 0) < profile.minimumSizeBytes) return false;
  if (profile.maximumSizeBytes !== undefined && (release.sizeBytes ?? Number.POSITIVE_INFINITY) > profile.maximumSizeBytes) return false;
  if (profile.maximumAgeDays !== undefined && release.publishedAt) {
    const published = Date.parse(release.publishedAt);
    if (Number.isFinite(published) && Date.now() - published > profile.maximumAgeDays * 86_400_000) return false;
  }
  if (profile.requireCached && release.cached !== true) return false;
  return true;
}

export class ProfileRankingEngine implements RankingEngine {
  constructor(private readonly matcher = new BookReleaseMatcher()) {}

  rank(target: MatchTarget, releases: NormalizedRelease[], profile: AcquisitionProfile): RankedRelease[] {
    return releases
      .map((release): RankedRelease | null => {
        const match = this.matcher.match(target, release);
        if (!match.accepted || !passesProfile(release, match.confidence, profile)) return null;
        let score = match.confidence * 100;
        const scoreReasons = [`match confidence +${match.confidence * 100}`];
        const formatIndex = profile.formatOrder.indexOf(release.format);
        if (formatIndex >= 0) {
          const points = (profile.formatOrder.length - formatIndex) * 250;
          score += points;
          scoreReasons.push(`${release.format} preference +${points}`);
        }
        const protocolIndex = profile.protocolOrder.indexOf(release.downloadProtocol);
        if (protocolIndex >= 0) {
          const points = (profile.protocolOrder.length - protocolIndex) * 100;
          score += points;
          scoreReasons.push(`${release.downloadProtocol} preference +${points}`);
        }
        if (release.cached) {
          score += 200;
          scoreReasons.push("cached +200");
        }
        if (profile.preferredNarrators.some((preferred) => release.narrators.some((narrator) => namesMatch(preferred, narrator)))) {
          score += 150;
          scoreReasons.push("preferred narrator +150");
        }
        score += Math.max(0, 100 - (release.sourcePriority ?? 100));
        return { release, match, score, scoreReasons };
      })
      .filter((item): item is RankedRelease => item !== null)
      .sort((a, b) => b.score - a.score || a.release.id.localeCompare(b.release.id));
  }
}

export function deduplicateReleases(releases: NormalizedRelease[]): NormalizedRelease[] {
  const seen = new Set<string>();
  return releases.filter((release) => {
    const key = [release.downloadProtocol, release.providerReleaseId, release.rawTitle.toLocaleLowerCase(), release.sizeBytes ?? "unknown"].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
