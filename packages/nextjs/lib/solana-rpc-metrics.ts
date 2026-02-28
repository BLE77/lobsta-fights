import { AsyncLocalStorage } from "node:async_hooks";
import type { Connection } from "@solana/web3.js";

type RpcMethodStats = {
  count: number;
  totalMs: number;
};

type RpcMetricsContext = {
  route: string;
  startedAt: number;
  sampled: boolean;
  methods: Map<string, RpcMethodStats>;
};

const _als = new AsyncLocalStorage<RpcMetricsContext>();

const SAMPLE_RATE = (() => {
  const raw = Number(process.env.RUMBLE_RPC_METRICS_SAMPLE_RATE ?? "1");
  if (!Number.isFinite(raw)) return 1;
  return Math.max(0, Math.min(1, raw));
})();

const LOG_ALL = process.env.RUMBLE_RPC_METRICS_LOG_ALL === "true";

const INSTRUMENTED_SYMBOL = Symbol.for("rumble.rpc.metrics.instrumented");

function upsertMethodStat(ctx: RpcMetricsContext, method: string, elapsedMs: number) {
  const existing = ctx.methods.get(method);
  if (existing) {
    existing.count += 1;
    existing.totalMs += elapsedMs;
    return;
  }
  ctx.methods.set(method, { count: 1, totalMs: elapsedMs });
}

export function runWithRpcMetrics<T>(route: string, fn: () => Promise<T>): Promise<T> {
  const ctx: RpcMetricsContext = {
    route,
    startedAt: Date.now(),
    sampled: Math.random() < SAMPLE_RATE,
    methods: new Map(),
  };
  return _als.run(ctx, fn);
}

export function recordRpcCall(method: string, elapsedMs: number): void {
  const ctx = _als.getStore();
  if (!ctx || !ctx.sampled) return;
  upsertMethodStat(ctx, method, elapsedMs);
}

export function flushRpcMetrics(extra?: Record<string, unknown>): void {
  const ctx = _als.getStore();
  if (!ctx || !ctx.sampled) return;
  if (ctx.methods.size === 0) return;

  const methodEntries = [...ctx.methods.entries()].sort((a, b) => b[1].count - a[1].count);
  const methods: Record<string, { count: number; totalMs: number }> = {};
  for (const [method, stat] of methodEntries) {
    methods[method] = {
      count: stat.count,
      totalMs: Math.round(stat.totalMs),
    };
  }

  const accountInfoCount = (ctx.methods.get("getAccountInfo")?.count ?? 0)
    + (ctx.methods.get("getMultipleAccountsInfo")?.count ?? 0);

  if (!LOG_ALL && accountInfoCount === 0) return;

  console.info(
    "[rpc-metrics]",
    JSON.stringify({
      route: ctx.route,
      elapsedMs: Date.now() - ctx.startedAt,
      accountInfoCalls: accountInfoCount,
      methods,
      ...(extra ?? {}),
    }),
  );
}

export function instrumentConnection<T extends Connection>(
  connection: T,
  connectionLabel: string,
): T {
  const connAny = connection as any;
  if (connAny[INSTRUMENTED_SYMBOL]) return connection;

  const methodsToTrack = [
    "getAccountInfo",
    "getMultipleAccountsInfo",
    "getProgramAccounts",
    "getBalance",
    "getSlot",
    "getLatestBlockhash",
    "getParsedTransaction",
  ] as const;

  for (const method of methodsToTrack) {
    const original = connAny[method] as ((...args: any[]) => Promise<any>) | undefined;
    if (typeof original !== "function") continue;
    connAny[method] = async (...args: any[]) => {
      const startedAt = Date.now();
      try {
        return await original.apply(connection, args);
      } finally {
        const elapsed = Date.now() - startedAt;
        recordRpcCall(method, elapsed);
        recordRpcCall(`${connectionLabel}.${method}`, elapsed);
      }
    };
  }

  connAny[INSTRUMENTED_SYMBOL] = true;
  return connection;
}
