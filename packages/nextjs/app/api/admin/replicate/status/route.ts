import { NextRequest, NextResponse } from "next/server";
import { getReplicateMonitoringReport } from "../../../../../lib/art-media-monitoring";
import { isAuthorizedAdminRequest } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/replicate/status
 *
 * Returns Replicate usage/spend estimates and image-pipeline health alerts.
 * This is an internal monitoring endpoint, not a public billing source of truth.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedAdminRequest(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const report = await getReplicateMonitoringReport();
    return NextResponse.json(report);
  } catch (error: any) {
    console.error("[ReplicateStatus] Failed to build report", error);
    return NextResponse.json(
      { error: error?.message || "Failed to build Replicate monitoring report" },
      { status: 500 }
    );
  }
}
