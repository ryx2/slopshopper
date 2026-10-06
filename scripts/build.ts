// Static site generator: data/mods.json + data/previews/*.json + ./mods → dist/
//
//   bun run build
//   SITE_BASE=/slopshopper/ bun run build     (GitHub Pages project path)

import { mkdir, rm, cp } from 'node:fs/promises'
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
const fmtDate = (iso: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : '')
const ago = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 86_400_000
  if (d < 1) return 'today'
  if (d < 2) return 'yesterday'
  if (d < 30) return `${Math.floor(d)}d ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${Math.floor(d / 365)}y ago`
}
const title = (m: ModEntry) => m.displayName ?? m.name

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

const TAG_LABELS: Record<string, string> = { pane: 'pane', band: 'band', spinner: 'spinner', transcript: 'transcript', toast: 'toast', status: 'status', guard: 'tool guard', command: 'command', prompt: 'prompt', tool: 'tool', model: 'model', process: 'process', network: 'network', timer: 'timer', turn: 'turn', session: 'session', agents: 'agents', audio: 'audio', original: 'original', builtin: 'built-in', sample: 'sample', new: 'new' }
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
  if (m.kind === 'builtin') return [{ label: 'built in', cmds: [], note: 'This mod ships inside Claude Code. Run /plugin and look under Built-in.' }]
  if (m.kind === 'slopshopper')
    return [
      { label: 'marketplace', cmds: [`claude plugin marketplace add ${REPO}`, `claude plugin install ${m.name}@slopshopper`], note: 'Or, in a session: /plugin install ' + m.name + ' --marketplace ' + REPO },
      { label: 'clone', cmds: [`git clone ${repoUrl}`, `claude --plugin-dir ${pluginDir}`], note: 'Loads the mod for one session.' },
    ]
  const out: View['install'] = []
  if (m.hasMarketplace && m.marketplaceName && m.path === '') out.push({ label: "author's marketplace", cmds: [`claude plugin marketplace add ${m.repo.fullName}`, `claude plugin install ${m.name}@${m.marketplaceName}`] })
  else if (m.hasMarketplace && m.marketplaceName) out.push({ label: "author's marketplace", cmds: [`claude plugin marketplace add ${m.repo.fullName}`, `claude plugin install ${m.name}@${m.marketplaceName}`], note: 'The repository has a marketplace file; check its README for the entry name if this install fails.' })
  if (m.kind === 'community') out.push({ label: 'slopshopper community', cmds: [`claude plugin marketplace add ${COMMUNITY_MARKETPLACE_URL}`, `claude plugin install ${entryName}@slopshopper-community`], note: 'One marketplace that lists every mod on this site, pointing at each author\'s own repository. Nothing is re-hosted.' })
  if (m.kind === 'sample') out.push({ label: 'playground marketplace', cmds: [`git clone https://github.com/anthropics/claude-code-playground`, `claude plugin marketplace add ./claude-code-playground/claude-code/mods`, `claude plugin install ${m.name}@claude-code-playground-mods`] })
  out.push({ label: 'clone', cmds: [`git clone ${repoUrl}`, `claude --plugin-dir ${pluginDir}`], note: 'Loads the mod for one session without installing it.' })
  return out
}

function layout(opts: { title: string; description: string; body: string; path: string; nav?: string; extraHead?: string }): string {
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
<meta name="twitter:card" content="summary">
<link rel="icon" href="${u('favicon.svg')}" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="New Claude Code mods" href="${u('feed.xml')}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${u('style.css')}">
${opts.extraHead ?? ''}
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="${u('')}"><span class="cart">▤</span>slopshopper</a>
  <nav class="nav">
    <a href="${u('')}" ${opts.nav === 'mods' ? 'class="on"' : ''}>mods</a>
    <a href="${u('new/')}" ${opts.nav === 'new' ? 'class="on"' : ''}>new</a>
    <a href="${u('about/')}" ${opts.nav === 'about' ? 'class="on"' : ''}>how it works</a>
    <a href="https://github.com/${REPO}" rel="noopener">github</a>
  </nav>
</div></header>
${opts.body}
<footer class="footer"><div class="wrap">
  slopshopper is open source (<a href="https://github.com/${REPO}">${REPO}</a>). Community mods belong to their authors and run with your permissions: read a mod before you install it. Previews come from a sandboxed replay of a scripted session, not from the real engine, so a real session can look different.
  <br><a href="${u('api/mods.json')}">mods.json</a> · <a href="${u('feed.xml')}">rss</a> · <a href="${u('community/marketplace.json')}">community marketplace</a> · built ${fmtDate(new Date().toISOString())}
</div></footer>
<script src="${u('app.js')}" defer></script>
</body>
</html>`
}

function badges(v: View): string {
  const shown = v.tags.filter(t => t !== 'session' && t !== 'turn')
  const order = ['original', 'builtin', 'sample', 'pane', 'band', 'spinner', 'transcript', 'guard', 'command', 'toast', 'status', 'prompt', 'tool', 'model', 'process', 'network', 'timer', 'agents', 'audio']
  const list = [...(v.isNew ? ['new'] : []), ...order.filter(t => shown.includes(t))]
  return `<div class="badges">${list.slice(0, 7).map(t => `<span class="badge ${t}">${esc(TAG_LABELS[t] ?? t)}</span>`).join('')}</div>`
}

function card(v: View): string {
  const m = v.mod
  const hay = [m.name, m.displayName, m.description, m.repo.fullName, m.author?.name, ...m.keywords, ...v.tags, ...(v.preview?.validate.hooks ?? [])].filter(Boolean).join(' ').toLowerCase()
  const avatar = m.repo.ownerAvatar ? `<img src="${esc(m.repo.ownerAvatar)}&s=32" alt="" loading="lazy">` : ''
  return `<article class="card" data-name="${esc(m.name)}" data-stars="${v.stars}" data-seen="${new Date(m.firstSeen).getTime()}" data-updated="${new Date(v.updated).getTime()}" data-rank="${v.rank.toFixed(2)}" data-tags="${esc([...v.tags, ...(v.isNew ? ['new'] : [])].join(' '))}" data-hay="${esc(hay)}">
  <div class="thumb">${v.thumb}</div>
  <div class="body">
    <div class="name"><a href="${u(`mods/${m.slug}/`)}">${esc(title(m))}</a></div>
    ${badges(v)}
    <p class="desc">${esc(m.description || 'No description.')}</p>
    <div class="meta">${avatar}<span>${esc(m.repo.fullName)}</span>${v.stars ? `<span><span class="star">★</span> ${v.stars}</span>` : ''}<span>${esc(ago(v.updated))}</span></div>
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
    .map((i, k) => `<div class="tab ${k === 0 ? 'on' : ''}" data-tab="t${k}"><div style="display:grid;gap:6px">${cmdBlock(i.cmds)}</div>${i.note ? `<p class="tiny" style="margin:8px 0 0">${esc(i.note)}</p>` : ''}</div>`)
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
    if (html) siteCards.push(`<div><div class="tiny" style="margin:0 0 6px">${esc(label)}${note ? ` · ${esc(note)}` : ''}</div><div class="site-box"><div class="tty">${html}</div></div></div>`)
  }
  add('Band above the prompt', siteHtml(sites.AbovePrompt, 100))
  for (const [id, r] of Object.entries(sites.Pane ?? {})) add(`Pane · ${esc((r as { title?: string }).title ?? id)}`, siteHtml(r, 60), (r as { transient?: boolean }).transient ? 'captured while the mod was holding a tool call' : undefined)
  add('Spinner', siteHtml(sites.Spinner, 100))
  add('Prompt hint', siteHtml(sites.PromptHint, 100))
  add('Turn summary line', siteHtml(sites.TurnDuration, 100))
  add('Your message', siteHtml(sites.UserMessage, 100))
  add("Claude's reply", siteHtml(sites.AssistantMessage, 100))
  add('Tool call row', siteHtml(sites.ToolUse, 100))
  add('Command output', siteHtml(sites.CommandOutput, 100))
  const facts = [
    ['version', m.version ?? '—'],
    ['license', m.license ?? m.repo.license ?? 'none stated'],
    ['stars', String(v.stars)],
    ['updated', fmtDate(v.updated)],
    ['first seen', fmtDate(m.firstSeen)],
    ['entry', m.entry],
  ]
  const events = p?.validate.hooks.length ? p.validate.hooks : (h?.hooks ?? []).map(x => x.event + (x.matcher ? `{${Object.entries(x.matcher).map(([k, val]) => `${k}=${typeof val === 'string' ? val : JSON.stringify(val)}`).join(', ')}}` : ''))
  const calls = p?.validate.calls ?? Object.keys(h?.apiCalls ?? {})
  const summary = v.mock?.summary ?? []
  const notes: string[] = []
  if (h?.commands.length) notes.push(`adds ${h.commands.map(c => `<code>/${esc(c.name)}</code>`).join(', ')}`)
  if (h?.tools.length) notes.push(`gives Claude ${h.tools.map(t => `<code>${esc(t.name)}</code>`).join(', ')}`)
  if (h?.rewrites.length) for (const r of h.rewrites.slice(0, 4)) notes.push(`${esc(r.event)}: ${esc(r.summary)}`)
  if (h?.denies.length) for (const d of h.denies.slice(0, 3)) notes.push(`refused <code>${esc(d.tool)}</code>: ${esc(d.reason.slice(0, 160))}`)
  if (h?.timers.length) notes.push(`runs on a timer (${h.timers.map(t => `${t.kind} ${t.ms}ms`).join(', ')})`)
  if (h?.toasts.length) notes.push(`toasts: ${h.toasts.slice(0, 3).map(t => `“${esc(t.slice(0, 80))}”`).join(', ')}`)
  if (h?.status) notes.push(`status line: “${esc(h.status.slice(0, 100))}”`)
  const userConfig = m.userConfig && Object.keys(m.userConfig).length ? `<div class="panel"><h3>Options</h3><dl class="kv">${Object.entries(m.userConfig).map(([k, f]) => `<dt>${esc(k)}</dt><dd>${esc(f.title ?? '')}${f.description ? ` <span class="muted">— ${esc(f.description.slice(0, 160))}</span>` : ''}${f.default !== undefined ? ` <span class="tiny">default ${esc(JSON.stringify(f.default))}</span>` : ''}</dd>`).join('')}</dl></div>` : ''
  const harnessStatus = !p ? '<div class="warn">No preview was generated for this mod yet.</div>' : !h?.ok ? `<div class="warn">The preview harness could not run this mod: ${esc(h?.error ?? 'unknown error')}. The facts below come from static analysis.</div>` : ''
  const validateStatus = p && !p.validate.ok ? `<div class="err"><b>claude plugin validate</b> reports errors:<br>${p.validate.errors.map(e => esc(e)).join('<br>')}</div>` : p?.validate.warnings.length ? `<details><summary>${p.validate.warnings.length} validation warning${p.validate.warnings.length === 1 ? '' : 's'}</summary><ul>${p.validate.warnings.map(w => `<li class="tiny">${esc(w)}</li>`).join('')}</ul></details>` : ''
  const source = Object.entries(m.files)
    .filter(([f]) => !f.endsWith('.json'))
    .slice(0, 12)
    .map(([f, text]) => `<details ${f === m.entry ? 'open' : ''}><summary><code>${esc(f)}</code> <span class="tiny">${text.split('\n').length} lines</span></summary><pre class="source"><code>${text
      .split('\n')
      .slice(0, 1200)
      .map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`)
      .join('\n')}</code></pre></details>`)
    .join('')
  const body = `
<div class="wrap">
  <div class="detail-h">
    <div>
      <h1>${esc(title(m))} ${badges(v)}</h1>
      <p class="muted" style="font-size:1.05rem;max-width:760px">${esc(m.description)}</p>
      <div class="by">${m.repo.ownerAvatar ? `<img src="${esc(m.repo.ownerAvatar)}&s=48" alt="">` : ''}<span>${m.author?.name ? esc(m.author.name) + ' · ' : ''}<a href="${esc(m.repo.url)}${m.path ? '/tree/' + esc(m.repo.defaultBranch) + '/' + esc(m.path) : ''}" rel="noopener">${esc(m.repo.fullName)}${m.path ? '/' + esc(m.path) : ''}</a>${m.homepage && !m.homepage.includes('slopshopper.com') ? ` · <a href="${esc(m.homepage)}" rel="noopener">homepage</a>` : ''}</span></div>
    </div>
  </div>
  <div class="facts">${facts.map(([k, val]) => `<div class="fact"><div class="k">${esc(k!)}</div><div class="v">${esc(val!)}</div></div>`).join('')}</div>
  ${harnessStatus}
  ${v.mock && v.mock.hasDrawing ? `<h2>Preview</h2><p class="muted">What a terminal session looks like with this mod loaded, replayed from a scripted turn in a sandbox.</p><div class="tty-frame"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span class="title">claude · ~/work/app · ${esc(m.name)}</span></div><div class="tty">${v.mock.html}</div></div>` : ''}
  <div class="two" style="margin-top:26px">
    <div>
      ${siteCards.length ? `<h2>What it draws</h2><div style="display:grid;gap:16px">${siteCards.join('')}</div>` : ''}
      ${readme ? `<h2>README</h2><div class="readme">${readme}</div>` : ''}
      <h2>Source</h2>${source || '<p class="muted">No source captured.</p>'}
    </div>
    <aside>
      ${installPanel(v)}
      <div class="panel"><h3>In the preview session</h3>${summary.length || notes.length ? `<ul>${[...summary.map(s => esc(s)), ...notes].map(s => `<li>${s}</li>`).join('')}</ul>` : '<p class="muted">Nothing visible: this mod works behind the scenes, or needs something the preview session does not have.</p>'}</div>
      <div class="panel"><h3>Events it handles</h3>${events.length ? `<div class="events">${events.map(e => `<span>${esc(e)}</span>`).join('')}</div>` : '<p class="muted">none found</p>'}</div>
      <div class="panel"><h3>What it reaches</h3>${calls.length ? `<div class="events">${calls.map(c => `<span>${esc(c)}</span>`).join('')}</div>` : '<p class="muted">no mods API calls found</p>'}${p?.validate.envReads.length ? `<p class="tiny" style="margin:8px 0 0">env: ${esc(p.validate.envReads.join(', '))}</p>` : ''}${p?.validate.stateWrites.length ? `<p class="tiny" style="margin:4px 0 0">state: ${esc([...new Set([...p.validate.stateReads, ...p.validate.stateWrites])].join(', '))}</p>` : ''}</div>
      ${userConfig}
      <div class="panel"><h3>Checks</h3>${p?.validate.ok ? '<div class="ok">claude plugin validate passed</div>' : ''}${validateStatus}<p class="tiny" style="margin:8px 0 0">${m.hasTests ? 'Has tests.' : 'No tests found.'} ${m.hasTypes ? 'Declares a state contract.' : ''}</p></div>
    </aside>
  </div>
</div>`
  return layout({ title: `${title(m)} · Claude Code mod · slopshopper`, description: m.description.slice(0, 200) || `${m.name}, a Claude Code mod`, body, path: `mods/${m.slug}/`, nav: 'mods' })
}

function indexPage(views: View[], stats: { total: number; fresh: number; authors: number }): string {
  const sorted = [...views].sort((a, b) => b.rank - a.rank)
  const body = `
<section class="hero"><div class="wrap">
  <h1>The <em>mod shop</em> for Claude Code.</h1>
  <p class="lead">Every mod on GitHub, scraped daily, rendered into a preview of what it does to your terminal, and installable in two commands. Mods are small TypeScript functions that change how Claude Code works: panes, bands, guards, commands, redrawn rows.</p>
  <div class="stats"><span><b>${stats.total}</b> mods</span><span><b>${stats.fresh}</b> new this week</span><span><b>${stats.authors}</b> authors</span><span>needs Claude Code <b>2.1.287+</b></span></div>
  <div class="install-hero">
    <div class="tiny">Install slopshopper's own mods:</div>
    ${cmdBlock([`claude plugin marketplace add ${REPO}`])}
    <div class="tiny">Or every community mod through one marketplace:</div>
    ${cmdBlock([`claude plugin marketplace add ${COMMUNITY_MARKETPLACE_URL}`])}
  </div>
</div></section>
<div class="toolbar"><div class="wrap">
  <input id="q" class="search" type="search" placeholder="search mods (name, author, event, keyword)" autocomplete="off">
  <div class="chips">${FILTER_TAGS.map(t => `<button class="chip" data-f="${t}">${esc(TAG_LABELS[t] ?? t)}</button>`).join('')}</div>
  <select id="sort" class="sort"><option value="rank">sort: featured</option><option value="new">newest</option><option value="updated">recently updated</option><option value="stars">stars</option><option value="name">name</option></select>
  <span id="count" class="tiny"></span>
</div></div>
<main class="wrap">
  <div class="section-h"><h2>All mods</h2><span class="tiny">previews are replays of a scripted session in a sandbox</span></div>
  <div class="grid" id="grid">${sorted.map(card).join('\n')}</div>
</main>`
  return layout({ title: 'slopshopper · the mod shop for Claude Code', description: `${stats.total} Claude Code mods, scraped from GitHub, each with a visual preview and install commands.`, body, path: '', nav: 'mods' })
}

function newPage(views: View[]): string {
  const sorted = [...views].sort((a, b) => new Date(b.mod.firstSeen).getTime() - new Date(a.mod.firstSeen).getTime()).slice(0, 120)
  const body = `<main class="wrap"><div class="section-h" style="margin-top:40px"><h2>New mods</h2><span class="tiny">by the date slopshopper first saw them · <a href="${u('feed.xml')}">rss</a></span></div>
<div class="list">${sorted.map(v => `<div class="row"><span class="d">${esc(fmtDate(v.mod.firstSeen))}</span><span><a href="${u(`mods/${v.mod.slug}/`)}"><b class="mono">${esc(title(v.mod))}</b></a> <span class="muted">— ${esc(v.mod.description.slice(0, 140))}</span></span><span class="d">${esc(v.mod.repo.fullName)}</span></div>`).join('')}</div></main>`
  return layout({ title: 'New Claude Code mods · slopshopper', description: 'The newest Claude Code mods found on GitHub.', body, path: 'new/', nav: 'new' })
}

function aboutPage(stats: { total: number }): string {
  const body = `<main class="wrap prose" style="padding-top:40px">
<h1>How slopshopper works</h1>
<p class="lead muted">A mod is a Claude Code plugin whose <code>hooks/hooks.json</code> names a <code>modules</code> array: a TypeScript or JavaScript file exporting <code>register(on)</code>, where each <code>on('event', hook)</code> can observe, rewrite or answer an engine event. Anthropic documents them at <a href="https://code.claude.com/docs/en/plugins/mods/overview">code.claude.com</a>; the feature shipped on by default in Claude Code 2.1.287.</p>
<h2>Scraping</h2>
<p>Once a day a GitHub Actions job runs code search for the fingerprints of a mod (<code>"modules" filename:hooks.json</code>, imports from <code>claude-code</code>, <code>$.ui.resolve</code>, …) plus repository topics. Every candidate repository's tree is walked and every <code>hooks/hooks.json</code> is read: only a file with a non-empty <code>modules</code> array counts. The mod's manifest, hooks module and its relative imports, README and last commit date are recorded. Forks with fewer than five stars are skipped. Nothing is re-hosted: install commands point at each author's repository.</p>
<h2>Previews</h2>
<p>Each mod's hooks module is bundled and loaded into a fresh JavaScript realm (<code>node:vm</code>) with a fake mods API. A scripted session plays through it: a session start, a prompt, a turn with a <code>Read</code>, a <code>Grep</code>, an <code>Edit</code>, a <code>Write</code> that contains a TODO, a failing <code>bun test</code>, a risky <code>rm -rf … && git push --force</code>, a <code>cat .env</code> with secrets, then <code>turn.complete</code> and <code>session.measure</code> with real-looking token figures. Every command the mod registers is run once. Then each render site is asked to draw. The trees come back as data and a small text-grid layout engine draws them the way the terminal would. A pane captured while a mod was holding a tool call is marked as such.</p>
<p>The fake API answers from canned data: <code>$.process.run</code> knows a few git and test commands, <code>$.fs.read</code> a handful of files, <code>$.http.fetch</code> always fails, <code>$.model.complete</code> replies <code>OK</code>, <code>$.ui.ask</code> picks the first option. So a preview shows the shape of a mod, not its behaviour on your machine. The facts panel (events, calls, state, env) comes from <code>claude plugin validate --json</code>, which reads the source without running it.</p>
<h2>Trust</h2>
<p>A mod runs inside Claude Code with your permissions: it can read and write files, start processes, make network requests, and approve tool calls. slopshopper lists what the scraper found and does not vet it. Before installing anything, read its source (every page shows it) and run <code>claude plugin validate</code> on a clone; the <code>calls:</code> line is the inventory of what it reaches.</p>
<h2>Getting listed</h2>
<p>Push a public repository with a mod in it. The next scrape finds it through code search; if it does not appear within a couple of days, open an issue on <a href="https://github.com/${REPO}">${REPO}</a> with the repository name. A <code>.claude-plugin/plugin.json</code> with <code>name</code>, <code>description</code>, <code>author</code>, <code>license</code> and <code>homepage</code> makes a better listing, and a <code>.claude-plugin/marketplace.json</code> at the repository root gets your own install command shown first.</p>
<h2>The community marketplace</h2>
<p><code>${esc(COMMUNITY_MARKETPLACE_URL)}</code> is a generated marketplace file listing the ${stats.total} mods on this site, each with a <code>github</code> or <code>git-subdir</code> source pointing at the author's repository. Add it once with <code>claude plugin marketplace add &lt;url&gt;</code> and install any mod as <code>name@slopshopper-community</code>. Entry names are the mod's own name, suffixed with the author's login when two mods share a name.</p>
<h2>Running it yourself</h2>
<pre><code>git clone https://github.com/${REPO}
cd slopshopper && bun install
bun run scrape      # needs a GitHub token (gh auth token is picked up)
bun run previews    # needs the claude CLI for validate
bun run build && bun run dev</code></pre>
</main>`
  return layout({ title: 'How slopshopper works', description: 'How slopshopper scrapes GitHub for Claude Code mods and renders previews of them.', body, path: 'about/', nav: 'about' })
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
  await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })
  const index = existsSync(join(DATA, 'mods.json')) ? ((await Bun.file(join(DATA, 'mods.json')).json()) as Index) : { generatedAt: '', mods: [] }
  const mods: ModEntry[] = [...(await localMods()), ...index.mods]
  for (const m of mods) {
    if (Object.keys(m.files).length) continue
    const f = Bun.file(join(DATA, 'mods', `${m.slug}.json`))
    if (await f.exists()) m.files = ((await f.json()) as { files: Record<string, string> }).files
  }
  // community entry names: a mod's name, suffixed by owner on a clash
  const nameCount = new Map<string, number>()
  for (const m of mods) if (m.kind === 'community') nameCount.set(m.name.toLowerCase(), (nameCount.get(m.name.toLowerCase()) ?? 0) + 1)
  const views: View[] = []
  for (const m of mods) {
    const pf = Bun.file(join(DATA, 'previews', `${m.slug}.json`))
    const preview = (await pf.exists()) ? ((await pf.json()) as Preview) : null
    const tags = tagsOf(m, preview)
    const updated = m.modUpdatedAt || m.repo.pushedAt
    const isNew = Date.now() - new Date(m.firstSeen).getTime() < NEW_DAYS * 86_400_000 && m.kind !== 'builtin'
    const mock = preview?.harness.ok ? mockup(preview, m.name) : null
    const days = (Date.now() - new Date(updated).getTime()) / 86_400_000
    const rank = (m.kind === 'slopshopper' ? 30 : 0) + (m.kind === 'sample' ? 6 : 0) + Math.log2(m.repo.stars + 1) * 4 + (days < 14 ? 6 : days < 60 ? 3 : 0) + (mock?.hasDrawing ? 5 : 0) + (preview && !preview.validate.ok ? -25 : 2) + (m.readme ? 1 : 0)
    const entryName = (nameCount.get(m.name.toLowerCase()) ?? 0) > 1 ? `${m.name}-${m.repo.fullName.split('/')[0]!.toLowerCase()}` : m.name
    views.push({ mod: m, preview, tags, isNew, rank, thumb: thumbOf(preview, m, tags), mock, install: installFor(m, entryName), entryName, stars: m.repo.stars, updated })
  }
  const stats = { total: views.length, fresh: views.filter(v => v.isNew).length, authors: new Set(views.map(v => v.mod.repo.fullName.split('/')[0])).size }
  await Bun.write(join(DIST, 'index.html'), indexPage(views, stats))
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
  await Bun.write(join(DIST, '404.html'), layout({ title: 'Not found · slopshopper', description: 'Not found', body: `<main class="wrap" style="padding-top:60px"><h1>404</h1><p class="muted">No mod here. <a href="${u('')}">Back to the shop.</a></p></main>`, path: '404.html' }))
  await Bun.write(join(DIST, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#e07a4f"/><path d="M14 22h36l-4 24H18z" fill="none" stroke="#111" stroke-width="5" stroke-linejoin="round"/><path d="M22 22v-4a10 10 0 0 1 20 0v4" fill="none" stroke="#111" stroke-width="5"/></svg>`)
  await cp(join(ROOT, 'site', 'static'), DIST, { recursive: true })
  if (existsSync(join(ROOT, '.claude-plugin', 'marketplace.json'))) await cp(join(ROOT, '.claude-plugin', 'marketplace.json'), join(DIST, 'marketplace.json'))
  await Bun.write(join(DIST, '.nojekyll'), '')
  console.log(`built ${views.length} mods → ${DIST} (base ${BASE})`)
}

await main()
