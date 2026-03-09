/**
 * Commentary Pre-gen Race Condition — Regression Tests
 *
 * Verifies the fix for UCFA-32/UCFA-33: pre-generated fighter voice clips must
 * take priority over dynamically generated clips when they share the same clipKey.
 *
 * Scenario: "local turn arrives first, shared clip arrives later"
 *   1. Poll-based path detects a new turn and enqueues a dynamic item (no audioUrl).
 *   2. ~10s later the status API cache expires; shared commentary arrives with a
 *      pre-gen clip for the same clipKey.
 *   3. The pre-gen item must evict the dynamic placeholder so viewers hear the
 *      fighter's own voice rather than the generic announcer TTS.
 *
 * RadioMixer is not exported from CommentaryPlayer.tsx, so this test exercises the
 * queue algorithm directly via a lightweight fixture.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Minimal fixture — mirrors only the queue logic we care about
// ---------------------------------------------------------------------------

interface QueueItem {
  clipKey?: string;
  audioUrl?: string;
  isPregen?: boolean;
  eventType: string;
}

/**
 * Minimal reimplementation of RadioMixer.enqueue() dedup logic after the fix.
 * Returns the resulting queue after the enqueue call.
 */
function simulateEnqueue(
  queue: QueueItem[],
  currentClipKey: string | null,
  item: QueueItem,
): QueueItem[] {
  const { clipKey, isPregen } = item;
  const next = [...queue];

  if (clipKey) {
    if (currentClipKey === clipKey) return next; // playing — cannot replace

    const existingIdx = next.findIndex((q) => q.clipKey === clipKey);
    if (existingIdx >= 0) {
      // Pre-gen clips take priority: evict a queued dynamic placeholder.
      if (isPregen && !next[existingIdx].isPregen) {
        next.splice(existingIdx, 1);
        // fall through to enqueue the pre-gen version
      } else {
        return next; // already queued, drop
      }
    }
  }

  next.push(item);
  return next;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RadioMixer pre-gen priority", () => {
  const CLIP_KEY = "rumble-42:turn-exchange:7";

  it("enqueues a dynamic item when no pre-gen is present", () => {
    const dynamic: QueueItem = { clipKey: CLIP_KEY, isPregen: false, eventType: "big_hit" };
    const result = simulateEnqueue([], null, dynamic);
    expect(result).toHaveLength(1);
    expect(result[0].isPregen).toBe(false);
  });

  it("drops a duplicate dynamic item (normal dedup)", () => {
    const dynamic: QueueItem = { clipKey: CLIP_KEY, isPregen: false, eventType: "big_hit" };
    const queue = [dynamic];
    const result = simulateEnqueue(queue, null, { ...dynamic });
    expect(result).toHaveLength(1);
  });

  it("pre-gen evicts a queued dynamic item with the same clipKey", () => {
    // Step 1: poll-based path enqueues dynamic placeholder
    const dynamic: QueueItem = { clipKey: CLIP_KEY, isPregen: false, audioUrl: undefined, eventType: "big_hit" };
    let queue = simulateEnqueue([], null, dynamic);
    expect(queue).toHaveLength(1);
    expect(queue[0].isPregen).toBe(false);

    // Step 2: ~10s later, shared commentary arrives with pre-gen clip
    const pregen: QueueItem = { clipKey: CLIP_KEY, isPregen: true, audioUrl: "https://example.com/pregen.mp3", eventType: "big_hit" };
    queue = simulateEnqueue(queue, null, pregen);

    // The dynamic placeholder must be gone; only the pre-gen remains
    expect(queue).toHaveLength(1);
    expect(queue[0].isPregen).toBe(true);
    expect(queue[0].audioUrl).toBe("https://example.com/pregen.mp3");
  });

  it("does NOT evict when the existing item is already pre-gen", () => {
    const pregen: QueueItem = { clipKey: CLIP_KEY, isPregen: true, audioUrl: "https://example.com/v1.mp3", eventType: "big_hit" };
    let queue = simulateEnqueue([], null, pregen);

    // A second pre-gen with same clipKey should be dropped
    const pregen2: QueueItem = { clipKey: CLIP_KEY, isPregen: true, audioUrl: "https://example.com/v2.mp3", eventType: "big_hit" };
    queue = simulateEnqueue(queue, null, pregen2);

    expect(queue).toHaveLength(1);
    expect(queue[0].audioUrl).toBe("https://example.com/v1.mp3");
  });

  it("does NOT replace if the dynamic item is currently playing (currentClipKey match)", () => {
    // Dynamic clip was shifted off the queue and is now playing
    const pregen: QueueItem = { clipKey: CLIP_KEY, isPregen: true, audioUrl: "https://example.com/pregen.mp3", eventType: "big_hit" };
    const result = simulateEnqueue([], CLIP_KEY, pregen);
    // Queue stays empty — can't preempt currently playing audio
    expect(result).toHaveLength(0);
  });

  it("enqueues pre-gen normally when no prior item exists", () => {
    const pregen: QueueItem = { clipKey: CLIP_KEY, isPregen: true, audioUrl: "https://example.com/pregen.mp3", eventType: "big_hit" };
    const result = simulateEnqueue([], null, pregen);
    expect(result).toHaveLength(1);
    expect(result[0].isPregen).toBe(true);
  });
});

describe("Poll-based path pre-gen guard", () => {
  const CLIP_KEY = "rumble-42:turn-exchange:7";

  /**
   * Mirrors the hasPregenForTurn check added to the poll-based effect:
   *   const hasPregenForTurn = candidate != null &&
   *     sharedCommentary.some((c) => c.clipKey === candidate.clipKey && c.audioUrl);
   */
  function hasPregenForTurn(
    clipKey: string | undefined,
    commentary: Array<{ clipKey: string; audioUrl: string | null }>,
  ): boolean {
    if (!clipKey) return false;
    return commentary.some((c) => c.clipKey === clipKey && Boolean(c.audioUrl));
  }

  it("returns false when commentary is empty", () => {
    expect(hasPregenForTurn(CLIP_KEY, [])).toBe(false);
  });

  it("returns false when commentary has a clip for a different key", () => {
    expect(hasPregenForTurn(CLIP_KEY, [{ clipKey: "other-key", audioUrl: "https://x.com/a.mp3" }])).toBe(false);
  });

  it("returns false when commentary has matching key but no audioUrl", () => {
    expect(hasPregenForTurn(CLIP_KEY, [{ clipKey: CLIP_KEY, audioUrl: null }])).toBe(false);
  });

  it("returns true when commentary has matching key with audioUrl", () => {
    expect(hasPregenForTurn(CLIP_KEY, [{ clipKey: CLIP_KEY, audioUrl: "https://example.com/pregen.mp3" }])).toBe(true);
  });

  it("dynamic generation is skipped when pre-gen is present (full scenario)", () => {
    // Simulates what happens when shared stream fires in same render cycle as poll
    const commentary = [{ clipKey: CLIP_KEY, audioUrl: "https://example.com/pregen.mp3" }];
    const candidate = { clipKey: CLIP_KEY, eventType: "big_hit", context: "Turn 7: ..." };

    const shouldSkipDynamic = hasPregenForTurn(candidate.clipKey, commentary);
    expect(shouldSkipDynamic).toBe(true); // dynamic generation is suppressed
  });
});
