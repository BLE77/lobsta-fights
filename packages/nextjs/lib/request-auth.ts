import { timingSafeEqual } from "node:crypto";
import { isValidAdminSession } from "~~/lib/admin-session";

function secureEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function configuredSecrets(values: Array<string | undefined>): string[] {
  return values
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value));
}

function matchesAnySecret(
  provided: string | null | undefined,
  candidates: Array<string | undefined>,
): boolean {
  const token = provided?.trim();
  if (!token) return false;
  const configured = configuredSecrets(candidates);
  if (configured.length === 0) return false;
  return configured.some((candidate) => secureEquals(token, candidate));
}

function getBearerToken(headers: Headers): string | null {
  const authHeader = headers.get("authorization");
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

/**
 * Validate that a string is a valid UUID v4 format.
 * CRITICAL: Use this before interpolating any user-provided ID into .or() template literals
 * to prevent PostgREST filter injection.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidUUID(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_REGEX.test(value);
}

export function getApiKeyFromHeaders(headers: Headers): string | null {
  const apiKey = headers.get("x-api-key") ?? headers.get("x-ucf-api-key");
  return apiKey?.trim() || null;
}

export function isAuthorizedAdminToken(token: string | null | undefined): boolean {
  return matchesAnySecret(token, [process.env.ADMIN_SECRET, process.env.ADMIN_API_KEY]);
}

export function isAuthorizedAdminRequest(headers: Headers): boolean {
  // Check header-based auth first (backwards compat for API callers)
  const adminKey = headers.get("x-admin-secret") ?? headers.get("x-admin-key");
  if (isAuthorizedAdminToken(adminKey)) return true;

  // Check httpOnly session cookie
  const cookie = headers.get("cookie") ?? "";
  const match = cookie.match(/ucf_admin_session=([^;]+)/);
  if (match?.[1]) {
    return isValidAdminSession(match[1]);
  }

  return false;
}

export function isAuthorizedCronRequest(headers: Headers): boolean {
  return matchesAnySecret(getBearerToken(headers), [process.env.CRON_SECRET]);
}

/**
 * Authenticate a fighter by ID + API key using hash-first lookup with legacy fallback.
 * Returns the matched fighter row (with the selected columns) or null.
 * Automatically backfills api_key_hash for legacy fighters on successful plaintext match.
 */
export async function authenticateFighterByApiKey(
  fighterId: string,
  apiKey: string,
  selectColumns: string,
  supabaseFn: () => any,
): Promise<Record<string, any> | null> {
  const { hashApiKey } = await import("~~/lib/api-key");
  const hashedKey = hashApiKey(apiKey);

  const { data } = await supabaseFn()
    .from("ucf_fighters")
    .select(selectColumns)
    .eq("id", fighterId)
    .eq("api_key_hash", hashedKey)
    .maybeSingle();

  return (data as Record<string, any>) ?? null;
}

export function isAuthorizedInternalRequest(
  headers: Headers,
  bodyInternalKey?: string | null,
): boolean {
  const headerToken =
    headers.get("x-internal-key") ??
    headers.get("x-ucf-internal-key") ??
    headers.get("x-cron-secret") ??
    getBearerToken(headers);

  return matchesAnySecret(headerToken ?? bodyInternalKey, [
    process.env.UCF_INTERNAL_KEY,
    process.env.CRON_SECRET,
  ]);
}
