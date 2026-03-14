#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

echo "==> Packing tarball..."
TARBALL_NAME="$(npm pack --ignore-scripts 2>/dev/null | tail -1)"
TARBALL="$ROOT/$TARBALL_NAME"

if [ ! -f "$TARBALL" ]; then
  echo "ERROR: npm pack produced no tarball"
  exit 1
fi

INSTALL_DIR="$(mktemp -d)"
TAR_LIST="$(mktemp)"
trap 'rm -rf "$INSTALL_DIR" "$TARBALL" "$TAR_LIST"' EXIT

echo "==> Tarball: $TARBALL_NAME"

tar tzf "$TARBALL" > "$TAR_LIST" 2>/dev/null

MISSING=0
for required in dist/loader.js packages/native/dist/index.js scripts/link-workspace-packages.cjs; do
  if ! grep -q "package/${required}" "$TAR_LIST"; then
    echo "    MISSING: $required"
    MISSING=1
  fi
done

if [ "$MISSING" = "1" ]; then
  echo "ERROR: Critical files missing from tarball."
  exit 1
fi

echo "==> Testing isolated install..."
cd "$INSTALL_DIR"
npm init -y > /dev/null 2>&1
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install "$TARBALL" > /dev/null

cd "$INSTALL_DIR/node_modules/gsd-pi"
node --input-type=module -e '
  import { xxHash32 } from "@gsd/native/xxhash";
  if (typeof xxHash32 !== "function") {
    throw new Error("workspace package link missing");
  }
'

echo "Package is installable."
