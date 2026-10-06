// Draws a mod's element tree the way the terminal does, as HTML: a small
// text-grid layout engine over Ink-style Box/Text props, plus the terminal's
// own drawing of Button, Input, Select, Link, Code, Markdown and Raster.
//
// A rendered block is an array of lines; each line is an array of cells,
// each cell one character with its style. Blocks compose by rows and
// columns, then serialize to <span>s. Widths are measured in cells, which the
// page draws with a monospace font, so what the terminal would show lines up.

import type { Tree, TreeChild } from './types'

export type Style = { color?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; inverse?: boolean; cls?: string }
export type Cell = { ch: string; st: Style }
export type Block = Cell[][]

const PALETTE: Record<string, string> = {
  black: '#1b1b1b', red: '#e5484d', green: '#3dd68c', yellow: '#f5c542', blue: '#6ea0ff', magenta: '#d87cf5', cyan: '#4fc3d9', white: '#e8e8e8', gray: '#8a8a8a', grey: '#8a8a8a',
  blackbright: '#5a5a5a', redbright: '#ff6b6b', greenbright: '#5ff0a8', yellowbright: '#ffe066', bluebright: '#8ab4ff', magentabright: '#ee9cff', cyanbright: '#7fe0ef', whitebright: '#ffffff',
  // theme keys a mod may name
  accent: '#d97757', claude: '#d97757', success: '#3dd68c', error: '#e5484d', warning: '#f5c542', suggestion: '#6ea0ff', permission: '#8ab4ff', text: '#e8e8e8', secondarytext: '#8a8a8a', inactive: '#6a6a6a', diffadded: '#2d5a3a', diffremoved: '#6b2a2e',
}

export function colorOf(c: unknown): string | undefined {
  if (typeof c !== 'string' || !c) return undefined
  const k = c.toLowerCase()
  if (PALETTE[k]) return PALETTE[k]
  if (/^#[0-9a-f]{3,8}$/i.test(c) || /^rgb/i.test(c) || /^hsl/i.test(c)) return c
  const m = /^ansi256\((\d+)\)$/.exec(c)
  if (m) return ansi256(Number(m[1]))
  if (/^[a-z]+$/.test(k)) return k // a CSS color name
  return undefined
}

function ansi256(n: number): string {
  if (n < 16) return ['#000', '#c00', '#0c0', '#cc0', '#00c', '#c0c', '#0cc', '#ccc', '#555', '#f55', '#5f5', '#ff5', '#55f', '#f5f', '#5ff', '#fff'][n]!
  if (n < 232) {
    const i = n - 16
    const r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40)
    return `rgb(${v(r)},${v(g)},${v(b)})`
  }
  const g = 8 + (n - 232) * 10
  return `rgb(${g},${g},${g})`
}

const cell = (ch: string, st: Style = {}): Cell => ({ ch, st })
const spaces = (n: number, st: Style = {}): Cell[] => Array.from({ length: Math.max(0, n) }, () => cell(' ', st))
const widthOf = (b: Block) => b.reduce((w, l) => Math.max(w, l.length), 0)
const heightOf = (b: Block) => b.length

/** Display width of a character: wide CJK/emoji count 2, combining marks 0. */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp >= 0x300 && cp <= 0x36f) return 0
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfe0f) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

/** Lays text into cells, honoring wide characters by padding with a zero-width filler. */
function textCells(s: string, st: Style): Cell[] {
  const out: Cell[] = []
  for (const ch of s) {
    const w = charWidth(ch)
    if (w === 0) {
      if (out.length) out[out.length - 1]!.ch += ch
      continue
    }
    out.push(cell(ch, st))
    if (w === 2) out.push(cell('', st))
  }
  return out
}

function wrapCells(cells: Cell[], width: number, mode: string): Cell[][] {
  if (width <= 0 || cells.length <= width) return [cells]
  if (mode === 'truncate' || mode === 'truncate-end' || mode === 'end') return [[...cells.slice(0, Math.max(0, width - 1)), cell('…', cells[0]?.st)]]
  if (mode === 'truncate-start') return [[cell('…', cells[0]?.st), ...cells.slice(cells.length - width + 1)]]
  if (mode === 'truncate-middle' || mode === 'middle') {
    const half = Math.floor((width - 1) / 2)
    return [[...cells.slice(0, half), cell('…', cells[0]?.st), ...cells.slice(cells.length - (width - 1 - half))]]
  }
  // word wrap
  const lines: Cell[][] = []
  let line: Cell[] = []
  let word: Cell[] = []
  const flushWord = () => {
    if (!word.length) return
    if (line.length + word.length > width && line.length) {
      lines.push(line)
      line = []
    }
    while (word.length > width) {
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    line.push(...word)
    word = []
  }
  for (const c of cells) {
    if (c.ch === ' ') {
      flushWord()
      if (line.length < width) line.push(c)
      else {
        lines.push(line)
        line = []
      }
    } else word.push(c)
  }
  flushWord()
  if (line.length || !lines.length) lines.push(line)
  return lines
}

type Ctx = { width: number; style: Style; surface: 'terminal' | 'desktop' }

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const isTree = (c: TreeChild): c is Tree => !!c && typeof c === 'object'

function styleFrom(props: Record<string, unknown>, parent: Style): Style {
  const st: Style = { ...parent }
  const c = colorOf(props.color)
  if (c) st.color = c
  const bg = colorOf(props.backgroundColor)
  if (bg) st.bg = bg
  if (props.bold) st.bold = true
  if (props.dimColor) st.dim = true
  if (props.italic) st.italic = true
  if (props.underline) st.underline = true
  if (props.strikethrough) st.strike = true
  if (props.inverse) st.inverse = true
  return st
}

/** Collects the inline text of a Text element (strings and nested Text). */
function inlineCells(children: TreeChild[], st: Style, ctx: Ctx): Cell[] {
  const out: Cell[] = []
  for (const c of children) {
    if (typeof c === 'string' || typeof c === 'number') out.push(...textCells(String(c), st))
    else if (isTree(c)) {
      if (c.type === 'Text') out.push(...inlineCells(c.children ?? [], styleFrom(c.props ?? {}, st), ctx))
      else if (c.type === 'engine') out.push(...textCells('⟨engine⟩', { ...st, dim: true }))
      else {
        // a non-text child inside Text: draw it inline on one line
        const b = render(c, { ...ctx, style: st })
        out.push(...(b[0] ?? []))
      }
    }
  }
  return out
}

export function render(node: TreeChild, ctx: Ctx): Block {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return wrapCells(textCells(String(node), ctx.style), ctx.width, 'wrap')
  if (Array.isArray(node)) return column((node as TreeChild[]).map(n => render(n, ctx)), 0)
  const t = node as Tree
  if (t.type === 'engine') {
    const p = (t as { props?: Record<string, unknown> }).props
    if (p && typeof p.word === 'string') return [textCells(`✻ ${p.word}${p.suffix ?? ''}…`, { ...ctx.style, color: PALETTE.accent })]
    return [textCells("⟨Claude Code's own drawing⟩", { ...ctx.style, dim: true })]
  }
  const props = (t as { props?: Record<string, unknown> }).props ?? {}
  const children = (t as { children?: TreeChild[] }).children ?? []
  switch (t.type) {
    case 'Text': {
      const st = styleFrom(props, ctx.style)
      const cells = inlineCells(children, st, ctx)
      const lines = cells.length ? splitNewlines(cells) : [[]]
      return lines.flatMap(l => wrapCells(l, ctx.width, String(props.wrap ?? 'wrap')))
    }
    case 'Box':
      return renderBox(props, children, ctx)
    case 'Button': {
      const label = String(props.label ?? (typeof children[0] === 'string' ? children[0] : props.key ?? ''))
      const dim = Boolean(props.dimColor)
      const primary = props.variant === 'primary'
      const st: Style = { ...ctx.style, dim: dim || undefined, color: primary ? PALETTE.accent : ctx.style.color, cls: 'btn' }
      if (props.plain) {
        if (typeof props.hotkey === 'string' && props.hotkey) return [[...textCells(props.hotkey, { ...st, color: PALETTE.accent, dim: undefined }), ...textCells(': ' + label, st)]]
        return [textCells(label, st)]
      }
      return [textCells(`[ ${label} ]`, st)]
    }
    case 'Input': {
      const label = props.label ? `${props.label}: ` : ''
      const value = typeof props.value === 'string' && props.value ? props.value : ''
      const body = value ? textCells(value, ctx.style) : textCells(String(props.placeholder ?? ''), { ...ctx.style, dim: true })
      const submit = props.submitLabel ? textCells(` ⏎ ${props.submitLabel}`, { ...ctx.style, dim: true }) : []
      return [[...textCells(label, { ...ctx.style, bold: Boolean(props.autoFocus) || undefined }), ...body, ...submit]]
    }
    case 'Select': {
      const opts = Array.isArray(props.options) ? (props.options as { value: unknown; label?: string }[]) : []
      const cur = opts.find(o => o.value === props.value) ?? opts[0]
      const label = props.label ? `${props.label}: ` : ''
      return [[...textCells(label, ctx.style), ...textCells(String(cur?.label ?? cur?.value ?? ''), ctx.style), ...textCells(' ▾', { ...ctx.style, dim: true })]]
    }
    case 'Link': {
      const href = String(props.href ?? '')
      const label = props.label ? String(props.label) : ''
      return [[...textCells(label ? label + ' ' : '', { ...ctx.style, underline: true }), ...textCells(href, { ...ctx.style, dim: true })]]
    }
    case 'Code':
      return renderCode(props, ctx)
    case 'Markdown':
      return renderMarkdown(String(props.text ?? ''), ctx)
    case 'Raster':
      return renderRaster(props, ctx)
    case 'Image':
      return [textCells(`▣ ${props.alt ? String(props.alt) : 'image'}`, { ...ctx.style, dim: true })]
    case 'Svg':
      return [textCells(`▣ ${props.alt ? String(props.alt) : 'svg'}`, { ...ctx.style, dim: true })]
    case 'Client':
      return [textCells(`▣ client module ${props.module ?? ''}`, { ...ctx.style, dim: true })]
    default:
      return [textCells(`⟨${t.type}⟩`, { ...ctx.style, dim: true })]
  }
}

function splitNewlines(cells: Cell[]): Cell[][] {
  const lines: Cell[][] = [[]]
  for (const c of cells) {
    if (c.ch === '\n') lines.push([])
    else lines[lines.length - 1]!.push(c)
  }
  return lines
}

function padBlock(b: Block, width: number, st: Style = {}): Block {
  return b.map(l => (l.length < width ? [...l, ...spaces(width - l.length, st)] : l))
}

function column(blocks: Block[], gap: number): Block {
  const out: Block = []
  blocks.forEach((b, i) => {
    if (i > 0 && gap > 0) for (let k = 0; k < gap; k++) out.push([])
    out.push(...b)
  })
  return out
}

function row(blocks: Block[], gap: number, st: Style = {}): Block {
  const h = Math.max(0, ...blocks.map(heightOf))
  const out: Block = Array.from({ length: h }, () => [])
  blocks.forEach((b, i) => {
    const w = widthOf(b)
    for (let y = 0; y < h; y++) {
      if (i > 0 && gap > 0) out[y]!.push(...spaces(gap, st))
      const line = b[y] ?? []
      out[y]!.push(...line, ...spaces(w - line.length, st))
    }
  })
  return out
}

const BORDERS: Record<string, [string, string, string, string, string, string]> = {
  single: ['┌', '┐', '└', '┘', '─', '│'],
  double: ['╔', '╗', '╚', '╝', '═', '║'],
  round: ['╭', '╮', '╰', '╯', '─', '│'],
  bold: ['┏', '┓', '┗', '┛', '━', '┃'],
  classic: ['+', '+', '+', '+', '-', '|'],
  singleDouble: ['╓', '╖', '╙', '╜', '─', '║'],
  doubleSingle: ['╒', '╕', '╘', '╛', '═', '│'],
  arrow: ['↘', '↙', '↗', '↖', '→', '↓'],
}

function renderBox(props: Record<string, unknown>, children: TreeChild[], ctx: Ctx): Block {
  if (props.display === 'none') return []
  const st: Style = { ...ctx.style }
  const bg = colorOf(props.backgroundColor)
  if (bg) st.bg = bg
  const dir = String(props.flexDirection ?? 'row')
  const border = typeof props.borderStyle === 'string' ? BORDERS[props.borderStyle] ?? BORDERS.single : undefined
  const pad = (side: 'Left' | 'Right' | 'Top' | 'Bottom', axis: 'X' | 'Y') => num(props[`padding${side}`], num(props[`padding${axis}`], num(props.padding)))
  const mar = (side: 'Left' | 'Right' | 'Top' | 'Bottom', axis: 'X' | 'Y') => num(props[`margin${side}`], num(props[`margin${axis}`], num(props.margin)))
  const pl = pad('Left', 'X'), pr = pad('Right', 'X'), pt = pad('Top', 'Y'), pb = pad('Bottom', 'Y')
  const ml = mar('Left', 'X'), mr = mar('Right', 'X'), mt = mar('Top', 'Y'), mb = mar('Bottom', 'Y')
  const chrome = pl + pr + (border ? 2 : 0) + ml + mr
  const fixedWidth = typeof props.width === 'number' ? props.width : typeof props.width === 'string' && props.width.endsWith('%') ? Math.floor((ctx.width * parseFloat(props.width)) / 100) : undefined
  const inner = Math.max(1, (fixedWidth ?? ctx.width) - chrome)
  const gap = num(props.gap)
  const rowGap = num(props.rowGap, gap), colGap = num(props.columnGap, gap)
  const kids = children.filter(c => c !== null && c !== undefined && typeof c !== 'boolean')

  let body: Block
  if (dir.startsWith('column')) {
    const blocks = kids.map(k => render(k, { ...ctx, style: st, width: inner }))
    if (dir === 'column-reverse') blocks.reverse()
    body = column(blocks, rowGap)
    const align = String(props.alignItems ?? 'stretch')
    if (align === 'center' || align === 'flex-end') {
      const w = fixedWidth ? inner : widthOf(body)
      body = body.map(l => {
        const extra = Math.max(0, (fixedWidth ? inner : ctx.width) - l.length)
        const left = align === 'center' ? Math.floor(extra / 2) : extra
        return [...spaces(Math.min(left, Math.max(0, inner - l.length)), st), ...l]
      })
      void w
    }
  } else {
    // row: give each child a share; a child with flexGrow takes what is left
    const blocks: Block[] = []
    let used = 0
    const measured = kids.map(k => {
      const b = render(k, { ...ctx, style: st, width: inner })
      return { k, b, w: widthOf(b) }
    })
    const grows = measured.filter(m => isTree(m.k) && num((m.k as Tree & { props?: Record<string, unknown> }).props?.flexGrow) > 0)
    const fixed = measured.reduce((n, m) => n + m.w, 0) + colGap * Math.max(0, measured.length - 1)
    const spare = Math.max(0, inner - fixed)
    for (const m of measured) {
      const grow = isTree(m.k) ? num((m.k as Tree & { props?: Record<string, unknown> }).props?.flexGrow) : 0
      if (grow > 0 && grows.length) {
        const share = Math.floor(spare / grows.length)
        blocks.push(padBlock(m.b, m.w + share, st))
      } else blocks.push(m.b)
      used += widthOf(blocks[blocks.length - 1]!)
    }
    if (dir === 'row-reverse') blocks.reverse()
    body = row(blocks, colGap, st)
    const justify = String(props.justifyContent ?? 'flex-start')
    const total = widthOf(body)
    if (justify !== 'flex-start' && total < inner) {
      const extra = inner - total
      if (justify === 'center') body = body.map(l => [...spaces(Math.floor(extra / 2), st), ...l])
      else if (justify === 'flex-end') body = body.map(l => [...spaces(extra, st), ...l])
      else if (justify === 'space-between' && blocks.length > 1) {
        const g = Math.floor(extra / (blocks.length - 1))
        body = row(blocks, colGap + g, st)
      }
    }
    void used
  }

  // stretch: a bordered box or one with a fixed width fills its line
  let width = widthOf(body)
  if (fixedWidth !== undefined) width = inner
  else if (border || bg) width = Math.max(width, inner)
  if (typeof props.minWidth === 'number') width = Math.max(width, props.minWidth - chrome)
  body = padBlock(body, width, st)
  const minH = typeof props.height === 'number' ? props.height - (border ? 2 : 0) - pt - pb : typeof props.minHeight === 'number' ? props.minHeight - (border ? 2 : 0) - pt - pb : 0
  while (body.length < minH) body.push(spaces(width, st))
  // padding
  let out: Block = [...Array.from({ length: pt }, () => spaces(width, st)), ...body, ...Array.from({ length: pb }, () => spaces(width, st))]
  out = out.map(l => [...spaces(pl, st), ...l, ...spaces(pr, st)])
  // border
  if (border) {
    const bst: Style = { ...st, color: colorOf(props.borderColor) ?? st.color, dim: props.borderDimColor ? true : st.dim }
    const [tl, tr, bl, br, hz, vt] = border
    const w = widthOf(out)
    const top = [cell(tl, bst), ...textCells(hz.repeat(w), bst), cell(tr, bst)]
    const bottom = [cell(bl, bst), ...textCells(hz.repeat(w), bst), cell(br, bst)]
    out = [top, ...out.map(l => [cell(vt, bst), ...l, ...spaces(w - l.length, st), cell(vt, bst)]), bottom]
  }
  // margin
  out = out.map(l => [...spaces(ml), ...l, ...spaces(mr)])
  out = [...Array.from({ length: mt }, () => []), ...out, ...Array.from({ length: mb }, () => [])]
  return out
}

function renderCode(props: Record<string, unknown>, ctx: Ctx): Block {
  const src = String(props.source ?? props.code ?? '')
  const lines = src.replace(/\r/g, '').split('\n')
  if (props.format === 'diff') {
    let oldN = 0, newN = 0
    const out: Block = []
    for (const l of lines) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
      if (m) {
        oldN = Number(m[1])
        newN = Number(m[2])
        continue
      }
      if (l.startsWith('+')) {
        out.push([...textCells(String(newN++).padStart(4) + ' ', { ...ctx.style, dim: true }), ...textCells('+' + l.slice(1), { ...ctx.style, bg: PALETTE.diffadded })])
      } else if (l.startsWith('-')) {
        out.push([...textCells(String(oldN++).padStart(4) + ' ', { ...ctx.style, dim: true }), ...textCells('-' + l.slice(1), { ...ctx.style, bg: PALETTE.diffremoved })])
      } else {
        out.push([...textCells(String(newN++).padStart(4) + ' ', { ...ctx.style, dim: true }), ...textCells(' ' + l.replace(/^ /, ''), ctx.style)])
        oldN++
      }
    }
    return out
  }
  const start = typeof props.startLine === 'number' ? props.startLine : undefined
  const w = start !== undefined ? String(start + lines.length).length : 0
  return lines.map((l, i) => [
    ...(start !== undefined ? textCells(String(start + i).padStart(w) + ' ', { ...ctx.style, dim: true }) : []),
    ...highlight(l, ctx.style),
  ])
}

function highlight(line: string, st: Style): Cell[] {
  const out: Cell[] = []
  const re = /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|import|export|from|async|await|class|new|def|fn|pub|use|struct|impl|match|try|catch|throw|type|interface)\b|\b(\d+(?:\.\d+)?)\b/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    out.push(...textCells(line.slice(last, m.index), st))
    const color = m[1] ? PALETTE.gray : m[2] ? PALETTE.green : m[3] ? PALETTE.magenta : PALETTE.yellow
    out.push(...textCells(m[0], { ...st, color }))
    last = m.index + m[0].length
  }
  out.push(...textCells(line.slice(last), st))
  return out
}

function renderMarkdown(text: string, ctx: Ctx): Block {
  const out: Block = []
  let inCode = false
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (/^```/.test(raw)) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      out.push([...spaces(2), ...highlight(raw, ctx.style)])
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (h) {
      out.push(...wrapCells(inlineMd(h[2]!, { ...ctx.style, bold: true }), ctx.width, 'wrap'))
      continue
    }
    const q = /^>\s?(.*)$/.exec(raw)
    if (q) {
      for (const l of wrapCells(inlineMd(q[1]!, { ...ctx.style, italic: true, dim: true }), ctx.width - 2, 'wrap')) out.push([cell('▎', { ...ctx.style, dim: true }), cell(' '), ...l])
      continue
    }
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(raw)
    if (li) {
      const indent = li[1]!.length
      for (const [i, l] of wrapCells(inlineMd(li[2]!, ctx.style), ctx.width - indent - 2, 'wrap').entries()) out.push([...spaces(indent), ...textCells(i === 0 ? '• ' : '  ', ctx.style), ...l])
      continue
    }
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw)
    if (ol) {
      const prefix = `${ol[2]}. `
      for (const [i, l] of wrapCells(inlineMd(ol[3]!, ctx.style), ctx.width - ol[1]!.length - prefix.length, 'wrap').entries()) out.push([...spaces(ol[1]!.length), ...textCells(i === 0 ? prefix : ' '.repeat(prefix.length), ctx.style), ...l])
      continue
    }
    if (raw.trim() === '') {
      out.push([])
      continue
    }
    out.push(...wrapCells(inlineMd(raw, ctx.style), ctx.width, 'wrap'))
  }
  // collapse doubled blank lines
  return out.filter((l, i) => !(l.length === 0 && out[i - 1]?.length === 0))
}

function inlineMd(s: string, st: Style): Cell[] {
  const out: Cell[] = []
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*|_([^_]+)_)|(\[([^\]]+)\]\(([^)]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    out.push(...textCells(s.slice(last, m.index), st))
    if (m[2]) out.push(...textCells(m[2], { ...st, bold: true }))
    else if (m[4]) out.push(...textCells(m[4], { ...st, color: PALETTE.cyan }))
    else if (m[6] || m[7]) out.push(...textCells(m[6] ?? m[7]!, { ...st, italic: true }))
    else if (m[9]) out.push(...textCells(m[9], { ...st, underline: true }), ...textCells(` ${m[10]}`, { ...st, dim: true }))
    last = m.index + m[0].length
  }
  out.push(...textCells(s.slice(last), st))
  return out
}

function renderRaster(props: Record<string, unknown>, ctx: Ctx): Block {
  const columns = num(props.columns), rows = num(props.rows)
  const cells = typeof props.cells === 'string' ? props.cells : ''
  if (!columns || !rows || !cells) return [textCells(`▦ raster ${columns}×${rows}`, { ...ctx.style, dim: true })]
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  } catch {
    return [textCells(`▦ raster ${columns}×${rows}`, { ...ctx.style, dim: true })]
  }
  const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
  const DEFAULT = 0x01000000
  const hex = (v: number) => (v === DEFAULT || v > 0xffffff ? undefined : '#' + v.toString(16).padStart(6, '0'))
  const out: Block = []
  for (let y = 0; y < rows; y++) {
    const line: Cell[] = []
    for (let x = 0; x < columns; x++) {
      const i = (y * columns + x) * 3
      if (i + 2 >= u32.length) break
      const ch = String.fromCodePoint(u32[i]! || 32)
      line.push(cell(ch, { color: hex(u32[i + 1]!), bg: hex(u32[i + 2]!) }))
    }
    out.push(line)
  }
  return out
}

// ---- serialization --------------------------------------------------------

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function styleAttr(st: Style): string {
  const parts: string[] = []
  let color = st.color, bg = st.bg
  if (st.inverse) [color, bg] = [bg ?? '#1b1b1b', color ?? '#e8e8e8']
  if (color) parts.push(`color:${color}`)
  if (bg) parts.push(`background:${bg}`)
  if (st.bold) parts.push('font-weight:700')
  if (st.dim) parts.push('opacity:.55')
  if (st.italic) parts.push('font-style:italic')
  const deco = [st.underline ? 'underline' : '', st.strike ? 'line-through' : ''].filter(Boolean).join(' ')
  if (deco) parts.push(`text-decoration:${deco}`)
  return parts.join(';')
}

/** Turns a block into HTML lines; a `width` pads every line to the same length. */
export function toHtml(block: Block, width?: number): string {
  const lines = block.map(line => {
    const w = width ?? line.length
    const padded = line.length < w ? [...line, ...spaces(w - line.length)] : line
    let html = ''
    let run: Cell[] = []
    let runKey = ''
    const flush = () => {
      if (!run.length) return
      const text = esc(run.map(c => c.ch).join(''))
      const attr = styleAttr(run[0]!.st)
      html += attr ? `<span style="${attr}">${text}</span>` : text
      run = []
    }
    for (const c of padded) {
      const key = JSON.stringify(c.st)
      if (key !== runKey) {
        flush()
        runKey = key
      }
      run.push(c)
    }
    flush()
    return html
  })
  return lines.join('\n')
}

export function renderToHtml(tree: TreeChild, width: number, surface: 'terminal' | 'desktop' = 'terminal'): { html: string; rows: number; block: Block } {
  const block = render(tree, { width, style: {}, surface })
  return { html: toHtml(block), rows: block.length, block }
}
