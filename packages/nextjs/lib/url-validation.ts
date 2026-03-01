import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const ALLOWED_IMAGE_HOSTS = new Set(["replicate.delivery", "replicate.com"]);
const ALLOWED_IMAGE_SUPABASE_SUFFIXES = new Set([".supabase.co", ".supabase.com"]);

const BLOCKED_WEBHOOK_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
  "host.docker.internal",
]);

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(part => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some(n => Number.isNaN(n))) return true;
  if (octets[0] === 10) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 0) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.slice(7);
    return isPrivateIpv4(mappedIpv4);
  }

  const firstHextet = normalized.split(":")[0];
  const firstByte = Number.parseInt(firstHextet.slice(0, 2), 16);
  const secondByte = Number.parseInt(firstHextet.slice(2, 4) || "0", 16);
  return (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    (firstByte === 0xfe && (secondByte & 0xc0) === 0x80)
  );
}

function isPrivateIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

function isAllowedImageHost(hostname: string): boolean {
  if (ALLOWED_IMAGE_HOSTS.has(hostname)) return true;
  return [...ALLOWED_IMAGE_SUPABASE_SUFFIXES].some(suffix => hostname.endsWith(suffix));
}

export async function isAllowedUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!isAllowedImageHost(hostname)) {
    return false;
  }

  try {
    const addresses = await lookup(hostname, { all: true });
    if (addresses.length === 0) return false;

    return !addresses.some(entry => isPrivateIpAddress(entry.address));
  } catch {
    return false;
  }
}

export async function validateWebhookUrl(webhookUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return "Invalid webhook URL";
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    return "Webhook URL must use http or https";
  }

  if (parsed.username || parsed.password) {
    return "Webhook URL must not include credentials";
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    BLOCKED_WEBHOOK_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return "Webhook URL cannot point to private/internal addresses";
  }

  if (isIP(hostname) && isPrivateIpAddress(hostname)) {
    return "Webhook URL cannot point to private/internal addresses";
  }

  try {
    const addresses = await lookup(hostname, { all: true });
    if (
      addresses.length === 0 ||
      addresses.some(entry => isPrivateIpAddress(entry.address))
    ) {
      return "Webhook URL cannot resolve to private/internal IPs";
    }
  } catch {
    return "Unable to resolve webhook hostname";
  }

  return null;
}
