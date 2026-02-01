import { NextRequest, NextResponse } from "next/server";

// Verify that a fighter endpoint is automated (not human)
// Sends a challenge and expects response within 5 seconds

export async function POST(req: NextRequest) {
  try {
    const { endpoint, walletAddress } = await req.json();

    if (!endpoint || !walletAddress) {
      return NextResponse.json(
        { error: "Missing endpoint or walletAddress" },
        { status: 400 }
      );
    }

    // Validate URL format
    try {
      new URL(endpoint);
    } catch {
      return NextResponse.json(
        { error: "Invalid endpoint URL" },
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
          error: `Failed to reach endpoint: ${fetchError.message}`
        },
        { status: 200 }
      );
    }

  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
