// burn-rate: a fuel gauge above the prompt.
//
// session.start, turn.complete, session.measure: take a reading of the
//   context window, the cost and the rate limits from $.session.usage(),
//   the same figures the status line shows. turn.complete also records the
//   turn's token counts for the sparkline.
// ui.render (AbovePrompt): one line: a bar for the window, the percent and
//   tokens, dollars and dollars per hour, the plan's window, the last turns.
// /burn prints the same figures as text, for a -p run or a narrow terminal.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Reading, TurnStat } from '../types'

const HISTORY = 16
const BARS = '▁▂▃▄▅▆▇█'

const reading = atom({ plugin: 'burn-rate', key: 'reading' } as const, null)
const turns = atom({ plugin: 'burn-rate', key: 'turns' } as const, [])
const isHidden = atom({ plugin: 'burn-rate', key: 'isHidden' } as const, false)
const hasWarned = atom({ plugin: 'burn-rate', key: 'hasWarned' } as const, false)

export const register: Register = (on, options) => {
  const warnAt = typeof options.warnAt === 'number' ? options.warnAt : 80

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await $.command.register({ name: 'burn', description: 'Context, tokens, cost and burn rate for this session' })
    } catch {
      // the name is taken; the band still draws
    }
    await takeReading($, warnAt)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const usage = e.usage
    if (usage) {
      const stat: TurnStat = { input: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens, output: usage.output_tokens, durationMs: e.durationMs }
      await update($, turns, list => [...list, stat].slice(-HISTORY))
    }
    await takeReading($, warnAt)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await takeReading($, warnAt)
    return next(e)
  })

  on('command.run', { command: 'burn' }, async $ => {
    const r = await read($, reading)
    const list = await read($, turns)
    if (r === null) return { text: 'burn-rate: no reading yet; send a prompt first.' }
    return { text: summary(r, list) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, reading)
    if (e.props.hasSurvey || r === null || (await read($, isHidden))) return next(e)
    const list = await read($, turns)
    const { Box, Text, Button } = $.ui.resolve(e)
    const color = colorFor(r.percent)
    const wide = e.props.bodyColumns >= 110
    const narrow = e.props.bodyColumns < 70
    return (
      <Box flexDirection="row" columnGap={2} paddingX={1}>
        <Text color={color}>{bar(r.percent, narrow ? 8 : 12)}</Text>
        <Text color={color} bold>
          {r.percent}%
        </Text>
        <Text dimColor>
          {short(r.tokens)}/{short(r.window)}
        </Text>
        {r.usd !== null && <Text>${r.usd.toFixed(2)}</Text>}
        {r.usdPerHour !== null && !narrow && <Text dimColor>${r.usdPerHour.toFixed(2)}/h</Text>}
        {r.limit !== null && !narrow && (
          <Text color={r.limit.percentUsed >= 90 ? 'red' : r.limit.percentUsed >= 70 ? 'yellow' : undefined} dimColor={r.limit.percentUsed < 70}>
            {limitLabel(r.limit.kind)} {r.limit.percentUsed}%
          </Text>
        )}
        {list.length > 0 && !narrow && (
          <Text dimColor>
            ⇅ {short(list[list.length - 1]!.input)}/{short(list[list.length - 1]!.output)}
          </Text>
        )}
        {list.length > 1 && wide && <Text color={color}>{sparkline(list)}</Text>}
        {r.percent >= warnAt && <Text color="red">compaction soon</Text>}
        <Button key="hide" label="×" plain dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}

async function takeReading($: EngineInterface, warnAt: number): Promise<void> {
  try {
    const usage = await $.session.usage()
    if (!usage.context || !usage.context.window) return
    const tokens = usage.context.tokens ?? 0
    const percent = Math.round(usage.context.percent ?? (tokens / usage.context.window) * 100)
    const at = await $.clock.now()
    const hours = Math.max(1 / 60, (at - usage.startedAt) / 3_600_000)
    const usd = usage.cost ? usage.cost.usd : null
    const tightest = usage.rateLimits.reduce<{ kind: string; percentUsed: number } | null>((best, w) => (best === null || w.percentUsed > best.percentUsed ? { kind: w.kind, percentUsed: Math.round(w.percentUsed) } : best), null)
    const next: Reading = { tokens, window: usage.context.window, percent, usd, usdPerHour: usd === null ? null : usd / hours, limit: tightest, at }
    await update($, reading, () => next)
    if (percent >= warnAt && !(await read($, hasWarned))) {
      await update($, hasWarned, () => true)
      $.ui.toast(`Context is ${percent}% full. /compact soon, or start a fresh session for unrelated work.`)
    }
  } catch {
    // no reading this time; the band keeps the last one
  }
}

function colorFor(percent: number): string {
  if (percent >= 90) return 'red'
  if (percent >= 75) return 'magenta'
  if (percent >= 50) return 'yellow'
  return 'green'
}

function bar(percent: number, cells: number): string {
  const full = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells)
  return '▮'.repeat(full) + '▯'.repeat(cells - full)
}

function sparkline(list: readonly TurnStat[]): string {
  const top = Math.max(1, ...list.map(t => t.input))
  return list.map(t => BARS[Math.min(BARS.length - 1, Math.floor((t.input / top) * (BARS.length - 1)))]).join('')
}

function limitLabel(kind: string): string {
  return kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind.replace(/_/g, ' ')
}

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function summary(r: Reading, list: readonly TurnStat[]): string {
  const lines = [`context ${r.percent}% (${short(r.tokens)} of ${short(r.window)})`]
  if (r.usd !== null) lines.push(`cost $${r.usd.toFixed(2)}${r.usdPerHour !== null ? ` · $${r.usdPerHour.toFixed(2)}/h` : ''}`)
  if (r.limit !== null) lines.push(`${limitLabel(r.limit.kind)} window ${r.limit.percentUsed}% used`)
  if (list.length) {
    const totalIn = list.reduce((n, t) => n + t.input, 0)
    const totalOut = list.reduce((n, t) => n + t.output, 0)
    lines.push(`${list.length} turn${list.length === 1 ? '' : 's'} recorded · ${short(totalIn)} in, ${short(totalOut)} out · last turns ${sparkline(list)}`)
  }
  return lines.join('\n')
}
