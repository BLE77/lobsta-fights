import { NextResponse } from "next/server";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import { getCommandStatus } from "~~/lib/worker-commands";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const commandId = searchParams.get("id");
  if (!commandId) {
    return NextResponse.json({ error: "Missing command id" }, { status: 400 });
  }

  const status = await getCommandStatus(commandId);
  if (!status) {
    return NextResponse.json({ error: "Command not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, command: status });
}
