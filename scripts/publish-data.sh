#!/usr/bin/env bash
# Merge shard outputs, regenerate previews, build, and report counts.
set -euo pipefail
cd "$(dirname "$0")/.."
bun run scripts/scrape.ts --merge
bun run scripts/previews.ts
bun run scripts/build.ts
echo "mods in index: $(jq '.mods | length' data/mods.json)"
echo "previews: $(ls data/previews | wc -l | tr -d ' ')"
echo "validate failures: $(for f in data/previews/*.json; do jq -r 'select(.validate.ok==false) | .slug' "$f"; done | wc -l | tr -d ' ')"
echo "harness failures: $(for f in data/previews/*.json; do jq -r 'select(.harness.ok==false) | .slug' "$f"; done | wc -l | tr -d ' ')"
