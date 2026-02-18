/**
 * Admin Helius Webhook Management
 *
 * GET  /api/admin/webhooks/helius  — List all registered webhooks
 * POST /api/admin/webhooks/helius  — Register a new webhook
 * DELETE /api/admin/webhooks/helius?id=<webhookId>  — Delete a webhook
 *
 * Requires x-admin-secret header.
 */

import { NextResponse } from "next/server";
import { isAuthorizedAdminRequest } from "~~/lib/request-auth";
import {
  registerHeliusWebhook,
  listHeliusWebhooks,
  deleteHeliusWebhook,
} from "~~/lib/helius-webhook";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * GET — List all registered Helius webhooks
 */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) return unauthorized();

  try {
    const webhooks = await listHeliusWebhooks();
    return NextResponse.json({ webhooks });
  } catch (error: any) {
    console.error("[AdminHeliusWebhook] List failed:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to list webhooks" },
      { status: 500 },
    );
  }
}

/**
 * POST — Register a new webhook
 *
 * Body: { webhook_url: string, account_addresses?: string[] }
 *
 * If webhook_url is not provided, it will be auto-derived from
 * NEXT_PUBLIC_APP_URL or VERCEL_URL.
 */
export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) return unauthorized();

  try {
    const body = await request.json().catch(() => ({}));

    let webhookUrl = body.webhook_url ?? body.webhookUrl;

    // Auto-derive webhook URL if not provided
    if (!webhookUrl) {
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL?.trim() ||
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

      if (!appUrl) {
        return NextResponse.json(
          {
            error:
              "Missing webhook_url. Provide it in the body or set NEXT_PUBLIC_APP_URL.",
          },
          { status: 400 },
        );
      }

      webhookUrl = `${appUrl}/api/webhooks/helius`;
    }

    const extraAddresses = Array.isArray(body.account_addresses)
      ? body.account_addresses.filter(
          (a: unknown): a is string => typeof a === "string",
        )
      : [];

    const result = await registerHeliusWebhook(webhookUrl, extraAddresses);

    console.log(
      `[AdminHeliusWebhook] Registered webhook ${result.webhookID} -> ${webhookUrl}`,
    );

    return NextResponse.json({
      ok: true,
      webhook_id: result.webhookID,
      webhook_url: result.webhookURL,
      account_addresses: result.accountAddresses,
      webhook_type: result.webhookType,
    });
  } catch (error: any) {
    console.error("[AdminHeliusWebhook] Register failed:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to register webhook" },
      { status: 500 },
    );
  }
}

/**
 * DELETE — Delete a webhook by ID
 *
 * Query: ?id=<webhookId>
 */
export async function DELETE(request: Request) {
  if (!isAuthorizedAdminRequest(request.headers)) return unauthorized();

  try {
    const { searchParams } = new URL(request.url);
    const webhookId = searchParams.get("id");

    if (!webhookId) {
      return NextResponse.json(
        { error: "Missing ?id=<webhookId> query parameter" },
        { status: 400 },
      );
    }

    await deleteHeliusWebhook(webhookId);

    console.log(`[AdminHeliusWebhook] Deleted webhook ${webhookId}`);

    return NextResponse.json({ ok: true, deleted: webhookId });
  } catch (error: any) {
    console.error("[AdminHeliusWebhook] Delete failed:", error);
    return NextResponse.json(
      { error: error.message ?? "Failed to delete webhook" },
      { status: 500 },
    );
  }
}
