import { describe, expect, it } from "vitest";

import { isBettingReadyMarkerCurrent } from "../lib/betting-rumble-candidates";

describe("betting rumble candidates", () => {
  it("accepts a marker through the configured post-deadline grace window", () => {
    const nowMs = Date.parse("2026-03-11T18:10:00.000Z");
    const marker = {
      armedAtIso: "2026-03-11T18:00:00.000Z",
      bettingDeadlineIso: "2026-03-11T18:05:00.000Z",
    };

    expect(isBettingReadyMarkerCurrent(marker, nowMs)).toBe(true);
  });

  it("rejects a marker once it is well past deadline plus grace", () => {
    const nowMs = Date.parse("2026-03-11T18:20:01.000Z");
    const marker = {
      armedAtIso: "2026-03-11T18:00:00.000Z",
      bettingDeadlineIso: "2026-03-11T18:05:00.000Z",
    };

    expect(isBettingReadyMarkerCurrent(marker, nowMs)).toBe(false);
  });

  it("rejects impossible marker timestamps", () => {
    const nowMs = Date.parse("2026-03-11T18:01:00.000Z");
    const marker = {
      armedAtIso: "2026-03-11T18:05:00.000Z",
      bettingDeadlineIso: "2026-03-11T18:04:00.000Z",
    };

    expect(isBettingReadyMarkerCurrent(marker, nowMs)).toBe(false);
  });
});
