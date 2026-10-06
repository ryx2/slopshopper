// Static site generator: data/mods.json + data/previews/*.json + ./mods → dist/
//
//   bun run build
//   SITE_BASE=/slopshopper/ bun run build     (GitHub Pages project path)

import { mkdir, rm, cp, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Index, ModEntry, Preview } from './lib/types'
import { localMods } from './lib/local-mods'
import { mockup, siteHtml } from './lib/mockup'
import { esc } from './lib/render'
import { markdown } from './lib/md'

const ROOT = resolve(import.meta.dir, '..')
const DATA = join(ROOT, 'data')
const DIST = join(ROOT, 'dist')
const BASE = (process.env.SITE_BASE ?? '/').replace(/\/?$/, '/')
const SITE_URL = (process.env.SITE_URL ?? 'https://slopshopper.com').replace(/\/$/, '')
const REPO = process.env.SLOPSHOPPER_REPO ?? 'ryx2/slopshopper'
const COMMUNITY_MARKETPLACE_URL = `${SITE_URL}${BASE}community/marketplace.json`.replace(/([^:])\/\//g, '$1/')
const NEW_DAYS = 7

type View = {
  mod: ModEntry
  preview: Preview | null
  tags: string[]
  isNew: boolean
  rank: number
  thumb: string
  mock: ReturnType<typeof mockup> | null
  install: { label: string; cmds: string[]; note?: string }[]
  entryName: string
  stars: number
  updated: string
}

const u = (p: string) => BASE + p.replace(/^\//, '')
const img = (name: string, cls = 'bg', alt = '') => `<img class="${cls}" src="${u('img/' + name)}" alt="${esc(alt)}" decoding="async">`
const fmtDate = (iso: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : '')
const num = (n: number) => n.toLocaleString('en-US')
const ago = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 86_400_000
  if (d < 1) return 'today'
  if (d < 2) return '1d'
  if (d < 30) return `${Math.floor(d)}d`
  if (d < 365) return `${Math.floor(d / 30)}mo`
  return `${Math.floor(d / 365)}y`
}
const title = (m: ModEntry) => m.displayName ?? m.name
const oneLine = (s: string, n = 110) => {
  const t = s.replace(/\s+/g, ' ').trim()
  const cut = t.length > n ? t.slice(0, n).replace(/[\s,;:.]+\S*$/, '') + '…' : t
  return cut || 'No description.'
}

function tagsOf(m: ModEntry, p: Preview | null): string[] {
  const tags = new Set<string>()
  const h = p?.harness
  const vh = p?.validate.hooks ?? []
  const vc = p?.validate.calls ?? []
  const hooks = (h?.hooks ?? []).map(x => x.event)
  const site = (c: string) => vh.some(x => x.startsWith(`ui.render{component=${c}`)) || (h?.hooks ?? []).some(x => x.event === 'ui.render' && (!x.matcher || x.matcher.component === undefined || x.matcher.component === c || (Array.isArray(x.matcher.component) && x.matcher.component.includes(c))))
  if (site('Pane') || h?.panes.length) tags.add('pane')
  if (site('AbovePrompt')) tags.add('band')
  if (site('Spinner') || site('TurnDuration') || site('PromptHint') || site('SessionMode') || site('InfoNotice')) tags.add('spinner')
  if (site('UserMessage') || site('AssistantMessage') || site('ToolUse') || site('ToolResult') || site('ToolGroup') || site('CommandOutput') || site('AskUserQuestion')) tags.add('transcript')
  if (h?.toasts.length || vc.some(c => c.startsWith('$.ui.toast'))) tags.add('toast')
  if (h?.status || vc.some(c => c.startsWith('$.ui.status'))) tags.add('status')
  if (h?.denies.length || hooks.includes('tool.call') || hooks.includes('tool.check') || vh.some(x => x.startsWith('tool.call') || x.startsWith('tool.check'))) tags.add('guard')
  if (h?.commands.length || vc.some(c => c.startsWith('$.command.register'))) tags.add('command')
  if (hooks.some(x => x.startsWith('prompt.')) || vh.some(x => x.startsWith('prompt.') || x.startsWith('skill.prompt'))) tags.add('prompt')
  if (h?.tools.length || vc.some(c => c.startsWith('$.tool.register'))) tags.add('tool')
  if (vc.some(c => c.startsWith('$.model.'))) tags.add('model')
  if (vc.some(c => c.startsWith('$.process.'))) tags.add('process')
  if (vc.some(c => c.startsWith('$.http.'))) tags.add('network')
  if (h?.timers.length || vc.some(c => c.startsWith('$.clock.every') || c.startsWith('$.clock.after'))) tags.add('timer')
  if (hooks.some(x => x.startsWith('turn.')) || vh.some(x => x.startsWith('turn.'))) tags.add('turn')
  if (hooks.some(x => x.startsWith('session.')) && !hooks.every(x => x === 'session.start')) tags.add('session')
  if (hooks.some(x => x.startsWith('agent.')) || vh.some(x => x.startsWith('agent.'))) tags.add('agents')
  if (vc.some(c => c.startsWith('$.audio.'))) tags.add('audio')
  if (m.kind === 'slopshopper') tags.add('original')
  if (m.kind === 'builtin') tags.add('builtin')
  if (m.kind === 'sample') tags.add('sample')
  return [...tags]
}

const TAG_LABELS: Record<string, string> = { pane: 'pane', band: 'band', spinner: 'spinner', transcript: 'rows', toast: 'toast', status: 'status', guard: 'guard', command: 'command', prompt: 'prompt', tool: 'tool', model: 'model', process: 'process', network: 'network', timer: 'timer', turn: 'turn', session: 'session', agents: 'agents', audio: 'audio', original: 'original', builtin: 'built-in', sample: 'sample', new: 'new' }
const FILTER_TAGS = ['pane', 'band', 'guard', 'command', 'toast', 'spinner', 'transcript', 'prompt', 'status', 'tool', 'model', 'process', 'original', 'new']

function thumbOf(p: Preview | null, m: ModEntry, tags: string[]): string {
  const s = p?.harness.sites ?? {}
  const band = siteHtml(s.AbovePrompt, 62, 4)
  if (band) return `<div class="tty">${band}</div><div class="fade"></div>`
  const pane = Object.values(s.Pane ?? {}).map(r => siteHtml(r, 46, 9)).find(Boolean)
  if (pane) return `<div class="tty">${pane}</div><div class="fade"></div>`
  const spinner = siteHtml(s.Spinner, 60, 2)
  if (spinner) return `<div class="tty">${spinner}</div>`
  const sp = (s.Spinner as { ok?: unknown; props?: { word?: string; suffix?: string } } | undefined)
  if (sp?.ok === 'engine' && sp.props) return `<div class="tty"><span style="color:#d97757">✻ ${esc(String(sp.props.word ?? 'Thinking'))}${esc(String(sp.props.suffix ?? ''))}…</span></div>`
  const other = siteHtml(s.UserMessage, 60, 4) ?? siteHtml(s.AssistantMessage, 60, 4) ?? siteHtml(s.ToolUse, 60, 4) ?? siteHtml(s.PromptHint, 60, 2)
  if (other) return `<div class="tty">${other}</div><div class="fade"></div>`
  const lines: string[] = []
  const h = p?.harness
  if (h?.toasts.length) lines.push(`<span style="color:#8a8a8a">╭─ ${esc(m.name)} ─╮</span>\n<span style="color:#8a8a8a">│</span> ${esc(h.toasts[0]!.slice(0, 54))} <span style="color:#8a8a8a">│</span>`)
  if (h?.status) lines.push(`<span style="color:#f5c542">⚠ ${esc(m.name)}:</span> ${esc(h.status.slice(0, 56))}`)
  if (h?.denies[0]) lines.push(`<span style="color:#3dd68c">⏺</span> Bash(${esc(h.denies[0].tool.replace(/^Bash: /, '').slice(0, 40))})\n  <span style="color:#e5484d">⎿ Denied by ${esc(m.name)}: ${esc(h.denies[0].reason.slice(0, 60))}</span>`)
  if (h?.commands[0]?.output) lines.push(`<span style="color:#8a8a8a">›</span> /${esc(h.commands[0].name)}\n  <span style="color:#8a8a8a">⎿</span> ${esc(h.commands[0].output.split('\n')[0]!.slice(0, 60))}`)
  if (h?.logs[0]) lines.push(`<span style="color:#8a8a8a">● ${esc(m.name)}: ${esc(h.logs[0].slice(0, 60))}</span>`)
  if (lines.length) return `<div class="tty">${lines.slice(0, 2).join('\n')}</div><div class="fade"></div>`
  const events = (p?.validate.hooks.length ? p.validate.hooks : (h?.hooks ?? []).map(x => x.event)).slice(0, 8)
  const chips = events.length ? events.map(e => `<span>${esc(e.replace(/\{.*$/, ''))}</span>`).join('') : `<span>${esc(tags.join(' · ') || 'no preview')}</span>`
  return `<div class="nodraw">${chips}</div>`
}

function installFor(m: ModEntry, entryName: string): View['install'] {
  const repoUrl = `https://github.com/${m.repo.fullName}`
  const dirName = m.repo.fullName.split('/')[1]!
  const pluginDir = m.path ? `./${dirName}/${m.path}` : `./${dirName}`
  if (m.kind === 'builtin') return [{ label: 'built in', cmds: [], note: 'Ships inside Claude Code. See /plugin → Built-in.' }]
  if (m.kind === 'slopshopper')
    return [
      { label: 'marketplace', cmds: [`claude plugin marketplace add ${REPO}`, `claude plugin install ${m.name}@slopshopper`] },
      { label: 'clone', cmds: [`git clone ${repoUrl}`, `claude --plugin-dir ${pluginDir}`], note: 'One session, nothing installed.' },
    ]
  const out: View['install'] = []
  if (m.hasMarketplace && m.marketplaceName) out.push({ label: 'author', cmds: [`claude plugin marketplace add ${m.repo.fullName}`, `claude plugin install ${m.name}@${m.marketplaceName}`], note: m.path ? 'Entry name may differ; see the README.' : undefined })
  if (m.kind === 'community') out.push({ label: 'community', cmds: [`claude plugin marketplace add ${COMMUNITY_MARKETPLACE_URL}`, `claude plugin install ${entryName}@slopshopper-community`], note: "Points at the author's repo. Nothing re-hosted." })
  if (m.kind === 'sample') out.push({ label: 'playground', cmds: [`git clone https://github.com/anthropics/claude-code-playground`, `claude plugin marketplace add ./claude-code-playground/claude-code/mods`, `claude plugin install ${m.name}@claude-code-playground-mods`] })
  out.push({ label: 'clone', cmds: [`git clone ${repoUrl}`, `claude --plugin-dir ${pluginDir}`], note: 'One session, nothing installed.' })
  return out
}

function layout(opts: { title: string; description: string; body: string; path: string; nav?: string; ogImage?: string }): string {
  const canonical = `${SITE_URL}${u(opts.path)}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${SITE_URL}${u('img/' + (opts.ogImage ?? 'cannon-dairy.jpg'))}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${u('favicon.svg')}" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="New Claude Code mods" href="${u('feed.xml')}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800;900&family=JetBrains+Mono:wght@500;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${u('style.css')}">
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="${u('')}">SLOP<span>SHOPPER</span></a>
  <nav class="nav">
    <a href="${u('')}" ${opts.nav === 'mods' ? 'class="on"' : ''}>Mods</a>
    <a href="${u('new/')}" ${opts.nav === 'new' ? 'class="on"' : ''}>New</a>
    <a href="${u('about/')}" ${opts.nav === 'about' ? 'class="on"' : ''}>How</a>
    <a href="https://github.com/${REPO}" rel="noopener">GitHub</a>
  </nav>
</div></header>
${opts.body}
<footer class="footer"><div class="wrap">
  <b>Open source.</b> MIT. <b>Not vetted.</b> Read a mod before you install it. <b>Previews are sandbox replays,</b> not the real engine.
  <span class="links"><a href="https://github.com/${REPO}">${REPO}</a> · <a href="${u('api/mods.json')}">api</a> · <a href="${u('feed.xml')}">rss</a> · <a href="${u('community/marketplace.json')}">marketplace.json</a></span>
</div></footer>
<script src="${u('app.js')}" defer></script>
</body>
</html>`
}

function badges(v: View, max = 4): string {
  const shown = v.tags.filter(t => t !== 'session' && t !== 'turn')
  const order = ['original', 'builtin', 'sample', 'pane', 'band', 'spinner', 'transcript', 'guard', 'command', 'toast', 'status', 'prompt', 'tool', 'model', 'process', 'network', 'timer', 'agents', 'audio']
  const list = [...(v.isNew ? ['new'] : []), ...order.filter(t => shown.includes(t))]
  return `<div class="badges">${list.slice(0, max).map(t => `<span class="badge ${t}">${esc(TAG_LABELS[t] ?? t)}</span>`).join('')}</div>`
}

function card(v: View): string {
  const m = v.mod
  const hay = [m.name, m.displayName, m.description, m.repo.fullName, m.author?.name, ...m.keywords, ...v.tags, ...(v.preview?.validate.hooks ?? [])].filter(Boolean).join(' ').toLowerCase()
  return `<article class="card" data-name="${esc(m.name)}" data-stars="${v.stars}" data-seen="${new Date(m.firstSeen).getTime()}" data-updated="${new Date(v.updated).getTime()}" data-rank="${v.rank.toFixed(2)}" data-tags="${esc([...v.tags, ...(v.isNew ? ['new'] : [])].join(' '))}" data-hay="${esc(hay)}">
  <div class="thumb">${v.thumb}</div>
  <div class="body">
    <div class="name"><a href="${u(`mods/${m.slug}/`)}">${esc(title(m))}</a></div>
    <p class="desc">${esc(oneLine(m.description, 96))}</p>
    <div class="meta">${badges(v, 3)}<span class="who">${esc(m.repo.fullName.split('/')[0]!)}${v.stars ? ` · <b>★${num(v.stars)}</b>` : ''} · ${esc(ago(v.updated))}</span></div>
  </div>
</article>`
}

function cmdBlock(cmds: string[]): string {
  return cmds.map(c => `<div class="cmd"><span class="p">$</span><code>${esc(c)}</code><button data-copy="${esc(c)}">copy</button></div>`).join('')
}

function installPanel(v: View): string {
  if (!v.install.length) return ''
  if (v.install.length === 1 && !v.install[0]!.cmds.length) return `<div class="panel"><h3>Install</h3><p class="muted">${esc(v.install[0]!.note ?? '')}</p></div>`
  return `<div class="panel tabbed"><h3>Install</h3><div class="tabs">${v.install.map((i, k) => `<button data-tab="t${k}" class="${k === 0 ? 'on' : ''}">${esc(i.label)}</button>`).join('')}</div>${v.install
    .map((i, k) => `<div class="tab ${k === 0 ? 'on' : ''}" data-tab="t${k}"><div class="cmds">${cmdBlock(i.cmds)}</div>${i.note ? `<p class="tiny">${esc(i.note)}</p>` : ''}</div>`)
    .join('')}</div>`
}

function detailPage(v: View): string {
  const m = v.mod
  const p = v.preview
  const h = p?.harness
  const rawBase = `https://raw.githubusercontent.com/${m.repo.fullName}/${m.repo.defaultBranch}/${m.path}`.replace(/\/$/, '')
  const blobBase = `https://github.com/${m.repo.fullName}/blob/${m.repo.defaultBranch}/${m.path}`.replace(/\/$/, '')
  const readme = m.readme ? markdown(m.readme, { rawBase, blobBase }) : ''
  const sites = h?.sites ?? {}
  const siteCards: string[] = []
  const add = (label: string, html: string | null, note?: string) => {
    if (html) siteCards.push(`<div><div class="lbl">${esc(label)}${note ? ` <span class="muted">· ${esc(note)}</span>` : ''}</div><div class="site-box"><div class="tty">${html}</div></div></div>`)
  }
  add('Band', siteHtml(sites.AbovePrompt, 100))
  for (const [id, r] of Object.entries(sites.Pane ?? {})) add(`Pane · ${esc((r as { title?: string }).title ?? id)}`, siteHtml(r, 60), (r as { transient?: boolean }).transient ? 'while holding a tool call' : undefined)
  add('Spinner', siteHtml(sites.Spinner, 100))
  add('Prompt hint', siteHtml(sites.PromptHint, 100))
  add('Turn line', siteHtml(sites.TurnDuration, 100))
  add('Your message', siteHtml(sites.UserMessage, 100))
  add("Claude's reply", siteHtml(sites.AssistantMessage, 100))
  add('Tool row', siteHtml(sites.ToolUse, 100))
  add('Command output', siteHtml(sites.CommandOutput, 100))
  const events = p?.validate.hooks.length ? p.validate.hooks : (h?.hooks ?? []).map(x => x.event + (x.matcher ? `{${Object.entries(x.matcher).map(([k, val]) => `${k}=${typeof val === 'string' ? val : JSON.stringify(val)}`).join(', ')}}` : ''))
  const calls = p?.validate.calls ?? Object.keys(h?.apiCalls ?? {})
  const summary = v.mock?.summary ?? []
  const notes: string[] = []
  if (h?.commands.length) notes.push(`adds ${h.commands.map(c => `<code>/${esc(c.name)}</code>`).join(', ')}`)
  if (h?.tools.length) notes.push(`gives Claude ${h.tools.map(t => `<code>${esc(t.name)}</code>`).join(', ')}`)
  if (h?.rewrites.length) for (const r of h.rewrites.slice(0, 3)) notes.push(`${esc(r.event)}: ${esc(r.summary.slice(0, 120))}`)
  if (h?.denies.length) for (const d of h.denies.slice(0, 2)) notes.push(`refused <code>${esc(d.tool)}</code>`)
  if (h?.timers.length) notes.push(`runs on a timer`)
  if (h?.toasts.length) notes.push(`toast: “${esc(h.toasts[0]!.slice(0, 70))}”`)
  if (h?.status) notes.push(`status: “${esc(h.status.slice(0, 70))}”`)
  const userConfig = m.userConfig && Object.keys(m.userConfig).length ? `<div class="panel"><h3>Options</h3><dl class="kv">${Object.entries(m.userConfig).map(([k, f]) => `<dt>${esc(k)}</dt><dd>${esc(f.title ?? f.description?.slice(0, 80) ?? '')}${f.default !== undefined ? ` <span class="tiny">= ${esc(JSON.stringify(f.default))}</span>` : ''}</dd>`).join('')}</dl></div>` : ''
  const harnessStatus = !p ? '<div class="warn"><b>No preview yet.</b></div>' : !h?.ok ? `<div class="warn"><b>Preview could not run:</b> ${esc((h?.error ?? 'unknown error').slice(0, 200))}</div>` : ''
  const validateStatus = p && !p.validate.ok ? `<div class="err"><b>validate: ${p.validate.errors.length} error${p.validate.errors.length === 1 ? '' : 's'}</b><br>${p.validate.errors.slice(0, 3).map(e => esc(e.slice(0, 160))).join('<br>')}</div>` : p ? '<div class="ok"><b>validate: passed</b></div>' : ''
  const source = Object.entries(m.files)
    .filter(([f]) => !f.endsWith('.json'))
    .slice(0, 12)
    .map(([f, text]) => `<details><summary><code>${esc(f)}</code> <span class="tiny">${text.split('\n').length} lines</span></summary><pre class="source"><code>${text
      .split('\n')
      .slice(0, 1200)
      .map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`)
      .join('\n')}</code></pre></details>`)
    .join('')
  const repoLink = `<a href="${esc(m.repo.url)}${m.path ? '/tree/' + esc(m.repo.defaultBranch) + '/' + esc(m.path) : ''}" rel="noopener">${esc(m.repo.fullName)}${m.path ? '/' + esc(m.path) : ''}</a>`
  const body = `
<section class="dhero"><div class="wrap"><div class="dtext">
  <h1>${esc(title(m))}</h1>
  <p class="one">${esc(oneLine(m.description, 160))}</p>
  ${badges(v, 6)}
  <div class="strip">${v.stars ? `<span><b>★ ${num(v.stars)}</b></span>` : ''}<span>v<b>${esc(m.version ?? '?')}</b></span><span><b>${esc(m.license ?? m.repo.license ?? 'no license')}</b></span><span>updated <b>${esc(fmtDate(v.updated))}</b></span><span>${repoLink}</span></div>
</div>${img('slop-shop.jpg', 'side', 'A shopper browsing a rack in a slop shop')}</div></section>
<div class="wrap">
  ${harnessStatus}
  ${v.mock && v.mock.hasDrawing ? `<div class="lbl">Preview · a replayed session in a sandbox</div><div class="tty-frame"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span class="title">claude · ~/work/app · ${esc(m.name)}</span></div><div class="tty">${v.mock.html}</div></div>` : ''}
  <div class="two">
    <div>
      ${siteCards.length ? `<h2>Draws</h2><div class="sites">${siteCards.join('')}</div>` : ''}
      ${readme ? `<details class="big" open><summary>README</summary><div class="readme clamp" id="readme">${readme}</div><button class="chip expand" data-expand="readme">More ▾</button></details>` : ''}
      <details class="big"><summary>Source <span class="tiny">${Object.keys(m.files).filter(f => !f.endsWith('.json')).length} files</span></summary>${source || '<p class="muted">Not captured.</p>'}</details>
    </div>
    <aside>
      ${installPanel(v)}
      <div class="panel"><h3>In the preview</h3>${summary.length || notes.length ? `<ul>${[...summary.map(s => esc(s)), ...notes].slice(0, 7).map(s => `<li>${s}</li>`).join('')}</ul>` : '<p class="muted">Nothing visible. Works behind the scenes, or needs what the sandbox lacks.</p>'}</div>
      <div class="panel"><h3>Hooks</h3>${events.length ? `<div class="events">${events.map(e => `<span>${esc(e)}</span>`).join('')}</div>` : '<p class="muted">none</p>'}</div>
      <div class="panel"><h3>Reaches</h3>${calls.length ? `<div class="events">${calls.map(c => `<span>${esc(c.replace(/ \(via .*\)$/, ''))}</span>`).join('')}</div>` : '<p class="muted">nothing</p>'}${p?.validate.envReads.length ? `<p class="tiny">env: ${esc(p.validate.envReads.join(', '))}</p>` : ''}</div>
      ${userConfig}
      <div class="panel"><h3>Checks</h3>${validateStatus}<p class="tiny">${m.hasTests ? '<b>Tests</b> ✓' : 'No tests'} · ${m.hasTypes ? '<b>State contract</b> ✓' : 'no state contract'} · first seen ${esc(fmtDate(m.firstSeen))}</p></div>
    </aside>
  </div>
</div>`
  return layout({ title: `${title(m)} · Claude Code mod · slopshopper`, description: oneLine(m.description, 200), body, path: `mods/${m.slug}/`, nav: 'mods', ogImage: 'slop-shop.jpg' })
}

const INLINE_CARDS = 120

function indexPage(views: View[], stats: { total: number; fresh: number; authors: number }): string {
  const sorted = [...views].sort((a, b) => b.rank - a.rank)
  const inline = sorted.slice(0, INLINE_CARDS)
  const body = `
<section class="hero">${img('cannon-dairy.jpg', 'bg', 'A woman leaning on a slop cannon at a dairy farm')}<div class="wrap">
  <h1 class="wordmark">SLOP<br>SHOPPER</h1>
  <p class="tag"><b>Mods for Claude Code.</b> Scraped daily. Previewed. Installed in two commands.</p>
  <div class="bignums"><span><b>${num(stats.total)}</b> mods</span><span><b>${num(stats.authors)}</b> authors</span><span><b>${num(stats.fresh)}</b> new this week</span><span><b>2.1.287+</b> required</span></div>
  <div class="install-hero">
    <div><span class="lbl">Ours</span>${cmdBlock([`claude plugin marketplace add ${REPO}`])}</div>
    <div><span class="lbl">Everyone's</span>${cmdBlock([`claude plugin marketplace add ${COMMUNITY_MARKETPLACE_URL}`])}</div>
  </div>
</div></section>
<div class="shop">
<div class="toolbar"><div class="wrap">
  <input id="q" class="search" type="search" placeholder="Search ${num(stats.total)} mods" autocomplete="off">
  <div class="chips">${FILTER_TAGS.map(t => `<button class="chip" data-f="${t}">${esc(TAG_LABELS[t] ?? t)}</button>`).join('')}</div>
  <select id="sort" class="sort"><option value="rank">Featured</option><option value="new">Newest</option><option value="updated">Updated</option><option value="stars">Stars</option><option value="name">A–Z</option></select>
  <span id="count" class="tiny"></span>
</div></div>
<main class="wrap">
  <div class="grid" id="grid" data-total="${views.length}" data-cards="${u('cards.json')}">${inline.map(card).join('\n')}</div>
  ${views.length > inline.length ? `<p class="more-row"><button class="chip big" id="more">Show all ${num(views.length)}</button></p>` : ''}
</main>
</div>
<section class="bandimg">${img('cannon-manure.jpg', 'bg', 'A slop cannon spraying a field')}<div class="wrap">
  <h2>ALL THE SLOP.<br>ONE SHOP.</h2>
  <p><b>Every mod GitHub has,</b> through one marketplace that points at each author's own repo.</p>
  ${cmdBlock([`claude plugin marketplace add ${COMMUNITY_MARKETPLACE_URL}`, 'claude plugin install <name>@slopshopper-community'])}
</div></section>`
  return layout({ title: 'slopshopper · the mod shop for Claude Code', description: `${num(stats.total)} Claude Code mods, scraped from GitHub, each with a visual preview and install commands.`, body, path: '', nav: 'mods' })
}

function newPage(views: View[]): string {
  const sorted = [...views].sort((a, b) => new Date(b.mod.firstSeen).getTime() - new Date(a.mod.firstSeen).getTime()).slice(0, 150)
  const body = `
<section class="bandimg top">${img('cannon-city.jpg', 'bg', 'An AI slop cannon firing images over a city')}<div class="wrap"><h2>FRESH<br>SLOP.</h2><p><b>Newest mods</b> by the day the scraper first saw them. <a href="${u('feed.xml')}">RSS</a></p></div></section>
<main class="wrap"><div class="list">${sorted.map(v => `<a class="row" href="${u(`mods/${v.mod.slug}/`)}"><span class="d">${esc(fmtDate(v.mod.firstSeen))}</span><span><b>${esc(title(v.mod))}</b> <span class="muted">${esc(oneLine(v.mod.description, 100))}</span></span><span class="d">${esc(v.mod.repo.fullName.split('/')[0]!)}</span></a>`).join('')}</div></main>`
  return layout({ title: 'New Claude Code mods · slopshopper', description: 'The newest Claude Code mods found on GitHub.', body, path: 'new/', nav: 'new', ogImage: 'cannon-city.jpg' })
}

function aboutPage(stats: { total: number }): string {
  const body = `
<section class="bandimg top">${img('financial-freedom.jpg', 'bg', 'A parody thumbnail promising financial freedom with AI')}<div class="wrap"><h2>HOW IT<br>WORKS.</h2><p><b>A mod</b> is a Claude Code plugin whose <code>hooks/hooks.json</code> names a <code>modules</code> array: TypeScript that hooks engine events. <a href="https://code.claude.com/docs/en/plugins/mods/overview">Docs</a>.</p></div></section>
<main class="wrap cols">
  <div class="col"><h2>Scrape</h2><ul>
    <li><b>Daily.</b> GitHub code search for mod fingerprints, plus repo topics.</li>
    <li><b>Verified.</b> Every repo tree walked; only a <code>hooks.json</code> with <code>modules</code> counts.</li>
    <li><b>Nothing re-hosted.</b> Installs point at the author's repo.</li>
    <li><b>Skipped.</b> Forks under five stars.</li>
  </ul></div>
  <div class="col"><h2>Preview</h2><ul>
    <li><b>Sandboxed.</b> The mod runs in a fresh JS realm with a fake mods API.</li>
    <li><b>One scripted turn.</b> Reads, an edit, a TODO, a failing test, a risky <code>rm -rf</code>, a <code>cat .env</code>.</li>
    <li><b>Then it draws.</b> Every render site is asked; the trees are drawn like the terminal.</li>
    <li><b>Shape, not behaviour.</b> Canned git, files and model answers. Facts come from <code>claude plugin validate</code>.</li>
  </ul></div>
  <div class="col"><h2>Trust</h2><ul>
    <li><b>Your permissions.</b> A mod can read files, run processes, hit the network, approve tool calls.</li>
    <li><b>Not vetted.</b> Read the source (every page has it).</li>
    <li><b>Check it.</b> <code>claude plugin validate</code> on a clone lists every call it makes.</li>
  </ul></div>
  <div class="col"><h2>Get listed</h2><ul>
    <li><b>Push a public repo</b> with a mod. The next scrape finds it.</li>
    <li><b>Missing?</b> Open an issue on <a href="https://github.com/${REPO}">${REPO}</a>.</li>
    <li><b>Better listing:</b> <code>plugin.json</code> with name, description, author, license, homepage.</li>
  </ul></div>
  <div class="col"><h2>Run it</h2><pre><code>git clone https://github.com/${REPO}
cd slopshopper && bun install
bun run scrape && bun run previews
bun run build && bun run dev</code></pre></div>
  <div class="col"><h2>Marketplace</h2><ul>
    <li><b>${num(stats.total)} mods,</b> one file: <code>${esc(COMMUNITY_MARKETPLACE_URL)}</code></li>
    <li><b>Names</b> are the mod's own; the author's login is appended on a clash.</li>
  </ul></div>
</main>`
  return layout({ title: 'How slopshopper works', description: 'How slopshopper scrapes GitHub for Claude Code mods and previews them.', body, path: 'about/', nav: 'about', ogImage: 'financial-freedom.jpg' })
}

function feed(views: View[]): string {
  const items = [...views]
    .sort((a, b) => new Date(b.mod.firstSeen).getTime() - new Date(a.mod.firstSeen).getTime())
    .slice(0, 50)
    .map(v => `<item><title>${esc(title(v.mod))}</title><link>${SITE_URL}${u(`mods/${v.mod.slug}/`)}</link><guid>${SITE_URL}${u(`mods/${v.mod.slug}/`)}</guid><pubDate>${new Date(v.mod.firstSeen).toUTCString()}</pubDate><description>${esc(v.mod.description)} (${esc(v.mod.repo.fullName)})</description></item>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>slopshopper · new Claude Code mods</title><link>${SITE_URL}${u('')}</link><description>New Claude Code mods found on GitHub</description>${items}</channel></rss>`
}

function communityMarketplace(views: View[]) {
  const plugins = views
    .filter(v => v.mod.kind === 'community' && (!v.preview || v.preview.validate.ok))
    .map(v => {
      const m = v.mod
      const source = m.path ? { source: 'git-subdir', url: `https://github.com/${m.repo.fullName}.git`, path: m.path } : { source: 'github', repo: m.repo.fullName }
      return {
        name: v.entryName,
        source,
        description: m.description.slice(0, 300),
        ...(m.author ? { author: m.author } : {}),
        homepage: m.homepage ?? m.repo.url,
        repository: m.repo.url,
        ...(m.license ?? m.repo.license ? { license: m.license ?? m.repo.license } : {}),
        keywords: m.keywords.slice(0, 10),
        category: 'mods',
        tags: v.tags.filter(t => !['original', 'builtin', 'sample'].includes(t)),
      }
    })
  return { name: 'slopshopper-community', owner: { name: 'slopshopper', url: SITE_URL }, metadata: { description: 'Every Claude Code mod slopshopper found on GitHub, each pointing at its own repository. Not vetted: read a mod before installing it.', version: new Date().toISOString().slice(0, 10) }, plugins }
}

async function main() {
  // build into a scratch directory and swap it in at the end, so a server
  // reading dist/ never sees it half written
  const FINAL = DIST
  const DIST_TMP = DIST + '.tmp'
  await rm(DIST_TMP, { recursive: true, force: true })
  await mkdir(DIST_TMP, { recursive: true })
  await buildInto(DIST_TMP)
  await rm(FINAL, { recursive: true, force: true })
  await rename(DIST_TMP, FINAL)
}

async function buildInto(DIST: string) {
  const index = existsSync(join(DATA, 'mods.json')) ? ((await Bun.file(join(DATA, 'mods.json')).json()) as Index) : { generatedAt: '', mods: [] }
  const mods: ModEntry[] = [...(await localMods()), ...index.mods]
  for (const m of mods) {
    if (Object.keys(m.files).length) continue
    const f = Bun.file(join(DATA, 'mods', `${m.slug}.json`))
    if (await f.exists()) m.files = ((await f.json()) as { files: Record<string, string> }).files
  }
  // community entry names: a mod's own name; on a clash the owner, then the
  // repository, then the path are appended until the name is unique
  const cleanName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+/g, '-').replace(/-$/, '')
  const takenNames = new Set<string>()
  const entryNames = new Map<string, string>()
  for (const m of [...mods].sort((a, b) => b.repo.stars - a.repo.stars || a.slug.localeCompare(b.slug))) {
    if (m.kind !== 'community') continue
    const [owner, repoName] = m.repo.fullName.split('/') as [string, string]
    const base = cleanName(m.name) || cleanName(repoName) || 'mod'
    const candidates = [base, `${base}-${cleanName(owner)}`, `${base}-${cleanName(owner)}-${cleanName(repoName)}`, `${base}-${cleanName(owner)}-${cleanName(repoName)}-${cleanName(m.path.replace(/\//g, '-')) || 'root'}`]
    let chosen = candidates.find(c => !takenNames.has(c.toLowerCase()))
    for (let n = 2; !chosen; n++) if (!takenNames.has(`${candidates[2]}-${n}`.toLowerCase())) chosen = `${candidates[2]}-${n}`
    takenNames.add(chosen.toLowerCase())
    entryNames.set(m.slug, chosen)
  }
  const views: View[] = []
  for (const m of mods) {
    const pf = Bun.file(join(DATA, 'previews', `${m.slug}.json`))
    const preview = (await pf.exists()) ? ((await pf.json()) as Preview) : null
    const tags = tagsOf(m, preview)
    const updated = m.modUpdatedAt || m.repo.pushedAt
    const isNew = Date.now() - new Date(m.firstSeen).getTime() < NEW_DAYS * 86_400_000 && m.kind !== 'builtin'
    const mock = preview?.harness.ok ? mockup(preview, m.name) : null
    const days = (Date.now() - new Date(updated).getTime()) / 86_400_000
    const isSampleCopy = m.kind === 'community' && /^(blast-radius|replay-theater|token-weather|first-mod|hello-tabs|gallery)$/.test(m.name)
    const rank = (m.kind === 'slopshopper' ? 30 : 0) + (m.kind === 'sample' ? 6 : 0) + Math.min(28, Math.log2(m.repo.stars + 1) * 4) + (days < 14 ? 6 : days < 60 ? 3 : 0) + (mock?.hasDrawing ? 5 : 0) + (preview && !preview.validate.ok ? -25 : 2) + (m.readme ? 1 : 0) + (isSampleCopy ? -12 : 0)
    const entryName = entryNames.get(m.slug) ?? m.name
    views.push({ mod: m, preview, tags, isNew, rank, thumb: thumbOf(preview, m, tags), mock, install: installFor(m, entryName), entryName, stars: m.repo.stars, updated })
  }
  // one repository cannot fill the first screen: each further mod from the
  // same repository ranks a little lower than the one before it
  const perRepo = new Map<string, number>()
  for (const v of [...views].sort((a, b) => b.rank - a.rank)) {
    const n = perRepo.get(v.mod.repo.fullName) ?? 0
    perRepo.set(v.mod.repo.fullName, n + 1)
    if (v.mod.kind !== 'slopshopper') v.rank -= Math.min(24, n * 2.5)
  }
  const stats = { total: views.length, fresh: views.filter(v => v.isNew).length, authors: new Set(views.map(v => v.mod.repo.fullName.split('/')[0])).size }
  await Bun.write(join(DIST, 'index.html'), indexPage(views, stats))
  await Bun.write(join(DIST, 'cards.json'), JSON.stringify([...views].sort((a, b) => b.rank - a.rank).map(v => ({ slug: v.mod.slug, html: card(v) }))))
  await Bun.write(join(DIST, 'new', 'index.html'), newPage(views))
  await Bun.write(join(DIST, 'about', 'index.html'), aboutPage(stats))
  for (const v of views) await Bun.write(join(DIST, 'mods', v.mod.slug, 'index.html'), detailPage(v))
  await Bun.write(join(DIST, 'feed.xml'), feed(views))
  await Bun.write(join(DIST, 'community', 'marketplace.json'), JSON.stringify(communityMarketplace(views), null, 2))
  await Bun.write(
    join(DIST, 'api', 'mods.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), site: SITE_URL, count: views.length, mods: views.map(v => ({ ...v.mod, files: undefined, readme: undefined, tags: v.tags, isNew: v.isNew, entryName: v.entryName, url: `${SITE_URL}${u(`mods/${v.mod.slug}/`)}` })) }, null, 1),
  )
  await Bun.write(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['', 'new/', 'about/', ...views.map(v => `mods/${v.mod.slug}/`)].map(p => `<url><loc>${SITE_URL}${u(p)}</loc></url>`).join('')}</urlset>`)
  await Bun.write(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}${u('sitemap.xml')}\n`)
  await Bun.write(join(DIST, '404.html'), layout({ title: 'Not found · slopshopper', description: 'Not found', body: `<section class="bandimg top">${img('cannon-pigs.jpg', 'bg', 'A slop cannon at a pig farm')}<div class="wrap"><h2>404.<br>NO SLOP HERE.</h2><p><a href="${u('')}"><b>Back to the shop →</b></a></p></div></section>`, path: '404.html', ogImage: 'cannon-pigs.jpg' }))
  await Bun.write(join(DIST, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#e07a4f"/><path d="M14 22h36l-4 24H18z" fill="none" stroke="#111" stroke-width="5" stroke-linejoin="round"/><path d="M22 22v-4a10 10 0 0 1 20 0v4" fill="none" stroke="#111" stroke-width="5"/></svg>`)
  await cp(join(ROOT, 'site', 'static'), DIST, { recursive: true })
  if (existsSync(join(ROOT, '.claude-plugin', 'marketplace.json'))) await cp(join(ROOT, '.claude-plugin', 'marketplace.json'), join(DIST, 'marketplace.json'))
  await Bun.write(join(DIST, '.nojekyll'), '')
  console.log(`built ${views.length} mods → ${DIST} (base ${BASE})`)
}

await main()
