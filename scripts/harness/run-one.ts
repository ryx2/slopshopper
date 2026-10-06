// Child-process entry: bundle one mod's hooks module, run it inside a fresh
// vm realm with the inner harness, print the harness result as JSON.
//
//   bun run scripts/harness/run-one.ts <modDir> <entryRelativeToModDir> [optionsJson]
//
// The vm realm shares no objects with this process: the mod only ever sees
// strings and the harness's own inner-realm functions. This is defence in
// depth, not a security boundary; previews.ts also runs this entry under a
// wall-clock timeout.

import vm from 'node:vm'
import { existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, extname } from 'node:path'

const [modDir, entryRel, optionsJson = '{}'] = process.argv.slice(2)
if (!modDir || !entryRel) {
  console.error('usage: run-one.ts <modDir> <entry> [optionsJson]')
  process.exit(2)
}

const MODULE_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.cts']

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  const tryFile = (p: string) => existsSync(p) && statSync(p).isFile()
  const candidates = [base, ...MODULE_EXTS.map(e => base + e), ...MODULE_EXTS.map(e => join(base, 'index' + e))]
  if (/\.(js|mjs|cjs|jsx)$/.test(base)) candidates.push(base.replace(/\.(js|mjs|cjs|jsx)$/, (_, e) => ({ js: '.ts', mjs: '.mts', cjs: '.cts', jsx: '.tsx' })[e as string]!))
  for (const c of candidates) if (tryFile(c) && MODULE_EXTS.includes(extname(c))) return c
  return null
}

async function bundle(entry: string): Promise<{ code?: string; error?: string; warnings: string[] }> {
  const warnings: string[] = []
  const r = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'cjs',
    minify: false,
    sourcemap: 'none',
    jsx: { runtime: 'classic', factory: 'h', fragment: 'Fragment' } as any,
    external: ['claude-code'],
    plugins: [
      {
        name: 'slopshopper-resolver',
        setup(build) {
          build.onResolve({ filter: /^claude-code(\/.*)?$/ }, args => ({ path: args.path, external: true }))
          build.onResolve({ filter: /^\.{1,2}\// }, args => {
            const p = resolveRelative(args.importer, args.path)
            if (p) return { path: p }
            warnings.push(`unresolved import ${args.path} from ${args.importer.replace(modDir!, '')} (types only?)`)
            return { path: args.path, namespace: 'slop-empty' }
          })
          build.onResolve({ filter: /^[^./]/ }, args => {
            if (/^claude-code/.test(args.path)) return { path: args.path, external: true }
            warnings.push(`bare import ${args.path} is not available to a hooks module; stubbed`)
            return { path: args.path, namespace: 'slop-empty' }
          })
          build.onLoad({ filter: /.*/, namespace: 'slop-empty' }, () => ({ contents: 'export default {}', loader: 'js' }))
        },
      },
    ],
  })
  if (!r.success) return { error: r.logs.map(l => String(l.message)).join('\n').slice(0, 800), warnings }
  const out = r.outputs[0]
  if (!out) return { error: 'no output', warnings }
  return { code: await out.text(), warnings }
}

async function innerHarness(): Promise<string> {
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, 'inner.ts')], target: 'browser', format: 'cjs', minify: false, sourcemap: 'none' })
  if (!r.success) throw new Error('inner harness failed to build: ' + r.logs.map(l => l.message).join('\n'))
  return await r.outputs[0]!.text()
}

const entry = resolve(modDir, entryRel)
const built = await bundle(entry)
if (!built.code) {
  console.log(JSON.stringify({ ok: false, error: `bundle failed: ${built.error}`, warnings: built.warnings }))
  process.exit(0)
}

const ctx = vm.createContext(Object.create(null))
try {
  // no vm `timeout` here: Bun 1.3 panics when its watchdog fires inside a
  // long-running async loop; previews.ts kills this process instead
  vm.runInContext(await innerHarness(), ctx, { filename: 'inner.js' })
  const run = vm.runInContext('globalThis.__slop.run', ctx) as (b: string, o: string) => Promise<string>
  const timeout = new Promise<string>((_, rej) => setTimeout(() => rej(new Error('harness timed out after 15s')), 15_000))
  const json = await Promise.race([run(built.code, optionsJson!), timeout])
  const parsed = JSON.parse(json)
  parsed.warnings = built.warnings
  console.log(JSON.stringify(parsed))
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err).slice(0, 500), warnings: built.warnings }))
}
process.exit(0)
