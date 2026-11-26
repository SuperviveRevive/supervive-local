#!/usr/bin/env bash
# Push to GitHub only after the release gate passes. The token comes from the environment
# (GITHUB_TOKEN or GH_TOKEN) and is never written to .git/config.
set -euo pipefail
cd "$(dirname "$0")/.."
bun tools/check-oss.ts
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
[ -n "$TOKEN" ] || { echo "set GITHUB_TOKEN"; exit 1; }
git -c credential.helper= -c "credential.helper=!f() { echo username=x-access-token; echo password=$TOKEN; }; f" push -u origin "$(git branch --show-current)" "$@"
