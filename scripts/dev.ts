// Serves ./dist on a local port, rebuilding on changes under site/, scripts/,
// data/ and mods/.
//
//   bun run dev            http://localhost:4321
//   PORT=5000 bun run dev

import { watch } from 'node:fs'
import { join, extname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PORT ?? 4321)
const BASE = process.env.SITE_BASE ?? '/'

let building: Promise<void> | null = null
async function build() {
  if (building) return building
  building = (async () => {
    const p = Bun.spawn(['bun', 'run', 'scripts/build.ts'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, SITE_BASE: BASE } })
    await p.exited
    building = null
  })()
  return building
}

await build()
let timer: ReturnType<typeof setTimeout> | undefined
for (const dir of ['site', 'scripts', 'data', 'mods']) {
  try {
    watch(join(ROOT, dir), { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(build, 200)
    })
  } catch {}
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' }

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    let path = decodeURIComponent(url.pathname)
    if (BASE !== '/' && path.startsWith(BASE)) path = '/' + path.slice(BASE.length)
    if (path.endsWith('/')) path += 'index.html'
    let file = Bun.file(join(DIST, path))
    if (!(await file.exists())) {
      file = Bun.file(join(DIST, path, 'index.html'))
      if (!(await file.exists())) return new Response(Bun.file(join(DIST, '404.html')), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    return new Response(file, { headers: { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' } })
  },
})
console.log(`slopshopper dev server: http://localhost:${PORT}${BASE}`)
