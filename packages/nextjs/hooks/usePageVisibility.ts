"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * usePageVisibility
 *
 * Returns true when the browser tab is the active foreground tab.
 * Returns false when the tab is backgrounded, minimized, or screen locked.
 *
 * SSR-safe: returns true on server (no document), adjusts on client mount.
 *
 * Usage:
 *   const isPageVisible = usePageVisibility();
 *   // skip polling or increase interval when !isPageVisible
 */
export function usePageVisibility(): boolean {
  const getVisibility = useCallback((): boolean => {
    if (typeof document === "undefined") return true;
    return !document.hidden;
  }, []);

  const [isPageVisible, setIsPageVisible] = useState<boolean>(getVisibility);

  useEffect(() => {
    setIsPageVisible(getVisibility());

    const handleVisibilityChange = () => {
      setIsPageVisible(getVisibility());
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [getVisibility]);

  return isPageVisible;
}
