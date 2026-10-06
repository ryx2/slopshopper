// slop-detector: catches slop as Claude writes it.
//
// tool.call (Write, Edit): scans the new text. A truncation marker such as
//   "// ... rest of the code" is refused outright: letting it through replaces
//   real code with a comment. Softer leftovers (TODO stubs, not-implemented
//   throws, debug prints, @ts-ignore, lorem ipsum) are recorded and toasted.
// turn.complete: a line under the answer counts the turn's findings.
// ui.render (AbovePrompt): the session's slop score and the latest finding.
// ui.render (Pane): /slop lists every finding, file by file.

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Finding } from '../types'

const PANE = 'slop-detector'
const MAX_FINDINGS = 200

const findings = atom({ plugin: 'slop-detector', key: 'findings' } as const, [])
const turnCount = atom({ plugin: 'slop-detector', key: 'turnCount' } as const, 0)
const turnFindings = atom({ plugin: 'slop-detector', key: 'turnFindings' } as const, 0)
const isHidden = atom({ plugin: 'slop-detector', key: 'isHidden' } as const, false)

type Pattern = { kind: string; weight: number; hard: boolean; test: RegExp }

// Order matters: the first pattern a line matches names it.
const PATTERNS: Pattern[] = [
  { kind: 'truncation', weight: 10, hard: true, test: /(\/\/|#|<!--|\/\*|--|;)\s*(\.\.\.|…)\s*(the\s+)?(rest|remaining|remainder|existing|other|previous|unchanged)\b/i },
  { kind: 'truncation', weight: 10, hard: true, test: /(\.\.\.|…)\s*(rest|remaining|remainder)\s+(of\s+)?(the\s+)?(code|file|function|implementation|class|component|module)/i },
  { kind: 'truncation', weight: 10, hard: true, test: /(\/\/|#|<!--|\/\*)\s*(existing|previous|original|unchanged)\s+(code|implementation|content|logic)\s*(stays|remains|unchanged|here|\.\.\.|…|-->|\*\/)?\s*$/i },
  { kind: 'truncation', weight: 10, hard: true, test: /(\/\/|#|\/\*)\s*(\.\.\.|…)\s*(same as before|unchanged|as before|omitted for brevity|etc\.?)\s*(\*\/)?\s*$/i },
  { kind: 'not-implemented', weight: 4, hard: false, test: /throw new Error\((['"`])not implemented|NotImplementedError|unimplemented!\(\)|todo!\(\)|raise NotImplementedError/i },
  { kind: 'todo-stub', weight: 3, hard: false, test: /(\/\/|#|\/\*|<!--)\s*(TODO|FIXME|HACK|XXX)\b.*\b(implement|fill in|finish|complete|placeholder|stub|later|real)\b/i },
  { kind: 'placeholder', weight: 3, hard: false, test: /\b(your (code|logic|implementation) (here|goes here)|insert (code|logic) here|implementation (goes|lives) here|add (your )?(code|logic) here|placeholder (code|value|implementation))\b/i },
  { kind: 'placeholder', weight: 2, hard: false, test: /^\s*(pass|return (null|None|undefined|\{\}|\[\]|0|""|''))\s*(#|\/\/)\s*(TODO|FIXME|stub|placeholder|implement)/i },
  { kind: 'lorem', weight: 2, hard: false, test: /\blorem ipsum\b|\bdolor sit amet\b/i },
  { kind: 'debug-print', weight: 2, hard: false, test: /^\s*(console\.log\((['"`])(here|debug|test|xxx|asdf|got here|hit|works?)\b|print\((['"])(here|debug|test|xxx|asdf)\b|debugger;?\s*$|binding\.pry|import pdb|breakpoint\(\))/i },
  { kind: 'ts-ignore', weight: 2, hard: false, test: /@ts-ignore|@ts-nocheck|eslint-disable(?!-next-line)\b|# type: ignore\s*$|#\s*noqa\s*$/i },
  { kind: 'todo', weight: 1, hard: false, test: /(\/\/|#|\/\*|<!--)\s*(TODO|FIXME)\b/i },
  { kind: 'any-cast', weight: 1, hard: false, test: /\bas any\b|:\s*any\b(?!\w)/ },
]

export const register: Register = (on, options) => {
  const strict = options.strict === true
  const ignore = String(options.ignore ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'slop', description: 'Review the slop that slop-detector found this session' })
    } catch {
      // the name is taken by another plugin; the band still works
    }
    return next(e)
  })

  on('command.run', { command: 'slop' }, async $ => {
    const list = await read($, findings)
    await $.ui.open({ id: PANE, title: 'Slop', focus: true, closeOnEscape: true })
    return { text: list.length === 0 ? 'No slop found this session.' : `${list.length} finding${list.length === 1 ? '' : 's'} this session, score ${scoreOf(list)}.` }
  })

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const file = String(e.file_path ?? '')
    if (ignore.some(frag => file.includes(frag))) return next(e)
    const text = e.tool === 'Write' ? String(e.content ?? '') : String(e.new_string ?? '')
    const turn = await read($, turnCount)
    const found = scan(file, text, turn)
    const blocking = found.filter(f => f.hard || (strict && f.weight >= 3))
    if (blocking.length > 0) {
      const first = blocking[0]!
      return {
        deny: `slop-detector refused this ${e.tool} to ${shortPath(file)}: line ${first.line} is a ${first.kind} ("${first.snippet.slice(0, 80)}"). ${
          first.hard ? 'A comment that stands in for code would delete the code it stands for. Write the complete content of the file, including every unchanged line.' : 'Write the real implementation instead of a placeholder.'
        }`,
      }
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || found.length === 0) return ran
    await update($, findings, list => [...list, ...found].slice(-MAX_FINDINGS))
    await update($, turnFindings, n => n + found.length)
    const worst = found.reduce((a, b) => (b.weight > a.weight ? b : a))
    $.ui.toast(`${found.length} slop finding${found.length === 1 ? '' : 's'} in ${shortPath(file)}: ${worst.kind} on line ${worst.line}`)
    return ran
  })

  on('turn.start', async ($, e, next) => {
    await update($, turnCount, n => n + 1)
    await update($, turnFindings, () => 0)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const n = await read($, turnFindings)
    if (n === 0) return result
    return { ...result, text: `slop-detector: ${n} finding${n === 1 ? '' : 's'} this turn · /slop to review` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, findings)
    if (e.props.hasSurvey || list.length === 0 || (await read($, isHidden))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const last = list[list.length - 1]!
    const score = scoreOf(list)
    return (
      <Box flexDirection="row" columnGap={2} paddingX={1}>
        <Text color={score >= 15 ? 'red' : score >= 6 ? 'yellow' : 'green'} bold>
          ⚠ slop {score}
        </Text>
        <Text dimColor>
          {list.length} finding{list.length === 1 ? '' : 's'} · latest: {last.kind} in {shortPath(last.file)}:{last.line}
        </Text>
        <Button key="review" label="Review" hotkey="r" plain onPress={() => $.ui.open({ id: PANE, title: 'Slop', focus: true, closeOnEscape: true })} />
        <Button key="hide" label="Hide" hotkey="h" plain dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, findings)
    const width = e.props.bodyColumns
    const byFile = new Map<string, Finding[]>()
    for (const f of list) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f])
    const rows = [...byFile.entries()].slice(-12)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold color="yellow">
            ⚠ slop-detector
          </Text>
          <Text dimColor>
            {list.length} finding{list.length === 1 ? '' : 's'} · score {scoreOf(list)}
          </Text>
        </Box>
        {list.length === 0 && <Text dimColor>Nothing yet. Findings appear as Claude writes files.</Text>}
        {rows.map(([file, items]) => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{shortPath(file)}</Text>
            {items.slice(-6).map(f => (
              <Box flexDirection="row" columnGap={1}>
                <Text color={f.hard ? 'red' : f.weight >= 3 ? 'yellow' : undefined}>{String(f.line).padStart(4)}</Text>
                <Text color="cyan">{f.kind}</Text>
                <Text dimColor wrap="truncate-end">
                  {f.snippet.slice(0, Math.max(10, width - 20))}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          <Button key="clear" label="Clear" hotkey="c" onPress={() => update($, findings, () => [])} />
          <Button key="close" label="Close" hotkey="q" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

/** Every slop finding in `text`, which is about to land in `file`. */
export function scan(file: string, text: string, turn: number): Finding[] {
  const out: Finding[] = []
  const lines = text.split('\n')
  const seen = new Map<string, number>()
  for (let i = 0; i < lines.length && out.length < 20; i++) {
    const raw = lines[i]!
    const line = raw.trim()
    if (line.length === 0) continue
    const p = PATTERNS.find(x => x.test.test(raw))
    if (p) {
      out.push({ file, line: i + 1, kind: p.kind, snippet: line, weight: p.weight, hard: p.hard, turn })
      continue
    }
    if (raw.length > 400 && !/^\s*(import|export|["'`]|\/\/|#|\*|data:)/.test(raw) && !/[,;]\s*$/.test(raw.slice(0, 120)) && !file.endsWith('.json')) {
      out.push({ file, line: i + 1, kind: 'long-line', snippet: line.slice(0, 60) + '…', weight: 1, hard: false, turn })
      continue
    }
    if (line.length > 24 && !/^[}\])]+[;,]?$/.test(line) && !/^(import|export|return|break|continue|else|try|catch|finally|\*|\/\/|#)\b/.test(line)) {
      const n = (seen.get(line) ?? 0) + 1
      seen.set(line, n)
      if (n === 4) out.push({ file, line: i + 1, kind: 'duplicate-lines', snippet: line, weight: 1, hard: false, turn })
    }
  }
  return out
}

export function scoreOf(list: readonly Finding[]): number {
  return list.reduce((n, f) => n + f.weight, 0)
}

export function shortPath(file: string): string {
  const parts = file.split('/').filter(Boolean)
  return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/')
}
