#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TWA_DIR="$PROJECT_DIR/.twa-build"
MANIFEST_FILE="$PROJECT_DIR/twa-manifest.json"
OUTPUT_FILE="$PROJECT_DIR/ucf-seeker-v1.1.0.apk"
UNSIGNED_OUTPUT_FILE="$PROJECT_DIR/ucf-seeker-v1.1.0-unsigned.apk"
WEB_MANIFEST_URL="${TWA_WEB_MANIFEST_URL:-https://clawfights.xyz/manifest.json}"
CHECKSUM_FILE="$TWA_DIR/manifest-checksum.txt"
DEFAULT_JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"

configure_java() {
  if java -version >/dev/null 2>&1; then
    return 0
  fi

  if [ -f "$HOME/.bubblewrap/config.json" ]; then
    local candidate
    candidate="$(node -e '
      const fs = require("fs");
      const path = require("path");
      try {
        const cfg = JSON.parse(fs.readFileSync(process.env.HOME + "/.bubblewrap/config.json", "utf8"));
        const jdkPath = cfg.jdkPath || "";
        const direct = path.join(jdkPath, "bin", "java");
        const contentsHome = path.join(jdkPath, "Contents", "Home", "bin", "java");
        if (fs.existsSync(direct)) process.stdout.write(path.dirname(direct));
        else if (fs.existsSync(contentsHome)) process.stdout.write(path.dirname(contentsHome));
      } catch (_) {}
    ' 2>/dev/null || true)"
    if [ -n "$candidate" ] && [ -x "$candidate/java" ]; then
      export JAVA_HOME="$(dirname "$candidate")"
      export PATH="$JAVA_HOME/bin:$PATH"
    fi
  fi

  if ! java -version >/dev/null 2>&1 && [ -x "$DEFAULT_JAVA_HOME/bin/java" ]; then
    export JAVA_HOME="$DEFAULT_JAVA_HOME"
    export PATH="$JAVA_HOME/bin:$PATH"
  fi
}

write_manifest_checksum() {
  local manifest_path="${1:-$MANIFEST_FILE}"
  local checksum=""
  if command -v shasum >/dev/null 2>&1; then
    checksum="$(shasum -a 1 "$manifest_path" | awk '{print $1}')"
  elif command -v sha1sum >/dev/null 2>&1; then
    checksum="$(sha1sum "$manifest_path" | awk '{print $1}')"
  fi

  if [ -n "$checksum" ]; then
    # Bubblewrap expects checksum file contents without a trailing newline.
    printf "%s" "$checksum" > "$CHECKSUM_FILE"
  fi
}

ensure_android_resources() {
  local icon_source=""
  if [ -f "$PROJECT_DIR/public/icon-512x512.png" ]; then
    icon_source="$PROJECT_DIR/public/icon-512x512.png"
  elif [ -f "$PROJECT_DIR/public/icon-192x192.png" ]; then
    icon_source="$PROJECT_DIR/public/icon-192x192.png"
  fi

  if [ -z "$icon_source" ]; then
    return 0
  fi

  mkdir -p app/src/main/res/drawable
  if [ ! -f app/src/main/res/drawable/splash.png ]; then
    cp -f "$icon_source" app/src/main/res/drawable/splash.png
  fi

  for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
    mkdir -p "app/src/main/res/mipmap-$density"
    if [ ! -f "app/src/main/res/mipmap-$density/ic_maskable.png" ]; then
      cp -f "$icon_source" "app/src/main/res/mipmap-$density/ic_maskable.png"
    fi
  done
}

sync_signing_key() {
  local signing_key_rel=""
  signing_key_rel="$(node -e '
    const fs = require("fs");
    try {
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (cfg.signingKey && cfg.signingKey.path) process.stdout.write(cfg.signingKey.path);
    } catch (_) {}
  ' "$MANIFEST_FILE" 2>/dev/null || true)"

  if [ -z "$signing_key_rel" ]; then
    return 0
  fi

  # Absolute keystore paths do not require copying.
  if [[ "$signing_key_rel" = /* ]]; then
    return 0
  fi

  local rel_path="${signing_key_rel#./}"
  local src_key="$PROJECT_DIR/$rel_path"
  local dst_key="$TWA_DIR/$rel_path"

  if [ -f "$src_key" ]; then
    mkdir -p "$(dirname "$dst_key")"
    cp -f "$src_key" "$dst_key"
  fi
}

echo "=============================================="
echo " UCF Seeker APK Build"
echo "=============================================="

if ! command -v bubblewrap >/dev/null 2>&1; then
  echo "bubblewrap not found."
  echo "Install with: npm i -g @bubblewrap/cli"
  exit 1
fi

configure_java

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
sync_signing_key
write_manifest_checksum "$MANIFEST_FILE"
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

ensure_android_resources

# Keep checksum aligned with the current TWA manifest so Bubblewrap build stays non-interactive.
write_manifest_checksum "./twa-manifest.json"

echo "Building APK..."
BUILD_ARGS=(--manifest="./twa-manifest.json" --skipPwaValidation)

if [ "${BUBBLEWRAP_SKIP_SIGNING:-0}" = "1" ]; then
  BUILD_ARGS+=(--skipSigning)
else
  if [ -z "${BUBBLEWRAP_KEYSTORE_PASSWORD:-}" ] || [ -z "${BUBBLEWRAP_KEY_PASSWORD:-}" ]; then
    if [ -t 0 ]; then
      read -r -s -p "Keystore password: " BUBBLEWRAP_KEYSTORE_PASSWORD
      echo
      read -r -s -p "Key password: " BUBBLEWRAP_KEY_PASSWORD
      echo
      export BUBBLEWRAP_KEYSTORE_PASSWORD
      export BUBBLEWRAP_KEY_PASSWORD
    else
      echo "Missing signing credentials."
      echo "Set BUBBLEWRAP_KEYSTORE_PASSWORD and BUBBLEWRAP_KEY_PASSWORD, or run with BUBBLEWRAP_SKIP_SIGNING=1."
      exit 1
    fi
  fi
fi

bubblewrap build "${BUILD_ARGS[@]}"

if [ "${BUBBLEWRAP_SKIP_SIGNING:-0}" = "1" ]; then
  UNSIGNED_APK="$TWA_DIR/app-release-unsigned-aligned.apk"
  if [ ! -f "$UNSIGNED_APK" ]; then
    echo "Unsigned aligned APK not found at $UNSIGNED_APK"
    exit 1
  fi
  cp "$UNSIGNED_APK" "$UNSIGNED_OUTPUT_FILE"
  echo
  echo "Build complete."
  echo "Unsigned APK: $UNSIGNED_OUTPUT_FILE"
else
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
fi
