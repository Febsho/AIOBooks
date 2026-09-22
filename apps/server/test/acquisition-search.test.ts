import { describe, expect, it } from "vitest";
import { wantedRetryDelayMs } from "../src/acquisition-search.js";

describe("WANTED retry scheduling", () => {
  it("uses bounded exponential backoff with jitter", () => {
    expect(wantedRetryDelayMs(1, () => 0)).toBe(Math.round(6 * 3_600_000 * 0.8));
    expect(wantedRetryDelayMs(2, () => 0.5)).toBe(12 * 3_600_000);
    expect(wantedRetryDelayMs(99, () => 1)).toBe(Math.round(7 * 24 * 3_600_000 * 1.2));
  });
});
