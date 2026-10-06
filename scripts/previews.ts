// Builds a preview for every mod in the index and for slopshopper's own mods
// under ./mods: a static report from `claude plugin validate --json`, and a
// dynamic one from the sandboxed harness (scripts/harness). Output goes to
// data/previews/<slug>.json.
//
//   bun run previews              every mod
//   bun run previews <slug> ...   only those
//   bun run previews --force      ignore the freshness check

import { mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import type { Index, ModEntry, Preview } from './lib/types'
import { localMods } from './lib/local-mods'

const ROOT = resolve(import.meta.dir, '..')
const DATA = join(ROOT, 'data')
const PREVIEWS = join(DATA, 'previews')
const SRC = join(ROOT, '.cache', 'src')
const HARNESS = join(ROOT, 'scripts', 'harness', 'run-one.ts')

const args = process.argv.slice(2)
const force = args.includes('--force')
const only = new Set(args.filter(a => !a.startsWith('--')))

async function materialize(mod: ModEntry, files: Record<string, string>): Promise<string> {
  const dir = join(SRC, mod.slug)
  await rm(dir, { recursive: true, force: true })
  for (const [rel, text] of Object.entries(files)) {
    if (rel.includes('..')) continue
    const p = join(dir, rel)
    await mkdir(dirname(p), { recursive: true })
    await Bun.write(p, text)
  }
  // a mod with no manifest still validates with a minimal one
  const manifest = join(dir, '.claude-plugin', 'plugin.json')
  if (!existsSync(manifest)) {
    await mkdir(dirname(manifest), { recursive: true })
    await Bun.write(manifest, JSON.stringify({ name: mod.name, version: mod.version ?? '0.0.0', description: mod.description || mod.name }, null, 2))
  }
  return dir
}

type ValidateJson = {
  success: boolean
  manifest?: { errors: { message: string }[]; warnings: { message: string }[]; notes: string[] }
  contents?: { type: string; errors: { message: string }[]; warnings: { message: string }[]; notes: string[] }[]
}

async function validate(dir: string, retry = true): Promise<Preview['validate']> {
  const first = await validateOnce(dir)
  // the capture holds the mod's files only; a plugin that also ships skills,
  // commands or an MCP file fails on those paths, so stand them in and retry
  const missing = first.errors.map(e => /Path not found: (\.\/\S+)/.exec(e)?.[1]?.replace(/[.,;:]+$/, '')).filter((p): p is string => !!p)
  if (!retry || missing.length === 0) return first
  for (const rel of missing) {
    const p = join(dir, rel)
    if (p.includes('..')) continue
    if (rel.endsWith('/') || !rel.includes('.')) await mkdir(p, { recursive: true })
    else {
      await mkdir(dirname(p), { recursive: true })
      await Bun.write(p, rel.endsWith('.json') ? '{}' : '')
    }
  }
  const second = await validateOnce(dir)
  second.warnings.push(`stood in for ${missing.join(', ')}: the capture holds the mod's own files, not the rest of its plugin`)
  return second
}

async function validateOnce(dir: string): Promise<Preview['validate']> {
  const empty: Preview['validate'] = { ok: false, errors: [], warnings: [], hooks: [], calls: [], stateReads: [], stateWrites: [], envReads: [] }
  const p = Bun.spawn(['claude', 'plugin', 'validate', '--json', dir], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => p.kill(), 30_000)
  const out = await new Response(p.stdout).text()
  await p.exited
  clearTimeout(timer)
  const start = out.indexOf('{')
  if (start < 0) return { ...empty, errors: [`validate produced no report: ${out.slice(0, 200)}`] }
  let j: ValidateJson
  try {
    j = JSON.parse(out.slice(start))
  } catch {
    return { ...empty, errors: ['validate report was not JSON'] }
  }
  const notes = [...(j.manifest?.notes ?? []), ...(j.contents ?? []).flatMap(c => c.notes ?? [])]
  const pick = (label: string) =>
    notes
      .filter(n => n.includes(` ${label}: `))
      .flatMap(n => n.split(` ${label}: `)[1]!.split(/,\s(?![^{]*\})/).map(s => s.trim()))
      .filter(Boolean)
  return {
    ok: j.success,
    errors: [...(j.manifest?.errors ?? []), ...(j.contents ?? []).flatMap(c => c.errors ?? [])].map(e => e.message),
    warnings: [...(j.manifest?.warnings ?? []), ...(j.contents ?? []).flatMap(c => c.warnings ?? [])].map(e => e.message),
    hooks: pick('hooks'),
    calls: pick('calls'),
    stateReads: pick('state reads'),
    stateWrites: pick('state writes'),
    envReads: pick('env reads'),
    raw: j,
  }
}

async function harness(dir: string, mod: ModEntry): Promise<Preview['harness']> {
  const options: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(mod.userConfig ?? {})) if (f && 'default' in f) options[k] = f.default
  const p = Bun.spawn(['bun', 'run', HARNESS, dir, mod.entry, JSON.stringify({ name: mod.name, options })], { stdout: 'pipe', stderr: 'pipe', cwd: ROOT })
  let killed = false
  const timer = setTimeout(() => {
    killed = true
    p.kill()
  }, 20_000)
  const out = await new Response(p.stdout).text()
  const err = await new Response(p.stderr).text()
  await p.exited
  clearTimeout(timer)
  const line = out.trim().split('\n').findLast(l => l.startsWith('{'))
  const base: Preview['harness'] = { ok: false, hooks: [], commands: [], tools: [], panes: [], toasts: [], logs: [], denies: [], rewrites: [], apiCalls: {}, timers: [], sites: {}, script: [], console: [] }
  if (killed) return { ...base, error: 'the mod kept running for 20s in the preview session (a hold loop or a long wait); no drawing was captured' }
  if (!line) return { ...base, error: `harness produced no result (${err.trim().replace(/=+/g, '').trim().slice(0, 300) || 'killed or crashed'})` }
  try {
    return { ...base, ...JSON.parse(line) }
  } catch {
    return { ...base, error: 'harness result was not JSON' }
  }
}

async function main() {
  await mkdir(PREVIEWS, { recursive: true })
  const index = (await Bun.file(join(DATA, 'mods.json')).json()) as Index
  const mods: { mod: ModEntry; files: Record<string, string> }[] = []
  for (const m of index.mods) {
    const f = Bun.file(join(DATA, 'mods', `${m.slug}.json`))
    if (!(await f.exists())) continue
    mods.push({ mod: m, files: ((await f.json()) as { files: Record<string, string> }).files })
  }
  for (const m of await localMods()) mods.push({ mod: m, files: m.files })

  let done = 0
  const queue = mods.filter(({ mod }) => !only.size || only.has(mod.slug))
  const CONCURRENCY = Math.max(1, Number(process.env.PREVIEW_CONCURRENCY ?? 4))
  const one = async ({ mod, files }: { mod: ModEntry; files: Record<string, string> }) => {
    const outPath = join(PREVIEWS, `${mod.slug}.json`)
    if (!force && existsSync(outPath)) {
      const prev = (await Bun.file(outPath).json()) as Preview & { sourceHash?: string }
      if (prev.sourceHash === hashFiles(files)) return
    }
    const dir = await materialize(mod, files)
    const entryMissing = !(mod.entry in files)
    const [v, h] = await Promise.all([
      validate(dir),
      entryMissing
        ? Promise.resolve<Preview['harness']>({ ok: false, error: `hooks.json names ${mod.modules[0]} as the hooks module, but the repository has no such file`, hooks: [], commands: [], tools: [], panes: [], toasts: [], logs: [], denies: [], rewrites: [], apiCalls: {}, timers: [], sites: {}, script: [], console: [] })
        : harness(dir, mod),
    ])
    const preview: Preview & { sourceHash: string } = { slug: mod.slug, generatedAt: new Date().toISOString(), harness: h, validate: v, sourceHash: hashFiles(files) }
    await Bun.write(outPath, JSON.stringify(preview, null, 1))
    done++
    const sites = Object.keys(h.sites ?? {})
    console.log(`${mod.slug}: validate ${v.ok ? 'ok' : 'FAIL'} · harness ${h.ok ? 'ok' : 'FAIL'}${h.error ? ` (${h.error.slice(0, 80)})` : ''} · sites ${sites.join(',') || '-'} · toasts ${h.toasts.length} · denies ${h.denies.length}`)
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const next = queue.shift()!
      try {
        await one(next)
      } catch (err) {
        console.warn(`${next.mod.slug}: preview failed: ${String(err).slice(0, 160)}`)
      }
    }
  }))
  console.log(`previews: ${done} generated, ${mods.length} total`)
  const stale = (await readdir(PREVIEWS)).filter(f => f.endsWith('.json') && !mods.some(m => `${m.mod.slug}.json` === f))
  for (const f of stale) await rm(join(PREVIEWS, f))
}

function hashFiles(files: Record<string, string>): string {
  const keys = Object.keys(files).sort()
  return Bun.hash(keys.map(k => k + '\0' + files[k]).join('\n')).toString(16)
}

await main()
