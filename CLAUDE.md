# slopshopper

The mod shop for Claude Code: scraper → sandboxed previews → static site, plus six original mods under `mods/`. Live at https://www.slopshopper.com (Vercel project `slopshopper`, git-connected to `ryx2/slopshopper`, so every push to `main` deploys).

## Push as soon as there are code changes

Every code change gets committed and pushed right away: stage, commit with a clear message, `git pull --rebase origin main` (the daily workflow commits data refreshes), push. Do not batch changes or wait for the end of a task. Never commit secrets; captured sources go through `scripts/lib/redact.ts`, and test fixtures assemble fake keys at runtime (GitHub push protection rejects secret-shaped strings).

## Commands

- `bun run build` → `dist/` (atomic swap). `SITE_BASE` and `SITE_URL` env vars set the base path and canonical host.
- `bun run dev` → http://localhost:4321 (the desktop app's launch entry "slopshopper" uses port 4360), rebuilds on changes.
- `bun run scrape` (full), `--repo o/r`, `--fast`, `--discover-only`, `--shard k/4 --out .cache/shards/k.json`, `--merge`.
- `bun run previews` (needs the `claude` CLI; cached by source hash; `--force` to redo).
- `bun run scripts/og.ts` after a build: screenshots `dist/og/index.html` with headless Chrome into `site/static/og.jpg`, the social card. Re-run and commit it whenever the hero changes.
- `claude plugin validate --strict mods/<name>` and `claude plugin test mods/<name>` for the original mods.

## Layout

- `scripts/scrape.ts`, `scripts/lib/github.ts`: discovery and capture. A mod is a `hooks/hooks.json` with a `modules` array.
- `scripts/harness/`: the vm-realm preview harness (`inner.ts` runs inside the sandbox; nothing from the host realm is handed to the mod).
- `scripts/lib/render.ts`, `mockup.ts`: element trees → terminal HTML.
- `scripts/build.ts`: every page template; `site/static/`: CSS, JS, the six photos.
- `data/`: the index (`mods.json`), per-mod sources (`mods/`), previews. ~130MB, refreshed daily by `.github/workflows/site.yml`.
