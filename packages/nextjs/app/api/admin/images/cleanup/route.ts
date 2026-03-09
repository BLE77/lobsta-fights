import { NextRequest, NextResponse } from "next/server";
import { cleanupOrphanedStorageObjects, getImageStorageAudit } from "../../../../../lib/art-media-monitoring";
import { isAuthorizedAdminRequest } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/admin/images/cleanup
 *
 * Audits permanent image storage and reports orphaned objects, dangling DB refs,
 * and temp Replicate URLs still present in the database.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedAdminRequest(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const sampleLimit = Number(searchParams.get("sample") ?? "25");

  try {
    const audit = await getImageStorageAudit(Number.isFinite(sampleLimit) ? sampleLimit : 25);
    return NextResponse.json(audit);
  } catch (error: any) {
    console.error("[ImageCleanup] Audit failed", error);
    return NextResponse.json(
      { error: error?.message || "Failed to audit image storage" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/images/cleanup
 *
 * Dry-run by default. Send {"dry_run": false, "limit": 100} to delete orphaned
 * permanent storage objects under fighters/ and battles/.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedAdminRequest(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { dry_run?: boolean; limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const result = await cleanupOrphanedStorageObjects({
      dryRun: body.dry_run ?? true,
      limit: body.limit,
    });
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("[ImageCleanup] Cleanup failed", error);
    return NextResponse.json(
      { error: error?.message || "Failed to clean orphaned image storage" },
      { status: 500 }
    );
  }
}
