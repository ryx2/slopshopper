// slopshopper's own mods live in ./mods/<name>. This reads them into the same
// shape the scraper produces for community mods, so previews and the site
// treat both alike.

import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { ModEntry } from './types'

const ROOT = resolve(import.meta.dir, '../..')
const MODS = join(ROOT, 'mods')
const REPO = process.env.SLOPSHOPPER_REPO ?? 'ryx2/slopshopper'
const SKIP_DIRS = new Set(['node_modules', '.claude-plugin/types'])

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const name of await readdir(dir)) {
    const p = join(dir, name)
    const rel = relative(base, p)
    if (SKIP_DIRS.has(name) || SKIP_DIRS.has(rel) || name === 'tsconfig.json') continue
    const s = await stat(p)
    if (s.isDirectory()) out.push(...(await walk(p, base)))
    else if (s.size < 300_000) out.push(rel)
  }
  return out
}

export async function localMods(): Promise<ModEntry[]> {
  if (!existsSync(MODS)) return []
  const out: ModEntry[] = []
  for (const name of (await readdir(MODS)).sort()) {
    const dir = join(MODS, name)
    const manifestPath = join(dir, '.claude-plugin', 'plugin.json')
    const hooksPath = join(dir, 'hooks', 'hooks.json')
    if (!existsSync(manifestPath) || !existsSync(hooksPath)) continue
    const manifest = (await Bun.file(manifestPath).json()) as Record<string, unknown>
    const hooks = (await Bun.file(hooksPath).json()) as { modules?: string[] }
    if (!Array.isArray(hooks.modules) || hooks.modules.length === 0) continue
    const files: Record<string, string> = {}
    for (const rel of await walk(dir)) files[rel] = await Bun.file(join(dir, rel)).text()
    const gitDate = (p: string) => {
      const r = Bun.spawnSync(['git', 'log', '-1', '--format=%cI', '--', p], { cwd: ROOT })
      return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : ''
    }
    const firstDate = (p: string) => {
      const r = Bun.spawnSync(['git', 'log', '--diff-filter=A', '--format=%cI', '--reverse', '--', p], { cwd: ROOT })
      return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim().split('\n')[0] ?? '' : ''
    }
    const now = new Date().toISOString()
    out.push({
      slug: `slopshopper-${name}`,
      name: String(manifest.name ?? name),
      displayName: typeof manifest.displayName === 'string' ? manifest.displayName : undefined,
      description: String(manifest.description ?? ''),
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
      author: (manifest.author as ModEntry['author']) ?? { name: 'slopshopper' },
      license: typeof manifest.license === 'string' ? manifest.license : 'MIT',
      homepage: typeof manifest.homepage === 'string' ? manifest.homepage : `https://slopshopper.com/mods/slopshopper-${name}/`,
      keywords: Array.isArray(manifest.keywords) ? (manifest.keywords as string[]) : [],
      kind: 'slopshopper',
      repo: {
        fullName: REPO,
        url: `https://github.com/${REPO}`,
        stars: 0,
        forks: 0,
        license: 'MIT',
        pushedAt: gitDate('.') || now,
        createdAt: firstDate('.') || now,
        description: 'The open-source shop for Claude Code mods',
        homepage: 'https://slopshopper.com',
        topics: ['claude-code', 'claude-code-mods'],
        archived: false,
        ownerAvatar: '',
        ownerUrl: `https://github.com/${REPO.split('/')[0]}`,
        defaultBranch: 'main',
      },
      path: `mods/${name}`,
      modules: hooks.modules,
      entry: join('hooks', hooks.modules[0]!).replace(/^hooks\/\.\//, 'hooks/'),
      userConfig: manifest.userConfig as ModEntry['userConfig'],
      hasTypes: existsSync(join(dir, 'types', 'index.d.ts')),
      hasTests: Object.keys(files).some(f => /\.test\.tsx?$/.test(f)),
      hasMarketplace: true,
      marketplaceName: 'slopshopper',
      readme: existsSync(join(dir, 'README.md')) ? await Bun.file(join(dir, 'README.md')).text() : undefined,
      firstSeen: firstDate(`mods/${name}`) || now,
      modUpdatedAt: gitDate(`mods/${name}`) || now,
      files,
      fileBytes: Object.values(files).reduce((n, t) => n + t.length, 0),
    })
  }
  return out
}
