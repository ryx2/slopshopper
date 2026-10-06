// One-off (and idempotent) scrub of the stored data: secret-shaped strings in
// captured source files and READMEs are replaced by labeled markers.
//
//   bun run scripts/redact-data.ts

import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { redactFiles, redactText } from './lib/redact'
import type { Index } from './lib/types'

const ROOT = resolve(import.meta.dir, '..')
const DATA = join(ROOT, 'data')

let changedFiles = 0
let changedReadmes = 0
const byKind = new Map<string, number>()
for (const f of await readdir(join(DATA, 'mods'))) {
  if (!f.endsWith('.json')) continue
  const p = join(DATA, 'mods', f)
  const j = (await Bun.file(p).json()) as { slug: string; files: Record<string, string> }
  const r = redactFiles(j.files)
  if (r.kinds.length === 0) continue
  for (const k of r.kinds) byKind.set(k, (byKind.get(k) ?? 0) + 1)
  await Bun.write(p, JSON.stringify({ slug: j.slug, files: r.files }, null, 1))
  changedFiles++
}
const indexPath = join(DATA, 'mods.json')
const index = (await Bun.file(indexPath).json()) as Index
for (const m of index.mods) {
  if (!m.readme) continue
  const r = redactText(m.readme)
  if (r.kinds.length === 0) continue
  m.readme = r.text
  for (const k of r.kinds) byKind.set(k, (byKind.get(k) ?? 0) + 1)
  changedReadmes++
}
await Bun.write(indexPath, JSON.stringify(index, null, 1))
console.log(`redacted ${changedFiles} source captures and ${changedReadmes} READMEs`)
for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`)
