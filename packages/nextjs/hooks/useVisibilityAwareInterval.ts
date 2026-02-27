"use client";

import { useEffect, useRef } from "react";
import { usePageVisibility } from "./usePageVisibility";

interface UseVisibilityAwareIntervalOptions {
  /** Interval in ms while tab is visible. */
  interval: number;
  /**
   * If true, fires the callback immediately when the tab becomes visible
   * (catches up on data missed while hidden). Defaults to true.
   */
  refetchOnVisible?: boolean;
  /** If false, the interval is disabled entirely. */
  enabled?: boolean;
}

/**
 * A drop-in replacement for setInterval that:
 * - Runs at the given interval when the tab is visible
 * - Completely pauses when the tab is hidden (zero wasted RPC calls)
 * - Optionally fires immediately on tab re-focus to catch up
 */
export function useVisibilityAwareInterval(
  callback: () => void,
  options: UseVisibilityAwareIntervalOptions,
): void {
  const { interval, refetchOnVisible = true, enabled = true } = options;
  const isPageVisible = usePageVisibility();
  const callbackRef = useRef(callback);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    if (isPageVisible) {
      // Tab just became visible — fire immediately to get fresh data
      if (refetchOnVisible) {
        callbackRef.current();
      }

      intervalRef.current = setInterval(() => {
        callbackRef.current();
      }, interval);
    } else {
      // Tab is hidden — stop entirely
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isPageVisible, interval, enabled, refetchOnVisible]);
}
