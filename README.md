# slopshopper

**The mod shop for Claude Code.** [slopshopper.com](https://slopshopper.com) scrapes GitHub every day for [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview), renders a preview of what each one does to your terminal, and gives you the two commands to install it. This repository is the whole thing: the scraper, the preview harness, the static site, and six mods of our own.

## Install the mods

```bash
claude plugin marketplace add ryx2/slopshopper
claude plugin install slop-detector@slopshopper
```

| Mod | What it does |
| --- | --- |
| [`slop-detector`](mods/slop-detector) | Refuses an edit that replaces code with `// ... rest of the code`; tracks TODO stubs, debug prints and other leftovers above the prompt and in `/slop`. |
| [`burn-rate`](mods/burn-rate) | A fuel gauge above the prompt: context fill, tokens, dollars, dollars per hour, your plan's window, a sparkline of the last turns. |
| [`secret-shield`](mods/secret-shield) | Redacts API keys, tokens and private keys from tool results before Claude reads them; refuses writes and commands that embed one. |
| [`tripwire`](mods/tripwire) | Holds `rm -rf`, force pushes, `git reset --hard`, `DROP TABLE`, `curl \| sh`, `sudo` and `.env` edits behind a question; refuses the unrecoverable ones. |
| [`receipts`](mods/receipts) | A ledger of files touched and commands run, counted on the spinner, printed as Markdown by `/receipts`. |
| [`test-pulse`](mods/test-pulse) | Runs the test suite after every turn that changed source and keeps the result above the prompt. |

Every community mod the site lists is also installable through one generated marketplace that points at each author's own repository:

```bash
claude plugin marketplace add https://slopshopper.com/community/marketplace.json
claude plugin install <name>@slopshopper-community
```

Mods need Claude Code 2.1.287 or later. A mod runs with your permissions; read it before you install it.

## How it works

```text
scripts/scrape.ts      GitHub code search + repo search → walk each repo's tree →
                       every hooks/hooks.json with a `modules` array is a mod →
                       data/mods.json + data/mods/<slug>.json (source files)
scripts/previews.ts    claude plugin validate --json (static facts) +
                       scripts/harness (a sandboxed replay of a scripted session) →
                       data/previews/<slug>.json
scripts/build.ts       → dist/  (index, one page per mod, /new, /about, feed.xml,
                       api/mods.json, community/marketplace.json)
```

The harness bundles a mod's hooks module and runs it in a fresh `node:vm` realm with a fake mods API: a session start, a prompt, a turn with reads, edits, a failing test run, a risky shell command and a `cat .env`, then `turn.complete` and `session.measure`. Every render site is then asked to draw, and a small text-grid layout engine draws the returned trees the way the terminal would. Previews show the shape of a mod, not its behaviour on your machine; the facts panel comes from `claude plugin validate`.

## Run it

```bash
bun install
bun run scrape        # GitHub token from GITHUB_TOKEN, GH_TOKEN or `gh auth token`
bun run previews      # needs the claude CLI on PATH
bun run build
bun run dev           # http://localhost:4321
```

`bun run scrape --repo owner/name` indexes one repository; `--fast` skips repositories whose `pushed_at` is unchanged. Previews are cached by a hash of the mod's source; `bun run previews --force` regenerates them.

The GitHub Actions workflow in `.github/workflows/site.yml` runs the scrape daily, commits the refreshed data, builds the site and deploys it to GitHub Pages. Set the repository variable `SITE_BASE` to `/slopshopper/` for a project page or `/` for a custom domain, and `SITE_URL` to match. A `SCRAPE_TOKEN` secret (a classic PAT with `public_repo`) lets code search run in CI; without it the scheduled job still refreshes known repositories.

### Hosting

slopshopper.com is served by the Vercel project `slopshopper` (static build: `vercel.json` sets `bun run build` and `dist/`), which is git-connected to this repository, so every push to `main`, including the daily data commit, redeploys it. The project's environment sets `SITE_BASE=/` and `SITE_URL=https://www.slopshopper.com` (the apex redirects to www, as it did before). The GitHub Actions workflow also publishes a mirror to GitHub Pages under `/slopshopper/`, whose pages declare slopshopper.com as canonical.

A scrape run on a laptop (`bun run scrape`) can take an hour; `bun run scrape --discover-only` followed by four `--shard k/4 --out .cache/shards/k.json` processes and `bun run scrape --merge` does the same work in parallel. `scripts/publish-data.sh` merges, regenerates previews and builds.

## Writing a mod

Each mod under `mods/` is a complete plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming the module, the module, a `types/index.d.ts` state contract, tests, and a README. Check one with:

```bash
claude plugin validate --strict mods/tripwire
claude plugin test mods/tripwire
claude --plugin-dir mods/tripwire
```

## License

MIT for everything in this repository. Community mods are listed under their own licenses.
