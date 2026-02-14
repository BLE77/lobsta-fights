// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Verify that a fighter endpoint is automated (not human)
// Sends a challenge and expects response within 5 seconds

export const dynamic = "force-dynamic";

const BLOCKED_HOSTNAMES = new Set([
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
  if (octets[0] >= 224) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function isPrivateIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

async function validateEndpointUrl(endpoint: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return "Invalid endpoint URL";
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    return "Endpoint must use http or https";
  }

  if (parsed.username || parsed.password) {
    return "Endpoint URL must not include credentials";
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return "Endpoint URL cannot use internal/private hostnames";
  }

  if (isIP(hostname) && isPrivateIpAddress(hostname)) {
    return "Endpoint URL cannot use internal/private IP addresses";
  }

  try {
    const addresses = await lookup(hostname, { all: true });
    if (
      addresses.length === 0 ||
      addresses.some(entry => isPrivateIpAddress(entry.address))
    ) {
      return "Endpoint resolves to an internal/private IP";
    }
  } catch {
    return "Unable to resolve endpoint hostname";
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { endpoint, walletAddress } = await req.json();

    if (!endpoint || !walletAddress) {
      return NextResponse.json(
        { error: "Missing endpoint or walletAddress" },
        { status: 400 }
      );
    }

    const endpointValidationError = await validateEndpointUrl(endpoint);
    if (endpointValidationError) {
      return NextResponse.json(
        { error: endpointValidationError },
        { status: 400 }
      );
    }

    // Generate a random challenge
    const challenge = crypto.randomUUID();
    const timestamp = Date.now();

    // Ping the fighter's endpoint with a challenge
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-UCF-Challenge": challenge,
        },
        body: JSON.stringify({
          type: "verification",
          challenge,
          timestamp,
          message: "Respond with the challenge to verify your endpoint",
        }),
        redirect: "manual",
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return NextResponse.json(
          {
            verified: false,
            error: `Endpoint returned status ${response.status}`
          },
          { status: 200 }
        );
      }

      const data = await response.json();
      const responseTime = Date.now() - timestamp;

      // Check if the response contains the challenge
      if (data.challenge !== challenge) {
        return NextResponse.json(
          {
            verified: false,
            error: "Challenge mismatch - endpoint did not echo challenge correctly"
          },
          { status: 200 }
        );
      }

      // Verified! Response was fast and correct
      return NextResponse.json({
        verified: true,
        responseTime,
        message: `Endpoint verified in ${responseTime}ms`,
      });

    } catch (fetchError: any) {
      clearTimeout(timeout);

      if (fetchError.name === "AbortError") {
        return NextResponse.json(
          {
            verified: false,
            error: "Endpoint timed out (must respond within 5 seconds)"
          },
          { status: 200 }
        );
      }

      return NextResponse.json(
        {
          verified: false,
          error: "Failed to reach endpoint"
        },
        { status: 200 }
      );
    }

  } catch (error: any) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
