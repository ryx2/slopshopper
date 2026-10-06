// Composes a Claude Code terminal mockup around what a mod drew: the
// transcript, a docked pane, toasts, the band above the prompt, the spinner,
// the prompt box, the status line. Output is HTML for one <div class="tty">.

import type { Preview, Tree } from './types'
import { esc, render, toHtml, type Block, type Cell, type Style } from './render'

const COLS = 118
const PANE_COLS = 46
const ACCENT = '#d97757'
const DIM: Style = { dim: true }

const cells = (s: string, st: Style = {}): Cell[] => [...s].map(ch => ({ ch, st }))
const line = (s: string, st: Style = {}): Cell[] => cells(s, st)
const blank: Cell[] = []

type Site = Preview['harness']['sites'][keyof Preview['harness']['sites']]

function siteTree(s: unknown): Tree | null {
  const r = s as { ok?: unknown; tree?: Tree } | undefined
  return r && r.ok === true && r.tree ? r.tree : null
}
function engineProps(s: unknown): Record<string, unknown> | null {
  const r = s as { ok?: unknown; props?: Record<string, unknown> } | undefined
  return r && r.ok === 'engine' && r.props ? r.props : null
}

export type Mockup = { html: string; rows: number; hasDrawing: boolean; summary: string[] }

/** The full-width terminal mockup for a mod's preview. */
export function mockup(p: Preview, modName: string): Mockup {
  const h = p.harness
  const sites = h.sites ?? {}
  const panes = Object.entries(sites.Pane ?? {}).filter(([, r]) => siteTree(r))
  const hasPane = panes.length > 0
  const transcriptWidth = hasPane ? COLS - PANE_COLS - 3 : COLS
  const summary: string[] = []

  // ---- transcript column
  const t: Block = []
  t.push(blank)
  const userMsg = siteTree(sites.UserMessage)
  if (userMsg) {
    t.push(...render(userMsg, { width: transcriptWidth - 2, style: {}, surface: 'terminal' }).map(l => [...cells('  '), ...l]))
    summary.push('redraws your messages')
  } else t.push([...cells('› ', { color: '#8a8a8a' }), ...cells('fix the failing auth test and add an audit log call', { bg: '#2b2b2b' })])
  t.push(blank)
  for (const l of h.logs.slice(0, 2)) t.push([...cells('● ', DIM), ...cells(`${modName}: ${l}`, DIM)])
  const rowsFor = (tool: string, detail: string) => [...cells('⏺ ', { color: '#3dd68c' }), ...cells(tool, { bold: true }), ...cells(`(${detail})`)]
  t.push(rowsFor('Read', 'src/auth.ts'))
  t.push([...cells('  ⎿  ', DIM), ...cells('Read 6 lines', DIM)])
  const toolUse = siteTree(sites.ToolUse)
  if (toolUse) {
    t.push(...render(toolUse, { width: transcriptWidth, style: {}, surface: 'terminal' }))
    summary.push('redraws tool call rows')
  } else {
    t.push(rowsFor('Update', 'src/auth.ts'))
    t.push([...cells('  ⎿  ', DIM), ...cells('Added 2 lines, removed 1 line', DIM)])
  }
  const denied = h.denies[0]
  if (denied) {
    const [tool, detail] = denied.tool.split(': ')
    t.push(rowsFor(tool ?? 'Bash', detail ?? ''))
    t.push([...cells('  ⎿  ', DIM), ...cells(`Denied by ${modName}: `, { color: '#e5484d' }), ...cells(denied.reason.slice(0, transcriptWidth - 24 - modName.length), { color: '#e5484d' })])
    summary.push(`blocks ${h.denies.length} of the preview's risky tool calls`)
  } else {
    t.push(rowsFor('Bash', 'bun test'))
    t.push([...cells('  ⎿  ', DIM), ...cells('3 pass, 1 fail', DIM)])
  }
  t.push(blank)
  const asst = siteTree(sites.AssistantMessage)
  if (asst) {
    t.push(...render(asst, { width: transcriptWidth, style: {}, surface: 'terminal' }))
    summary.push("redraws Claude's replies")
  } else t.push([...cells('● ', { color: '#e8e8e8' }), ...cells('Done. refresh now rejects expired claims and logs an audit event.')])
  t.push(blank)
  const turnDur = siteTree(sites.TurnDuration)
  const turnProps = engineProps(sites.TurnDuration)
  if (turnDur) t.push(...render(turnDur, { width: transcriptWidth, style: {}, surface: 'terminal' }))
  else t.push([...cells('✻ ', { color: ACCENT }), ...cells(`${turnProps?.word ?? 'Worked'} for 42s · done 4:20 PM`, DIM)])
  if (turnDur || turnProps) summary.push('changes the turn summary line')
  const underAnswer = h.rewrites.find(r => r.event === 'turn.complete')
  if (underAnswer) t.push(cells(underAnswer.summary.replace(/^line under the answer: /, ''), DIM))
  for (const c of h.commands.slice(0, 1)) {
    t.push(blank)
    t.push([...cells('› ', { color: '#8a8a8a' }), ...cells(`/${c.name}`, { bg: '#2b2b2b' })])
    const cmdOut = siteTree(sites.CommandOutput)
    if (cmdOut) t.push(...render(cmdOut, { width: transcriptWidth, style: {}, surface: 'terminal' }).map(l => [...cells('  '), ...l]))
    else if (c.output) for (const l of c.output.split('\n').slice(0, 6)) t.push([...cells('  ⎿  ', DIM), ...cells(`${modName}: `, DIM), ...cells(l.slice(0, transcriptWidth - 8))])
  }
  for (const l of h.logs.slice(2, 4)) t.push([...cells('● ', DIM), ...cells(`${modName}: ${l}`, DIM)])

  // ---- pane column
  let paneBlock: Block = []
  if (hasPane) {
    const [id, r] = panes[0]!
    const title = (r as { title?: string }).title ?? h.panes.find(x => x.id === id)?.title ?? id
    const body = render(siteTree(r)!, { width: PANE_COLS - 2, style: {}, surface: 'terminal' }).map(l => (l.length > PANE_COLS - 2 ? l.slice(0, PANE_COLS - 2) : l))
    const top = [...cells('┃ ', { color: ACCENT }), ...cells(title, { bold: true, color: ACCENT }), ...cells(' '.repeat(Math.max(0, PANE_COLS - 4 - [...title].length)), {}), ...cells('✕', DIM)]
    paneBlock = [top, ...body.map(l => [...cells('┃ ', { color: ACCENT }), ...l])]
    summary.push(`opens a pane${panes.length > 1 ? ` (${panes.length} panes)` : ''}: ${title}`)
  }

  // ---- toasts over the transcript's top right
  const toastBlocks: Block = []
  for (const text of h.toasts.slice(-2)) {
    const w = Math.min(44, Math.max([...text].length, [...modName].length) + 2)
    const wrap = (s: string) => {
      const out: string[] = []
      let cur = ''
      for (const word of s.split(' ')) {
        if ((cur + ' ' + word).trim().length > w - 2 && cur) {
          out.push(cur)
          cur = word
        } else cur = (cur + ' ' + word).trim()
      }
      if (cur) out.push(cur)
      return out.slice(0, 3)
    }
    toastBlocks.push(cells('╭' + '─'.repeat(w) + '╮', DIM))
    toastBlocks.push([...cells('│ ', DIM), ...cells(modName.padEnd(w - 2), { bold: true, color: ACCENT }), ...cells(' │', DIM)])
    for (const l of wrap(text)) toastBlocks.push([...cells('│ ', DIM), ...cells(l.padEnd(w - 2)), ...cells(' │', DIM)])
    toastBlocks.push(cells('╰' + '─'.repeat(w) + '╯', DIM))
  }
  if (h.toasts.length) summary.push(`shows ${h.toasts.length} toast${h.toasts.length === 1 ? '' : 's'}`)

  // ---- compose the upper area
  const bodyRows = Math.max(hasPane ? 16 : 12, Math.min(26, Math.max(t.length, paneBlock.length) + 1))
  const upper: Block = []
  for (let y = 0; y < bodyRows; y++) {
    let l: Cell[] = [...(t[y] ?? [])]
    if (toastBlocks.length && y >= 1 && y - 1 < toastBlocks.length) {
      const tb = toastBlocks[y - 1]!
      const start = transcriptWidth - tb.length - 1
      while (l.length < start) l.push({ ch: ' ', st: {} })
      l = [...l.slice(0, start), ...tb]
    }
    while (l.length < transcriptWidth) l.push({ ch: ' ', st: {} })
    if (hasPane) l = [...l.slice(0, transcriptWidth), ...cells(' │ ', DIM), ...(paneBlock[y] ?? [])]
    upper.push(l)
  }

  // ---- spinner / band / prompt / status
  const lower: Block = []
  const spinnerTree = siteTree(sites.Spinner)
  const spinnerProps = engineProps(sites.Spinner)
  if (spinnerTree) {
    lower.push(...render(spinnerTree, { width: COLS, style: {}, surface: 'terminal' }))
    summary.push('replaces the spinner')
  } else if (spinnerProps) {
    lower.push([...cells('✻ ', { color: ACCENT }), ...cells(`${spinnerProps.word ?? 'Thinking'}${spinnerProps.suffix ?? ''}…`, { color: ACCENT })])
    summary.push('adds to the spinner')
  }
  const band = siteTree(sites.AbovePrompt)
  if (band) {
    lower.push(blank)
    lower.push(...render(band, { width: COLS - 2, style: {}, surface: 'terminal' }).map(l => [...cells(' '), ...l.slice(0, COLS - 2)]))
    summary.push('draws a band above the prompt')
  }
  lower.push(cells('─'.repeat(COLS), { color: '#3a3a3a' }))
  lower.push([...cells('› ', { color: '#8a8a8a' }), ...cells('')])
  const hint = siteTree(sites.PromptHint)
  if (hint) {
    lower.push(...render(hint, { width: COLS - 2, style: {}, surface: 'terminal' }).map(l => [...cells('  '), ...l]))
    summary.push('changes the hint under the prompt')
  } else lower.push([...cells('  ? for shortcuts', DIM)])
  if (h.status) {
    lower.push([...cells('  ⚠ ', { color: '#f5c542' }), ...cells(`${modName}: `, { color: '#f5c542' }), ...cells(h.status.slice(0, COLS - 8 - modName.length))])
    summary.push('pins a status line')
  }

  const all: Block = [...upper, ...lower]
  const html = toHtml(all, COLS)
  const hasDrawing = Boolean(band || hasPane || spinnerTree || spinnerProps || h.toasts.length || h.status || h.denies.length || userMsg || asst || toolUse || hint || h.commands.some(c => c.output))
  return { html, rows: all.length, hasDrawing, summary }
}

/** One site drawn on its own, for the detail page's gallery of sites. */
export function siteHtml(site: unknown, width: number, maxRows = 400): string | null {
  const tree = siteTree(site)
  if (!tree) return null
  const b = render(tree, { width, style: {}, surface: 'terminal' })
    .map(l => (l.length > width ? l.slice(0, width) : l))
    .slice(0, maxRows)
  return toHtml(b, width)
}

export { esc }
