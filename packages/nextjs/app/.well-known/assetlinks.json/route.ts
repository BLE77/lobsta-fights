import { NextResponse } from "next/server";

const DEFAULT_PACKAGE_NAME = "xyz.clawfights.twa";
const DEFAULT_FINGERPRINT =
  "F0:C4:50:C7:F2:ED:40:1E:57:40:46:98:F6:24:00:9E:50:6A:3D:A4:C0:6D:17:C7:23:92:85:E5:19:35:69:D5";

function getFingerprints(): string[] {
  const raw =
    process.env.TWA_SHA256_CERT_FINGERPRINTS ??
    process.env.NEXT_PUBLIC_TWA_SHA256_CERT_FINGERPRINTS ??
    "";

  const parsed = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : [DEFAULT_FINGERPRINT];
}

export async function GET() {
  const packageName = process.env.TWA_PACKAGE_NAME?.trim() || DEFAULT_PACKAGE_NAME;
  const assetLinks = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: getFingerprints(),
      },
    },
  ];

  return NextResponse.json(assetLinks, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export const dynamic = "force-static";
