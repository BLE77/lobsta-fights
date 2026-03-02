import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: WorkerGlobalScope & typeof globalThis;

const noCacheRumbleApis: RuntimeCaching = {
  matcher: ({ sameOrigin, url: { pathname } }) => sameOrigin && pathname.startsWith("/api/rumble/"),
  method: "GET",
  handler: new NetworkOnly({ networkTimeoutSeconds: 10 }),
};

const noCacheRealtimeApis: RuntimeCaching = {
  matcher: ({ sameOrigin, url: { pathname } }) =>
    sameOrigin && (pathname === "/api/activity" || pathname === "/api/admin/dashboard"),
  method: "GET",
  handler: new NetworkOnly({ networkTimeoutSeconds: 10 }),
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [noCacheRumbleApis, noCacheRealtimeApis, ...defaultCache],
});

serwist.addEventListeners();
