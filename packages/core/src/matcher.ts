import type { ExternalIdentifier, MatchResult, MatchTarget, NormalizedRelease } from "./domain.js";
import type { ReleaseMatcher } from "./interfaces.js";
import { canonicalIdentifier, namesMatch, normalizeText, tokenSimilarity } from "./text.js";

function matchingIdentifiers(target: MatchTarget, release: NormalizedRelease): ExternalIdentifier[] {
  const targetIds = [...target.work.identifiers, ...(target.edition?.identifiers ?? [])];
  return release.identifiers.filter((candidate) =>
    targetIds.some((expected) => expected.type === candidate.type && canonicalIdentifier(expected.value) === canonicalIdentifier(candidate.value)),
  );
}

export class BookReleaseMatcher implements ReleaseMatcher {
  match(target: MatchTarget, release: NormalizedRelease): MatchResult {
    const reasons: string[] = [];
    const rejections: string[] = [];
    const ids = matchingIdentifiers(target, release);
    const title = target.edition?.title ?? target.work.title;
    const releaseTitle = release.parsedTitle ?? release.rawTitle;
    const normalizedTitle = normalizeText(title);
    const normalizedReleaseTitle = normalizeText(releaseTitle);
    const similarity = tokenSimilarity(title, releaseTitle);
    const exactTitle = normalizedTitle === normalizedReleaseTitle
      || ` ${normalizedReleaseTitle} `.includes(` ${normalizedTitle} `)
      || similarity === 1;
    const expectedAuthors = target.edition?.authors.length ? target.edition.authors : target.work.authors;
    const authorMatched = release.authors.length > 0 && expectedAuthors.some((author) => release.authors.some((candidate) => namesMatch(author.name, candidate)));

    let confidence = 0;
    if (ids.length > 0) {
      confidence += 70;
      reasons.push(`exact ${ids.map((id) => id.type).join("/")} match`);
    }
    if (exactTitle) {
      confidence += 45;
      reasons.push("exact normalized title");
    } else if (similarity >= 0.75) {
      confidence += 30;
      reasons.push(`strong title similarity (${Math.round(similarity * 100)}%)`);
    } else if (similarity >= 0.5) {
      confidence += 15;
      reasons.push(`partial title similarity (${Math.round(similarity * 100)}%)`);
    } else {
      rejections.push(`title mismatch (${Math.round(similarity * 100)}% token similarity)`);
    }

    if (authorMatched) {
      confidence += 30;
      reasons.push("author match");
    } else if (release.authors.length > 0) {
      confidence -= 35;
      rejections.push("author mismatch");
    } else {
      reasons.push("author not present in release metadata");
    }

    if (release.mediaType === target.mediaType) {
      confidence += 15;
      reasons.push(`${target.mediaType.toLocaleLowerCase()} detected`);
    } else if (release.mediaType !== "UNKNOWN") {
      confidence = 0;
      rejections.push(`wrong media type: ${release.mediaType}`);
    }

    const targetIds = [...target.work.identifiers, ...(target.edition?.identifiers ?? [])];
    const conflictingId = release.identifiers.some((candidate) =>
      targetIds.some((expected) => expected.type === candidate.type && canonicalIdentifier(expected.value) !== canonicalIdentifier(candidate.value)),
    );
    if (conflictingId && ids.length === 0) {
      confidence = 0;
      rejections.push("conflicting edition identifier");
    }

    confidence = Math.max(0, Math.min(100, confidence));
    const accepted = confidence >= 60 && !rejections.some((reason) => reason.startsWith("wrong media") || reason.startsWith("conflicting"));
    return { confidence, accepted, matchedIdentifiers: ids, reasons, rejections };
  }
}
