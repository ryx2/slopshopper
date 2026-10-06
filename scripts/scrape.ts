// Scrapes GitHub for Claude Code mods and writes data/mods.json plus one
// data/mods/<slug>.json per mod (its source files, for the preview harness).
//
// A mod is a plugin whose hooks/hooks.json names a `modules` array. That is
// the ground truth here: every candidate repository's tree is walked and each
// hooks.json is read before anything is listed.
//
//   bun run scrape                      discover, walk every candidate, write the index
//   bun run scrape --repo o/r           only that repository (merged into the index)
//   bun run scrape --fast               skip repositories whose pushed_at is unchanged
//   bun run scrape --discover-only      write .cache/candidates.json and stop
//   bun run scrape --shard 2/4 --out .cache/shards/2.json
//                                       walk every fourth candidate (from the saved list)
//   bun run scrape --merge              merge .cache/shards/*.json into the index

import { mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { lastCommitDate, rawFile, repoMeta, repoTree, searchCode, searchRepos, type RepoMeta, type TreeEntry } from './lib/github'
import type { Index, ModEntry, ModKind } from './lib/types'

const ROOT = resolve(import.meta.dir, '..')
const DATA = join(ROOT, 'data')
const MODS_DIR = join(DATA, 'mods')
const INDEX_PATH = join(DATA, 'mods.json')
const CANDIDATES_PATH = join(ROOT, '.cache', 'candidates.json')
const SHARDS_DIR = join(ROOT, '.cache', 'shards')
const MAX_FILES = 90
const MAX_BYTES = 1_500_000
const MODULE_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.cts']

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const only = flag('--repo')
const fast = args.includes('--fast')
const discoverOnly = args.includes('--discover-only')
const shard = flag('--shard')
const out = flag('--out')
const merge = args.includes('--merge')

// Repositories never listed: the user's own project, and tooling that vendors mods.
const EXCLUDE_REPOS = new Set<string>(['ryx2/slopshopper'])
// Known sources that get a special kind.
const KIND_OVERRIDES: Record<string, ModKind> = {
  'anthropics/claude-code': 'builtin',
  'anthropics/claude-code-playground': 'sample',
}

const DISCOVERY_QUERIES = [
  '"modules" filename:hooks.json',
  '"modules" filename:hooks.json path:hooks',
  '"modules" filename:hooks.json path:.claude',
  '"modules" filename:hooks.json path:plugins',
  '"modules" filename:hooks.json path:mods',
  '"modules" filename:hooks.json path:packages',
  '"claude-code/testing"',
  '"from \'claude-code\'" register',
  '"from \\"claude-code\\"" register',
  '"$.ui.resolve"',
  '"ui.render" "AbovePrompt"',
]
const REPO_QUERIES = [
  'topic:claude-code-mod',
  'topic:claude-code-mods',
  'topic:claude-mods',
  'topic:claude-mod',
  '"claude code mod" in:name,description',
  '"claude code mods" in:name,description',
]

async function loadIndex(): Promise<Index> {
  const f = Bun.file(INDEX_PATH)
  if (await f.exists()) return (await f.json()) as Index
  return { generatedAt: new Date(0).toISOString(), mods: [] }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // tolerate // and /* */ comments and trailing commas
    try {
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')
      return JSON.parse(stripped)
    } catch {
      return null
    }
  }
}

/** Relative import specifiers in a module's source. */
function relativeImports(src: string): string[] {
  const out = new Set<string>()
  const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.add(m[1]!)
  const re2 = /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g
  while ((m = re2.exec(src))) out.add(m[1]!)
  return [...out]
}

function resolveModulePath(blobs: Set<string>, fromDir: string, spec: string): string | null {
  const base = posix.normalize(posix.join(fromDir, spec))
  const candidates = [base, ...MODULE_EXTS.map(e => base + e), ...MODULE_EXTS.map(e => posix.join(base, 'index' + e))]
  // a TS import of './x.js' resolves to x.ts or x.tsx
  if (/\.(js|mjs|cjs|jsx)$/.test(base)) {
    const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '')
    candidates.push(stem + '.ts', stem + '.tsx', stem + '.mts', stem + '.cts')
  }
  // a query or hash on the specifier is dropped
  if (/[?#]/.test(base)) candidates.push(base.replace(/[?#].*$/, ''))
  for (const c of candidates) if (blobs.has(c)) return c
  return null
}

type HooksJson = { modules?: unknown; description?: string }

async function collectMod(meta: RepoMeta, tree: TreeEntry[], hooksJsonPath: string, wantCommitDate: boolean): Promise<ModEntry | null> {
  const fullName = meta.full_name
  const ref = meta.default_branch
  const blobs = new Set(tree.filter(t => t.type === 'blob').map(t => t.path))
  const hooksText = await rawFile(fullName, ref, hooksJsonPath)
  if (!hooksText) return null
  const hooks = parseJsonLoose(hooksText) as HooksJson | null
  if (!hooks || !Array.isArray(hooks.modules) || hooks.modules.length === 0) return null
  const modules = hooks.modules.filter((m): m is string => typeof m === 'string')
  if (modules.length === 0) return null

  const hooksDir = posix.dirname(hooksJsonPath) // .../hooks
  const modRoot = posix.dirname(hooksDir) === '.' ? '' : posix.dirname(hooksDir)
  const rel = (p: string) => (modRoot ? posix.join(modRoot, p) : p)

  // manifest
  let manifest: Record<string, unknown> = {}
  const manifestPath = rel('.claude-plugin/plugin.json')
  if (blobs.has(manifestPath)) {
    const t = await rawFile(fullName, ref, manifestPath)
    const j = t ? parseJsonLoose(t) : null
    if (j && typeof j === 'object') manifest = j as Record<string, unknown>
  }
  const dirName = modRoot ? posix.basename(modRoot) : meta.full_name.split('/')[1]!
  const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : dirName

  // source files: each module and its relative imports, bounded
  const files: Record<string, string> = {}
  let bytes = 0
  const queue: string[] = []
  for (const m of modules) {
    const p = resolveModulePath(blobs, hooksDir, m.startsWith('.') ? m : './' + m)
    if (p) queue.push(p)
  }
  const seen = new Set<string>()
  while (queue.length && seen.size < MAX_FILES && bytes < MAX_BYTES) {
    const p = queue.shift()!
    if (seen.has(p)) continue
    seen.add(p)
    const text = await rawFile(fullName, ref, p, 200_000)
    if (text === null) continue
    files[modRoot ? posix.relative(modRoot, p) : p] = text
    bytes += text.length
    for (const spec of relativeImports(text)) {
      const r = resolveModulePath(blobs, posix.dirname(p), spec)
      if (r && !seen.has(r)) queue.push(r)
    }
  }
  const entryModule = modules[0]!
  const entry = posix.normalize(posix.join('hooks', entryModule))
  files['hooks/hooks.json'] = hooksText
  if (Object.keys(manifest).length) files['.claude-plugin/plugin.json'] = JSON.stringify(manifest, null, 2)

  // types contract
  const typesRel = typeof manifest.types === 'string' ? posix.normalize(manifest.types.replace(/^\.\//, '')) : 'types/index.d.ts'
  const typesPath = rel(typesRel)
  const hasTypes = blobs.has(typesPath)
  if (hasTypes) {
    const t = await rawFile(fullName, ref, typesPath, 100_000)
    if (t) files[typesRel] = t
  }
  const hasTests = [...blobs].some(p => (modRoot ? p.startsWith(modRoot + '/') : true) && /\.test\.tsx?$/.test(p))

  // README: the mod's own, else the repo's
  let readme: string | undefined
  for (const cand of [rel('README.md'), rel('readme.md'), 'README.md', 'readme.md']) {
    if (blobs.has(cand)) {
      const t = await rawFile(fullName, ref, cand, 200_000)
      if (t) {
        readme = t.slice(0, 24_000)
        break
      }
    }
  }

  const marketplacePath = rel('.claude-plugin/marketplace.json')
  const hasMarketplace = blobs.has(marketplacePath) || blobs.has('.claude-plugin/marketplace.json')
  let marketplaceName: string | undefined
  if (hasMarketplace) {
    const t = await rawFile(fullName, ref, blobs.has(marketplacePath) ? marketplacePath : '.claude-plugin/marketplace.json', 100_000)
    const j = t ? (parseJsonLoose(t) as { name?: string } | null) : null
    if (j && typeof j.name === 'string') marketplaceName = j.name
  }

  // the mod's own last commit matters in a monorepo; a root mod moves with the repo
  const modUpdatedAt = (wantCommitDate && modRoot ? await lastCommitDate(fullName, modRoot) : null) ?? meta.pushed_at
  const author = manifest.author && typeof manifest.author === 'object' ? (manifest.author as ModEntry['author']) : undefined
  const slugBase = modRoot ? `${meta.owner.login}--${fullName.split('/')[1]}--${name}` : `${meta.owner.login}--${fullName.split('/')[1]}`
  const kind: ModKind = KIND_OVERRIDES[fullName] ?? 'community'

  return {
    slug: slugify(slugBase),
    name,
    displayName: typeof manifest.displayName === 'string' ? manifest.displayName : undefined,
    description:
      (typeof manifest.description === 'string' && manifest.description) || (typeof hooks.description === 'string' && hooks.description) || meta.description || '',
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    author,
    license: (typeof manifest.license === 'string' && manifest.license) || meta.license?.spdx_id || undefined,
    homepage: typeof manifest.homepage === 'string' ? manifest.homepage : meta.homepage || undefined,
    keywords: Array.isArray(manifest.keywords) ? (manifest.keywords as unknown[]).filter((k): k is string => typeof k === 'string') : [],
    kind,
    repo: {
      fullName,
      url: meta.html_url,
      stars: meta.stargazers_count,
      forks: meta.forks_count,
      license: meta.license?.spdx_id && meta.license.spdx_id !== 'NOASSERTION' ? meta.license.spdx_id : meta.license ? meta.license.name : null,
      pushedAt: meta.pushed_at,
      createdAt: meta.created_at,
      description: meta.description,
      homepage: meta.homepage,
      topics: meta.topics ?? [],
      archived: meta.archived,
      ownerAvatar: meta.owner.avatar_url,
      ownerUrl: meta.owner.html_url,
      defaultBranch: meta.default_branch,
    },
    path: modRoot,
    modules,
    entry,
    userConfig: manifest.userConfig && typeof manifest.userConfig === 'object' ? (manifest.userConfig as ModEntry['userConfig']) : undefined,
    hasTypes,
    hasTests,
    hasMarketplace,
    marketplaceName,
    readme,
    firstSeen: new Date().toISOString(),
    modUpdatedAt,
    files,
    fileBytes: bytes,
  }
}

async function discover(previousRepos: Iterable<string>): Promise<string[]> {
  const candidates = new Set<string>()
  console.log('discovery: code search')
  for (const q of DISCOVERY_QUERIES) {
    for (const items of [await searchCode(q), await searchCode(q, { sort: 'indexed', order: 'desc' })]) {
      for (const it of items) if (!it.repository.private) candidates.add(it.repository.full_name)
    }
  }
  console.log('discovery: repo search')
  for (const q of REPO_QUERIES) for (const r of await searchRepos(q)) candidates.add(r)
  // keep every repo already in the index so nothing silently drops out
  for (const r of previousRepos) candidates.add(r)
  for (const r of EXCLUDE_REPOS) candidates.delete(r)
  const list = [...candidates].sort()
  await mkdir(join(ROOT, '.cache'), { recursive: true })
  await Bun.write(CANDIDATES_PATH, JSON.stringify({ at: new Date().toISOString(), repos: list }, null, 1))
  console.log(`candidates: ${list.length} repositories → ${CANDIDATES_PATH}`)
  return list
}

/** Walks each candidate repository and returns every mod found. */
async function walk(candidates: string[], priorByRepo: Map<string, ModEntry[]>, label = ''): Promise<ModEntry[]> {
  const mods: ModEntry[] = []
  let i = 0
  for (const fullName of candidates) {
    i++
    const meta = await repoMeta(fullName)
    if (!meta) continue
    if (meta.fork && meta.stargazers_count < 5) continue
    const priorMods = priorByRepo.get(fullName) ?? []
    if (fast && priorMods.length && priorMods[0]!.repo.pushedAt === meta.pushed_at) {
      mods.push(...priorMods)
      continue
    }
    const tree = await repoTree(fullName, meta.default_branch)
    if (!tree) continue
    const hooksJsons = tree.filter(t => t.type === 'blob' && /(^|\/)hooks\/hooks\.json$/.test(t.path) && !t.path.includes('node_modules/')).map(t => t.path)
    if (hooksJsons.length === 0) continue
    let found = 0
    for (const hj of hooksJsons.slice(0, 60)) {
      try {
        const entry = await collectMod(meta, tree, hj, hooksJsons.length > 1)
        if (!entry) continue
        mods.push(entry)
        found++
      } catch (err) {
        console.warn(`  ${fullName} ${hj}: ${String(err).slice(0, 120)}`)
      }
    }
    if (found) console.log(`${label}[${i}/${candidates.length}] ${fullName}: ${found} mod${found === 1 ? '' : 's'}`)
  }
  return mods
}

/** Writes the index: file bodies go to data/mods/<slug>.json, the rest to data/mods.json. */
async function writeIndex(mods: ModEntry[], previous: Index): Promise<void> {
  const priorBySlug = new Map(previous.mods.map(m => [m.slug, m]))
  // de-dupe slugs (two mods with one name inside one repo)
  const seen = new Map<string, number>()
  for (const m of mods) {
    const n = (seen.get(m.slug) ?? 0) + 1
    seen.set(m.slug, n)
    if (n > 1) m.slug = `${m.slug}-${n}`
  }
  for (const m of mods) {
    const prior = priorBySlug.get(m.slug)
    if (prior) m.firstSeen = prior.firstSeen
  }
  mods.sort((a, b) => b.repo.stars - a.repo.stars || a.slug.localeCompare(b.slug))
  await mkdir(MODS_DIR, { recursive: true })
  const index: Index = { generatedAt: new Date().toISOString(), mods: mods.map(m => ({ ...m, files: {} })) }
  await Bun.write(INDEX_PATH, JSON.stringify(index, null, 1))
  const keep = new Set<string>()
  for (const m of mods) {
    keep.add(`${m.slug}.json`)
    if (Object.keys(m.files).length === 0) continue // carried over; its file is already on disk
    await Bun.write(join(MODS_DIR, `${m.slug}.json`), JSON.stringify({ slug: m.slug, files: m.files }, null, 1))
  }
  for (const f of await readdir(MODS_DIR)) if (f.endsWith('.json') && !keep.has(f)) await Bun.file(join(MODS_DIR, f)).delete()
  console.log(`wrote ${mods.length} mods to ${INDEX_PATH}`)
}

async function main() {
  const previous = await loadIndex()
  const priorByRepo = new Map<string, ModEntry[]>()
  for (const m of previous.mods) priorByRepo.set(m.repo.fullName, [...(priorByRepo.get(m.repo.fullName) ?? []), m])

  if (merge) {
    const mods: ModEntry[] = []
    const covered = new Set<string>()
    for (const f of (await readdir(SHARDS_DIR)).filter(f => f.endsWith('.json')).sort()) {
      const j = (await Bun.file(join(SHARDS_DIR, f)).json()) as { candidates: string[]; mods: ModEntry[] }
      for (const c of j.candidates) covered.add(c)
      mods.push(...j.mods)
    }
    // repositories no shard covered keep their previous entries
    for (const [repo, list] of priorByRepo) if (!covered.has(repo)) mods.push(...list)
    await writeIndex(mods, previous)
    return
  }

  if (only) {
    const mods = await walk([only], priorByRepo)
    for (const m of previous.mods) if (m.repo.fullName !== only) mods.push(m)
    await writeIndex(mods, previous)
    return
  }

  let candidates: string[]
  if (shard && existsSync(CANDIDATES_PATH)) candidates = ((await Bun.file(CANDIDATES_PATH).json()) as { repos: string[] }).repos
  else candidates = await discover(priorByRepo.keys())
  if (discoverOnly) return

  let label = ''
  if (shard) {
    const [k, n] = shard.split('/').map(Number)
    if (!Number.isInteger(k) || !Number.isInteger(n) || n! < 1 || k! < 0 || k! >= n!) throw new Error(`bad --shard ${shard}; use k/n with 0 <= k < n`)
    candidates = candidates.filter((_, i) => i % n! === k)
    label = `shard ${k}/${n} `
  }
  const mods = await walk(candidates, priorByRepo, label)
  if (out) {
    await mkdir(resolve(ROOT, out, '..'), { recursive: true })
    await Bun.write(resolve(ROOT, out), JSON.stringify({ candidates, mods }, null, 1))
    console.log(`${label}wrote ${mods.length} mods from ${candidates.length} candidates to ${out}`)
    return
  }
  await writeIndex(mods, previous)
}

await main()
