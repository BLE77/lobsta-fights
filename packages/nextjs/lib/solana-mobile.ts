"use client";

import { useMemo } from "react";

declare global {
  interface Window {
    MobileWalletAdapter?: unknown;
  }
}

interface DetectSolanaMobileContextInput {
  userAgent?: string;
  href?: string;
  referrer?: string;
  hasInjectedMobileWalletAdapter?: boolean;
}

export interface SolanaMobileContext {
  isMobile: boolean;
  isSeeker: boolean;
  isSaga: boolean;
  isLikelySolanaDappBrowser: boolean;
  hasInjectedMobileWalletAdapter: boolean;
  isLikelySolanaMobile: boolean;
  shouldPreferMobileWalletAdapter: boolean;
  shouldUseMobileOptimizations: boolean;
}

const SOLANA_MOBILE_REFERRER_PATHS = ["play", "discover", "publish"] as const;
const SOLANA_CLUSTER_VALUES = new Set(["devnet", "testnet", "mainnet-beta"]);

function safeUrl(value?: string): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasSolanaMobileReferrer(referrer: string): boolean {
  const lower = referrer.toLowerCase();
  return SOLANA_MOBILE_REFERRER_PATHS.some((segment) =>
    lower.includes(`solanamobile.com/${segment}`),
  );
}

export function detectSolanaMobileContext(
  input: DetectSolanaMobileContextInput = {},
): SolanaMobileContext {
  const userAgent = (input.userAgent ?? "").toLowerCase();
  const referrer = input.referrer ?? "";
  const url = safeUrl(input.href);
  const injected = Boolean(input.hasInjectedMobileWalletAdapter);

  const isMobile = /android|iphone|ipad|ipod/.test(userAgent);
  const isSeeker = userAgent.includes("seeker");
  const isSaga =
    userAgent.includes("saga") ||
    userAgent.includes("solana saga") ||
    userAgent.includes("solana-saga");
  const uaHintsSolanaMobile =
    userAgent.includes("solanamobile") ||
    userAgent.includes("solana-mobile") ||
    userAgent.includes("seedvault");

  const cluster = url?.searchParams.get("cluster")?.toLowerCase();
  const hasSolanaClusterParam = Boolean(cluster && SOLANA_CLUSTER_VALUES.has(cluster));
  const hasDappStoreReferrer = hasSolanaMobileReferrer(referrer);
  const isLikelySolanaDappBrowser = hasSolanaClusterParam || hasDappStoreReferrer;

  const isLikelySolanaMobile =
    isMobile &&
    (isSeeker || isSaga || uaHintsSolanaMobile || isLikelySolanaDappBrowser || injected);

  return {
    isMobile,
    isSeeker,
    isSaga,
    isLikelySolanaDappBrowser,
    hasInjectedMobileWalletAdapter: injected,
    isLikelySolanaMobile,
    shouldPreferMobileWalletAdapter: isLikelySolanaMobile || injected,
    shouldUseMobileOptimizations: isLikelySolanaMobile,
  };
}

export function useSolanaMobileContext(): SolanaMobileContext {
  return useMemo(() => {
    if (typeof window === "undefined") {
      return detectSolanaMobileContext();
    }
    return detectSolanaMobileContext({
      userAgent: window.navigator.userAgent,
      href: window.location.href,
      referrer: document.referrer,
      hasInjectedMobileWalletAdapter: "MobileWalletAdapter" in window,
    });
  }, []);
}
