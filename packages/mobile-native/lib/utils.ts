/**
 * Pure utility functions for the UCF mobile-native app.
 * Extracted from App.tsx monolith — see App.tsx header comment for details.
 *
 * Every function here is pure (no React state, no side-effects).
 */

import { PublicKey, Transaction } from "@solana/web3.js";
import { toUint8Array } from "@wallet-ui/react-native-web3js";
import { Buffer } from "buffer";

import type {
  QueueFighter,
  RumbleSlot,
  RumbleSlotFighter,
  RumbleSlotOdds,
  RumbleStatusResponse,
  RumbleTurnPairing,
} from "./types";

import {
  LIVE_API_BASE,
  LOCAL_API_BASE,
  READ_TIMEOUT_MS,
  STATUS_POLL_BACKSTOP_INTERVALS_MS,
  STATUS_POLL_ERROR_RETRY_MS,
  STATUS_POLL_INTERVALS_MS,
  STATUS_POLL_TRANSITION_LEAD_MS,
  WRITE_RETRYABLE_STATUS,
  WRITE_TIMEOUT_MS,
  SND_BLOCK,
  SND_CATCH,
  SND_DODGE,
  SND_HIT_HEAVY,
  SND_HIT_LIGHT,
  SND_HIT_SPECIAL,
} from "./constants";

// ---------------------------------------------------------------------------
// Mutable preferred-API tracker (moved here so fetchApiWithFallback works)
// ---------------------------------------------------------------------------
let preferredApiBase: string | null = null;

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------
export function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Error classifiers
// ---------------------------------------------------------------------------
export function isCancellationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cancel|declin|reject|abort|denied|dismiss/i.test(message);
}

export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|too many requests|rate limit/i.test(message);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
export function shortAddress(value: string, start = 4, end = 4): string {
  if (!value) return value;
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export function getStateColor(state: string | undefined): string {
  if (state === "combat") return "#ef4444";
  if (state === "betting") return "#f59e0b";
  if (state === "payout") return "#22c55e";
  return "#71717a";
}

export function formatMove(move: unknown): string {
  const raw = String(move ?? "").toUpperCase().trim();
  if (!raw) return "?";
  switch (raw) {
    case "HIGH_STRIKE": return "HIGH";
    case "MID_STRIKE": return "MID";
    case "LOW_STRIKE": return "LOW";
    case "SPECIAL": return "SPEC";
    case "DODGE": return "DODGE";
    case "CATCH": return "CATCH";
    default:
      if (raw.startsWith("GUARD")) return "GUARD";
      return raw.replace(/_/g, " ");
  }
}

export function getMoveColor(move: unknown): string {
  const raw = String(move ?? "").toUpperCase().trim();
  if (raw === "SPECIAL") return "#f59e0b";
  if (raw === "HIGH_STRIKE" || raw === "MID_STRIKE" || raw === "LOW_STRIKE") return "#ef4444";
  if (raw.startsWith("GUARD")) return "#3b82f6";
  if (raw === "DODGE") return "#a78bfa";
  if (raw === "CATCH") return "#f97316";
  return "#a8a29e";
}

export function formatCountdown(deadlineIso: string | null | undefined): string {
  if (!deadlineIso) return "--:--";
  const ms = new Date(deadlineIso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatAge(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 10) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

export function formatTxAge(ts: number | null): string {
  if (!ts) return "--";
  const diff = Math.floor((Date.now() - ts * 1000) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function formatPct(value: unknown): string {
  const n = safeNumber(value, 0);
  const pct = n > 1 ? n : n * 100;
  return `${Math.max(0, pct).toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Move classifiers
// ---------------------------------------------------------------------------
export function isStrikeMove(move: unknown): boolean {
  const value = String(move ?? "").toUpperCase();
  return value === "HIGH_STRIKE" || value === "MID_STRIKE" || value === "LOW_STRIKE" || value === "SPECIAL";
}

export function isGuardMove(move: unknown): boolean {
  return String(move ?? "").toUpperCase().startsWith("GUARD");
}

// ---------------------------------------------------------------------------
// Fighter helpers
// ---------------------------------------------------------------------------
export function getFighterId(fighter: RumbleSlotFighter | RumbleSlotOdds | QueueFighter | null | undefined): string {
  if (!fighter) return "";
  return String((fighter as any).id ?? (fighter as any).fighterId ?? "").trim();
}

export function getFighterName(fighter: RumbleSlotFighter | RumbleSlotOdds | QueueFighter | null | undefined): string {
  if (!fighter) return "Unknown";
  return String((fighter as any).name ?? (fighter as any).fighterName ?? getFighterId(fighter) ?? "Unknown");
}

// ---------------------------------------------------------------------------
// SFX picker
// ---------------------------------------------------------------------------
export function pickPairingSfx(pair: RumbleTurnPairing): number {
  const moveA = String(pair.moveA ?? "").toUpperCase();
  const moveB = String(pair.moveB ?? "").toUpperCase();
  const damageToA = safeNumber(pair.damageToA, 0);
  const damageToB = safeNumber(pair.damageToB, 0);
  const totalDamage = damageToA + damageToB;

  if ((moveA === "SPECIAL" && damageToB > 0) || (moveB === "SPECIAL" && damageToA > 0)) return SND_HIT_SPECIAL;
  if (moveA === "CATCH" || moveB === "CATCH") return SND_CATCH;
  if ((moveA === "DODGE" || moveB === "DODGE") && totalDamage <= 0) return SND_DODGE;

  if (((isGuardMove(moveA) && isStrikeMove(moveB)) || (isGuardMove(moveB) && isStrikeMove(moveA))) && totalDamage <= 5) {
    return SND_BLOCK;
  }
  if (isGuardMove(moveA) && isGuardMove(moveB)) return SND_BLOCK;
  if (damageToA >= 18 || damageToB >= 18) return SND_HIT_HEAVY;
  if (totalDamage > 0) return SND_HIT_LIGHT;
  return SND_HIT_LIGHT;
}

// ---------------------------------------------------------------------------
// Transaction decoding
// ---------------------------------------------------------------------------
export function decodeBase64Tx(base64: string): Transaction {
  return Transaction.from(Buffer.from(base64, "base64"));
}

// ---------------------------------------------------------------------------
// Wallet address normalization
// ---------------------------------------------------------------------------
export function normalizeWalletAddress(accountLike: unknown): string | null {
  const account = accountLike as any;
  const candidates = [account?.publicKey, account?.address, account?.addressBase64];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (typeof candidate === "string") {
      try {
        return new PublicKey(candidate).toBase58();
      } catch {
        try {
          return new PublicKey(toUint8Array(candidate)).toBase58();
        } catch {
          continue;
        }
      }
    }

    if (typeof candidate?.toBase58 === "function") {
      try {
        return candidate.toBase58();
      } catch {
        continue;
      }
    }

    if (typeof candidate?.toBytes === "function") {
      try {
        return new PublicKey(candidate.toBytes()).toBase58();
      } catch {
        continue;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rumble status polling math
// ---------------------------------------------------------------------------
export function getSuggestedStatusPollDelayMs(
  rumbleStatus: RumbleStatusResponse | null,
  statusError: string | null,
): number {
  if (statusError) return STATUS_POLL_ERROR_RETRY_MS;
  if (!rumbleStatus?.slots?.length) return STATUS_POLL_BACKSTOP_INTERVALS_MS.idle;

  const now = Date.now();
  let nextDelay = Number.POSITIVE_INFINITY;

  for (const slot of rumbleStatus.slots) {
    if (slot?.state === "combat") {
      const targetMs = slot.nextTurnAt ? Date.parse(slot.nextTurnAt) : Number.NaN;
      if (Number.isFinite(targetMs)) {
        const remainingMs = targetMs - now;
        if (remainingMs > STATUS_POLL_TRANSITION_LEAD_MS.combat) {
          nextDelay = Math.min(
            nextDelay,
            Math.max(
              STATUS_POLL_INTERVALS_MS.combat,
              Math.min(
                STATUS_POLL_BACKSTOP_INTERVALS_MS.combat,
                remainingMs - STATUS_POLL_TRANSITION_LEAD_MS.combat,
              ),
            ),
          );
        } else {
          nextDelay = Math.min(nextDelay, STATUS_POLL_INTERVALS_MS.combat);
        }
      } else {
        nextDelay = Math.min(nextDelay, STATUS_POLL_BACKSTOP_INTERVALS_MS.combat);
      }
      continue;
    }

    if (slot?.state === "betting") {
      const targetMs = slot.bettingDeadline ? Date.parse(slot.bettingDeadline) : Number.NaN;
      if (Number.isFinite(targetMs)) {
        const remainingMs = targetMs - now;
        if (remainingMs > STATUS_POLL_TRANSITION_LEAD_MS.betting) {
          nextDelay = Math.min(
            nextDelay,
            Math.max(
              STATUS_POLL_INTERVALS_MS.betting,
              Math.min(
                STATUS_POLL_BACKSTOP_INTERVALS_MS.betting,
                remainingMs - STATUS_POLL_TRANSITION_LEAD_MS.betting,
              ),
            ),
          );
        } else {
          nextDelay = Math.min(nextDelay, STATUS_POLL_INTERVALS_MS.betting);
        }
      } else {
        nextDelay = Math.min(nextDelay, STATUS_POLL_BACKSTOP_INTERVALS_MS.betting);
      }
      continue;
    }

    if (slot?.state === "payout") {
      nextDelay = Math.min(nextDelay, STATUS_POLL_BACKSTOP_INTERVALS_MS.betting);
    }
  }

  if (Number.isFinite(nextDelay)) return Math.max(1_500, Math.floor(nextDelay));
  return STATUS_POLL_BACKSTOP_INTERVALS_MS.idle;
}

// ---------------------------------------------------------------------------
// Rumble state merge helpers
// ---------------------------------------------------------------------------
export function getRumbleStateRank(state: RumbleSlot["state"] | undefined): number {
  if (state === "betting") return 1;
  if (state === "combat") return 2;
  if (state === "payout") return 3;
  return 0;
}

export function mergeRumbleStatusSnapshots(
  previous: RumbleStatusResponse | null,
  next: RumbleStatusResponse,
): RumbleStatusResponse {
  if (!previous?.slots?.length || !next.slots?.length) return next;

  const previousBySlot = new Map<number, RumbleSlot>();
  for (const slot of previous.slots) {
    const slotIndex = safeNumber(slot.slotIndex, -1);
    if (slotIndex >= 0) previousBySlot.set(slotIndex, slot);
  }

  const mergedSlots = next.slots.map((slot) => {
    const slotIndex = safeNumber(slot.slotIndex, -1);
    const previousSlot = previousBySlot.get(slotIndex);
    if (!previousSlot) return slot;

    const previousRumbleId = String(previousSlot.rumbleId ?? "").trim();
    const nextRumbleId = String(slot.rumbleId ?? "").trim();
    if (!previousRumbleId || !nextRumbleId || previousRumbleId !== nextRumbleId) {
      return slot;
    }

    const nextTurns = Array.isArray(slot.turns) ? slot.turns : [];
    const previousTurns = Array.isArray(previousSlot.turns) ? previousSlot.turns : [];
    const nextFighters = Array.isArray(slot.fighters) ? slot.fighters : [];
    const previousFighters = Array.isArray(previousSlot.fighters) ? previousSlot.fighters : [];
    const nextOdds = Array.isArray(slot.odds) ? slot.odds : [];
    const previousOdds = Array.isArray(previousSlot.odds) ? previousSlot.odds : [];
    const nextCommentary = Array.isArray(slot.commentary) ? slot.commentary : [];
    const previousCommentary = Array.isArray(previousSlot.commentary) ? previousSlot.commentary : [];
    const mergedTurns = nextTurns.length >= previousTurns.length ? slot.turns : previousSlot.turns;
    const mergedFighters = nextFighters.length >= previousFighters.length ? slot.fighters : previousSlot.fighters;
    const mergedOdds = nextOdds.length >= previousOdds.length ? slot.odds : previousSlot.odds;
    const mergedCommentary =
      nextCommentary.length >= previousCommentary.length ? slot.commentary : previousSlot.commentary;
    const mergedState =
      getRumbleStateRank(slot.state) >= getRumbleStateRank(previousSlot.state)
        ? slot.state
        : previousSlot.state;

    const mergedDeadline =
      mergedState === "betting"
        ? (() => {
            if (previousSlot.state !== "betting" || !slot.bettingDeadline) return slot.bettingDeadline;
            const previousDeadlineMs = previousSlot.bettingDeadline
              ? Date.parse(previousSlot.bettingDeadline)
              : Number.NaN;
            const nextDeadlineMs = Date.parse(slot.bettingDeadline);
            if (!Number.isFinite(nextDeadlineMs)) return previousSlot.bettingDeadline;
            if (!Number.isFinite(previousDeadlineMs) || nextDeadlineMs < previousDeadlineMs) {
              return slot.bettingDeadline;
            }
            return previousSlot.bettingDeadline;
          })()
        : slot.bettingDeadline;

    return {
      ...slot,
      state: mergedState,
      turns: mergedTurns,
      fighters: mergedFighters,
      odds: mergedOdds,
      commentary: mergedCommentary,
      fighterNames:
        slot.fighterNames && Object.keys(slot.fighterNames).length > 0
          ? slot.fighterNames
          : previousSlot.fighterNames,
      payout: slot.payout ?? previousSlot.payout ?? null,
      currentTurn: Math.max(
        safeNumber(slot.currentTurn, 0),
        safeNumber(previousSlot.currentTurn, 0),
        Array.isArray(mergedTurns) ? mergedTurns.length : 0,
      ),
      bettingDeadline: mergedDeadline,
    };
  });

  return {
    ...next,
    slots: mergedSlots,
  };
}

// ---------------------------------------------------------------------------
// API fetch helpers with multi-base fallback
// ---------------------------------------------------------------------------
function getApiBaseCandidates(): string[] {
  const explicit = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  const allowLocalFallback = process.env.EXPO_PUBLIC_ALLOW_LOCAL_API_FALLBACK === "1";
  const explicitIsLocal = !!explicit && /^http:\/\/(127\.0\.0\.1|localhost)/i.test(explicit);
  const raw = __DEV__
    ? [explicit, LIVE_API_BASE, allowLocalFallback || explicitIsLocal ? LOCAL_API_BASE : null]
    : [explicit, LIVE_API_BASE];
  const unique = new Set<string>();
  for (const base of raw) {
    if (!base) continue;
    unique.add(base.replace(/\/+$/, ""));
  }
  return [...unique];
}

function getOrderedApiBaseCandidates(): string[] {
  const candidates = getApiBaseCandidates();
  if (!preferredApiBase) return candidates;
  return [preferredApiBase, ...candidates.filter(base => base !== preferredApiBase)];
}

export async function fetchApiWithFallback(
  path: string,
  init?: RequestInit,
  mode: "read" | "write" = "read",
): Promise<Response> {
  const baseTimeoutMs = mode === "write" ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
  const method = String(init?.method ?? "GET").toUpperCase();
  const allowHttpFallback = mode === "read" && method === "GET";
  const supportsAbort = typeof AbortController !== "undefined";
  let lastError: Error | null = null;
  let fallbackResponse: Response | null = null;

  for (const base of getOrderedApiBaseCandidates()) {
    const isLocalCandidate = /^http:\/\/(127\.0\.0\.1|localhost)/i.test(base);
    const candidateTimeoutMs = isLocalCandidate ? Math.min(baseTimeoutMs, 1500) : baseTimeoutMs;
    try {
      const keepAliveInit: RequestInit = {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> ?? {}),
          "Connection": "keep-alive",
        },
        keepalive: true,
      };
      const res = supportsAbort
        ? await (() => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), candidateTimeoutMs);
          return fetch(`${base}${path}`, { ...keepAliveInit, signal: controller.signal })
            .finally(() => clearTimeout(timer));
        })()
        : await fetch(`${base}${path}`, keepAliveInit);
      if (res.ok) {
        preferredApiBase = base;
        return res;
      }

      const canRetryWrite = mode === "write" && WRITE_RETRYABLE_STATUS.has(res.status);
      if (allowHttpFallback || canRetryWrite) {
        fallbackResponse = res;
        continue;
      }

      preferredApiBase = base;
      return res;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalized = /abort/i.test(message)
        ? new Error(`Request timed out after ${candidateTimeoutMs}ms`)
        : error instanceof Error
          ? error
          : new Error(String(error));
      lastError = normalized;
    }
  }

  if (fallbackResponse) return fallbackResponse;
  throw lastError ?? new Error(`Request failed: ${path}`);
}

export async function fetchJsonFromCandidates<T>(path: string): Promise<T> {
  const res = await fetchApiWithFallback(path, undefined, "read");
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

export function postJsonWithFallback(path: string, body: unknown): Promise<Response> {
  return fetchApiWithFallback(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    "write",
  );
}
