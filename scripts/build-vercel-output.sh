#!/usr/bin/env bash
# Builds Entry and hand-assembles a Vercel Build Output API v3 deployment,
# bypassing Vercel's own (currently broken) build orchestration.
# See DEPLOY.md "Step 4 — Deploy to Vercel" for the full explanation and
# apps/web/scripts/vercel-launcher.js for why the Lambda entrypoint looks
# the way it does.
#
# Usage (run from repo root):
#   ./scripts/build-vercel-output.sh
#   npx vercel deploy --prebuilt --prod --archive=tgz --token "$VERCEL_TOKEN"
#
# Requires `vercel pull` to have been run at least once so apps/web has a
# .vercel/project.json (or that env vars are otherwise already configured
# in the Vercel project — this script only builds/assembles, it does not
# touch env vars).
set -euo pipefail

# NOW_BUILDER=1 tells Next's own ci-info detection (next/dist/server/ci-info.js:
# `isZeitNow = !!process.env.NOW_BUILDER`) that this build has genuine Vercel
# platform support -- which is actually true, just via our own hand-assembled
# Build Output API v3 path instead of Vercel's build orchestrator. Without
# this, next/dist/build/index.js bakes `experimental.trustHostHeader: false`
# into the standalone server.js's embedded config UNCONDITIONALLY (ignoring
# whatever next.config.ts's own experimental block says -- confirmed by
# reading build/index.js's minimal-config assembly directly), which makes
# every route handler's req.nextUrl.origin / req.url resolve to Next's
# internal placeholder base ('http://n') instead of the real domain at
# runtime, since our custom vercel-launcher.js hands NextServer's request
# handler a raw req without ever setting fetchHostname/port either. Setting
# this before the build (not just at runtime) is required -- it's baked in
# at build time, not read per-request.
export NOW_BUILDER=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> [1/6] npm install"
npm install

echo "==> [2/6] next build (output: 'standalone', set in apps/web/next.config.ts)"
npm run build

WEB_DIR="apps/web"
STANDALONE="$WEB_DIR/.next/standalone"
OUT=".vercel/output"

if [ ! -d "$STANDALONE/$WEB_DIR" ]; then
  echo "ERROR: $STANDALONE/$WEB_DIR not found — check output: 'standalone' is set" >&2
  exit 1
fi

echo "==> [3/6] Assembling .vercel/output"
if [ -d "$OUT" ]; then
  find "$OUT" -mindepth 1 -delete
fi
mkdir -p "$OUT/functions/index.func"
mkdir -p "$OUT/static"

# Function bundle = the whole traced standalone build (node_modules + our
# workspace packages + compiled server), plus the launcher entrypoint.
cp -r "$STANDALONE/." "$OUT/functions/index.func/"
cp "$WEB_DIR/scripts/vercel-launcher.js" "$OUT/functions/index.func/$WEB_DIR/vercel-launcher.js"

# Next needs its own compiled static-asset dir reachable at runtime too
# (some internal lookups reference .next/static even though we also serve
# it via the CDN static/ layer below).
mkdir -p "$OUT/functions/index.func/$WEB_DIR/.next/static"
cp -r "$WEB_DIR/.next/static/." "$OUT/functions/index.func/$WEB_DIR/.next/static/"

# Static assets served directly by Vercel's CDN layer, bypassing the
# function entirely.
mkdir -p "$OUT/static/_next/static"
cp -r "$WEB_DIR/.next/static/." "$OUT/static/_next/static/"
[ -d "$WEB_DIR/public" ] && cp -r "$WEB_DIR/public/." "$OUT/static/"

echo "==> [4/6] Extracting nextConfig blob + images config from server.js"
python3 - "$WEB_DIR" "$OUT" << 'PYEOF'
import re, json, sys

web_dir, out = sys.argv[1], sys.argv[2]
src = open(f"{web_dir}/.next/standalone/{web_dir}/server.js").read()
m = re.search(r"const nextConfig = (\{.*\})\n", src)
assert m, "nextConfig blob not found in server.js — Next.js internals may have changed"
cfg = json.loads(m.group(1))

with open(f"{out}/functions/index.func/{web_dir}/vercel-launcher.config.json", "w") as f:
    json.dump(cfg, f)

# Build Output API's own "images" block — bypassing @vercel/next's builder
# also skips its automatic image-optimization wiring, so /_next/image 404s
# unless we configure it ourselves here. Shape mirrors next.config's images.
img = cfg.get("images", {})
images_cfg = {
    "domains": img.get("domains", []),
    "remotePatterns": img.get("remotePatterns", []),
    "sizes": sorted(set(img.get("deviceSizes", []) + img.get("imageSizes", []))),
    "minimumCacheTTL": img.get("minimumCacheTTL", 60),
    "formats": img.get("formats", ["image/webp"]),
    "dangerouslyAllowSVG": img.get("dangerouslyAllowSVG", False),
    "contentSecurityPolicy": img.get("contentSecurityPolicy", "script-src 'none'; frame-src 'none'; sandbox;"),
    "contentDispositionType": img.get("contentDispositionType", "attachment"),
}

with open(f"{out}/config.json", "w") as f:
    json.dump({
        "version": 3,
        "routes": [
            {"src": "^/_next/static/(.*)$", "headers": {"cache-control": "public, max-age=31536000, immutable"}, "continue": True},
            {"handle": "filesystem"},
            {"src": "/(.*)", "dest": "/index"},
        ],
        "images": images_cfg,
    }, f, indent=2)
print("Wrote vercel-launcher.config.json + config.json (images block included)")
PYEOF

echo "==> [5/6] Writing .vc-config.json (Lambda runtime config)"
cat > "$OUT/functions/index.func/.vc-config.json" << 'VCEOF'
{
  "handler": "apps/web/vercel-launcher.js",
  "launcherType": "Nodejs",
  "runtime": "nodejs22.x",
  "shouldAddHelpers": false,
  "supportsResponseStreaming": true,
  "maxDuration": 300
}
VCEOF

echo "==> [6/6] Done. .vercel/output is ready:"
du -sh "$OUT"
echo ""
echo "Next: npx vercel deploy --prebuilt --prod --archive=tgz --token \"\$VERCEL_TOKEN\""
