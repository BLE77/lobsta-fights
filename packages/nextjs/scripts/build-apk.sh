#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TWA_DIR="$PROJECT_DIR/.twa-build"
MANIFEST_FILE="$PROJECT_DIR/twa-manifest.json"
OUTPUT_FILE="$PROJECT_DIR/ucf-seeker-v1.1.0.apk"
WEB_MANIFEST_URL="${TWA_WEB_MANIFEST_URL:-https://clawfights.xyz/manifest.json}"

echo "=============================================="
echo " UCF Seeker APK Build"
echo "=============================================="

if ! command -v bubblewrap >/dev/null 2>&1; then
  echo "bubblewrap not found."
  echo "Install with: npm i -g @bubblewrap/cli"
  exit 1
fi

if ! java -version >/dev/null 2>&1; then
  echo "Java runtime not found."
  echo "Install JDK 17+ before building the APK."
  exit 1
fi

if ! bubblewrap doctor >/dev/null 2>&1; then
  echo "Bubblewrap environment is not configured (Android SDK/JDK)."
  echo "Run: bubblewrap updateConfig --jdkPath <path-to-jdk> --androidSdkPath <path-to-android-sdk>"
  exit 1
fi

if [ ! -f "$MANIFEST_FILE" ]; then
  echo "Missing TWA manifest: $MANIFEST_FILE"
  exit 1
fi

mkdir -p "$TWA_DIR"
cp "$MANIFEST_FILE" "$TWA_DIR/twa-manifest.json"
cd "$TWA_DIR"

if [ -f "build.gradle" ]; then
  echo "Updating existing TWA project..."
  if ! bubblewrap update --manifest="./twa-manifest.json" --skipVersionUpgrade; then
    echo "Warning: bubblewrap update failed. Continuing with existing Android project files."
  fi
else
  echo "Initializing TWA project..."
  bubblewrap init --manifest="$WEB_MANIFEST_URL"
  bubblewrap update --manifest="./twa-manifest.json" --skipVersionUpgrade
fi

# Bubblewrap may create an invalid Gradle project name when the directory starts
# with a dot (for example ".twa-build"). Normalize it before assemble.
if [ -f "settings.gradle" ]; then
  if grep -q "rootProject.name" settings.gradle; then
    sed -i.bak "s/rootProject.name='\\.twa-build'/rootProject.name='twa-build'/g" settings.gradle || true
  else
    printf "\nrootProject.name='twa-build'\n" >> settings.gradle
  fi
  rm -f settings.gradle.bak
fi

echo "Building APK..."
bubblewrap build --manifest="./twa-manifest.json" --skipPwaValidation

SIGNED_APK="$TWA_DIR/app-release-signed.apk"
if [ ! -f "$SIGNED_APK" ]; then
  echo "Signed APK not found at $SIGNED_APK"
  exit 1
fi

cp "$SIGNED_APK" "$OUTPUT_FILE"

echo
echo "Build complete."
echo "Signed APK: $OUTPUT_FILE"
echo "Next: publish in Solana dApp Store -> https://publish.solanamobile.com"
