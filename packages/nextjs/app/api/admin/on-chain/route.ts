// @ts-nocheck
import { NextResponse } from "next/server";
import {
  readArenaConfig,
  readRumbleConfig,
  readRegistryConfig,
} from "~~/lib/solana-programs";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [arenaConfig, rumbleConfig, registryConfig] = await Promise.all([
      readArenaConfig().catch(() => null),
      readRumbleConfig().catch(() => null),
      readRegistryConfig().catch(() => null),
    ]);

    // Convert BigInts to strings for JSON serialization
    const serializeBigInts = (obj: any) => {
      if (!obj) return null;
      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = typeof value === "bigint" ? value.toString() : value;
      }
      return result;
    };

    return NextResponse.json({
      arenaConfig: serializeBigInts(arenaConfig),
      rumbleConfig: serializeBigInts(rumbleConfig),
      registryConfig: serializeBigInts(registryConfig),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
