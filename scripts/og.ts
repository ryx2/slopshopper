// Screenshots the 1200×630 hero card (dist/og/index.html) into
// site/static/og.jpg with a headless Chromium. Serves dist/ on a local port
// first, so the page's site-absolute paths resolve exactly as in production.
// Run after `bun run build`; commit the result.
//
//   bun run scripts/og.ts

import { existsSync, unlinkSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DIST = join(ROOT, 'dist')
const CANDIDATES = [
  process.env.CHROME_PATH ?? '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)
const chrome = CANDIDATES.find(c => existsSync(c))
if (!chrome) {
  console.error('no Chromium found; set CHROME_PATH')
  process.exit(1)
}
if (!existsSync(join(DIST, 'og', 'index.html'))) {
  console.error('dist/og/index.html is missing; run bun run build first')
  process.exit(1)
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname)
    if (path.endsWith('/')) path += 'index.html'
    const file = Bun.file(join(DIST, path))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(file, { headers: { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' } })
  },
})

const png = join(ROOT, '.cache', 'og.png')
const out = join(ROOT, 'site', 'static', 'og.jpg')
if (existsSync(png)) unlinkSync(png)
const args = [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  `--user-data-dir=${join(ROOT, '.cache', 'chrome-profile')}`,
  '--window-size=1200,630', '--force-device-scale-factor=2',
  '--timeout=12000', // give fonts and the photo time to load, then capture and exit
  `--screenshot=${png}`, `http://127.0.0.1:${server.port}/og/`,
]
const proc = Bun.spawn([chrome, ...args], { stdout: 'pipe', stderr: 'pipe' })
const killer = setTimeout(() => proc.kill(), 45_000)
await proc.exited
clearTimeout(killer)
server.stop(true)
if (!existsSync(png)) {
  console.error('screenshot failed:', (await new Response(proc.stderr).text()).slice(-800))
  process.exit(1)
}
// the 2× capture becomes a 1200×630 JPEG
const sips = Bun.spawnSync(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '88', '--resampleWidth', '1200', png, '--out', out], { stdout: 'pipe', stderr: 'pipe' })
if (sips.exitCode !== 0) {
  console.error('sips failed:', new TextDecoder().decode(sips.stderr))
  process.exit(1)
}
console.log(`wrote ${out} (${Math.round(Bun.file(out).size / 1024)}KB) with ${chrome.split('/').pop()}`)
process.exit(0)
