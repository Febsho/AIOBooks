export const REQUEST_STATES = [
  "PENDING", "SEARCHING", "MATCHED", "QUEUED", "DOWNLOADING", "PROCESSING",
  "IMPORTING", "AVAILABLE", "WANTED", "FAILED", "MANUAL_REVIEW",
] as const;

export type RequestState = (typeof REQUEST_STATES)[number];

const transitions: Record<RequestState, readonly RequestState[]> = {
  PENDING: ["SEARCHING", "FAILED"],
  SEARCHING: ["MATCHED", "WANTED", "MANUAL_REVIEW", "FAILED"],
  MATCHED: ["QUEUED", "MANUAL_REVIEW", "FAILED"],
  QUEUED: ["DOWNLOADING", "FAILED"],
  DOWNLOADING: ["PROCESSING", "FAILED"],
  PROCESSING: ["IMPORTING", "FAILED"],
  IMPORTING: ["AVAILABLE", "FAILED"],
  AVAILABLE: [],
  WANTED: ["SEARCHING", "FAILED"],
  FAILED: ["SEARCHING"],
  MANUAL_REVIEW: ["MATCHED", "WANTED", "FAILED"],
};

export function canTransition(from: RequestState, to: RequestState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: RequestState, to: RequestState): void {
  if (!canTransition(from, to)) throw new Error(`Invalid request transition: ${from} -> ${to}`);
}
