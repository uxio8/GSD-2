#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
base="${1:-${repo_root}/.gsd}"

printf "=== GSD FILES ===\n"
find "$base" -type f \( \
  -name "*PLAN.md" -o \
  -name "*SUMMARY.md" -o \
  -name "*UAT.md" -o \
  -name "*ASSESSMENT.md" -o \
  -name "STATE.md" -o \
  -name "auto.lock" \
\) -print0 | xargs -0 ls -lt | head -n 60
