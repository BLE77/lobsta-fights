import { timingSafeEqual } from "node:crypto";

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

export function getApiKeyFromHeaders(headers: Headers): string | null {
  const apiKey = headers.get("x-api-key") ?? headers.get("x-ucf-api-key");
  return apiKey?.trim() || null;
}

export function isAuthorizedAdminToken(token: string | null | undefined): boolean {
  return matchesAnySecret(token, [process.env.ADMIN_SECRET, process.env.ADMIN_API_KEY]);
}

export function isAuthorizedAdminRequest(headers: Headers): boolean {
  const adminKey = headers.get("x-admin-secret") ?? headers.get("x-admin-key");
  return isAuthorizedAdminToken(adminKey);
}

export function isAuthorizedCronRequest(headers: Headers): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return false;
  return getBearerToken(headers) === cronSecret;
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
