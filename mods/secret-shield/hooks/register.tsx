// secret-shield: keeps secrets out of the transcript and out of the repo.
//
// tool.call (Write, Edit): refuses new text that contains a high-confidence
//   secret (an API key, a token, a private key, a password in a URL).
// tool.call (Bash): refuses a command line that embeds one, since the
//   command is stored in the transcript as typed.
// session.append (door tool-result): redacts secrets from a tool's result
//   before the model reads it and before the transcript stores it, so a
//   `cat .env` shows the variable names and not their values.
// ui.render (AbovePrompt): a count of what was redacted and refused.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ShieldEvent } from '../types'

const MAX_EVENTS = 200

const events = atom({ plugin: 'secret-shield', key: 'events' } as const, [])
const turnCount = atom({ plugin: 'secret-shield', key: 'turnCount' } as const, 0)
const isHidden = atom({ plugin: 'secret-shield', key: 'isHidden' } as const, false)

type Pattern = { kind: string; re: RegExp; high: boolean }

// High-confidence patterns refuse writes; every pattern redacts results.
const PATTERNS: Pattern[] = [
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{24,}/g, high: true },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, high: true },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g, high: true },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, high: true },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g, high: true },
  { kind: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g, high: true },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, high: true },
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, high: true },
  { kind: 'password-url', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|ftp|smtp):\/\/[^\s:@/]+:([^\s@/]{4,})@/g, high: true },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g, high: false },
  { kind: 'bearer-token', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{24,}/g, high: false },
  { kind: 'env-secret', re: /^(?:export\s+)?([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*['"]?([^'"\s#]{8,})['"]?/gm, high: false },
  { kind: 'assignment', re: /\b(?:api[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*['"]([^'"\s]{16,})['"]/gi, high: false },
]

export const register: Register = (on, options) => {
  const blockWrites = options.blockWrites !== false
  const redactResults = options.redactResults !== false

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'secrets', description: 'What secret-shield redacted and refused this session' })
    } catch {
      // name taken; the band still works
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, turnCount, n => n + 1)
    return next(e)
  })

  on('command.run', { command: 'secrets' }, async $ => {
    const list = await read($, events)
    if (list.length === 0) return { text: 'secret-shield: nothing redacted or refused this session.' }
    const counts = new Map<string, number>()
    for (const ev of list) counts.set(`${ev.action} ${ev.kind}`, (counts.get(`${ev.action} ${ev.kind}`) ?? 0) + 1)
    return { text: [...counts.entries()].map(([k, n]) => `${n}× ${k}`).join('\n') }
  })

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    if (!blockWrites) return next(e)
    const text = e.tool === 'Write' ? String(e.content ?? '') : String(e.new_string ?? '')
    const hit = firstSecret(text, true)
    if (hit === null) return next(e)
    await record($, { action: 'refused', kind: hit.kind, tool: e.tool, turn: await read($, turnCount) })
    $.ui.toast(`Refused a ${e.tool} to ${shortPath(String(e.file_path ?? ''))}: it contains a ${hit.kind}`)
    return {
      deny: `secret-shield refused this ${e.tool} to ${shortPath(String(e.file_path ?? ''))}: line ${hit.line} contains what looks like a ${hit.kind}. Never write a credential into a file. Read it from an environment variable or a secrets manager, and if the user pasted it, ask them to rotate it.`,
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!blockWrites) return next(e)
    const hit = firstSecret(String(e.command ?? ''), true)
    if (hit === null) return next(e)
    await record($, { action: 'refused', kind: hit.kind, tool: 'Bash', turn: await read($, turnCount) })
    $.ui.toast(`Refused a Bash command that embeds a ${hit.kind}`)
    return {
      deny: `secret-shield refused this command: it embeds what looks like a ${hit.kind}, and commands are kept in the transcript as typed. Pass the value through an environment variable (for example "$API_KEY") instead of pasting it.`,
    }
  })

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if (!redactResults) return next(e)
    let found: string | null = null
    const content = e.message.content.map(block => {
      if (block.type === 'text' && typeof block.text === 'string') {
        const r = redact(block.text)
        if (r.kind) found = found ?? r.kind
        return r.kind ? { ...block, text: r.text } : block
      }
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          const r = redact(block.content)
          if (r.kind) found = found ?? r.kind
          return r.kind ? { ...block, content: r.text } : block
        }
        if (Array.isArray(block.content)) {
          let changed = false
          const inner = (block.content as { type: string; text?: string }[]).map(part => {
            if (part.type !== 'text' || typeof part.text !== 'string') return part
            const r = redact(part.text)
            if (!r.kind) return part
            changed = true
            found = found ?? r.kind
            return { ...part, text: r.text }
          })
          return changed ? { ...block, content: inner } : block
        }
      }
      return block
    })
    if (found === null) return next(e)
    const tool = e.origin.kind === 'tool' ? String(e.origin.tool) : 'tool'
    await record($, { action: 'redacted', kind: found, tool, turn: await read($, turnCount) })
    $.ui.toast(`Redacted a ${found} from a ${tool} result before Claude read it`)
    return next({ ...e, message: { ...e.message, content } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, events)
    if (e.props.hasSurvey || list.length === 0 || (await read($, isHidden))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const redacted = list.filter(x => x.action === 'redacted').length
    const refused = list.filter(x => x.action === 'refused').length
    const last = list[list.length - 1]!
    return (
      <Box flexDirection="row" columnGap={2} paddingX={1}>
        <Text color="green" bold>
          ⛨ secret-shield
        </Text>
        {redacted > 0 && <Text>{redacted} redacted</Text>}
        {refused > 0 && <Text color="yellow">{refused} refused</Text>}
        <Text dimColor>
          latest: {last.kind} in a {last.tool} {last.action === 'redacted' ? 'result' : 'call'}
        </Text>
        <Button key="hide" label="Hide" hotkey="h" plain dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}

async function record($: EngineInterface, ev: ShieldEvent): Promise<void> {
  await update($, events, list => [...list, ev].slice(-MAX_EVENTS))
}

/** The first secret in `text`; only high-confidence kinds when `highOnly`. */
export function firstSecret(text: string, highOnly: boolean): { kind: string; line: number } | null {
  for (const p of PATTERNS) {
    if (highOnly && !p.high) continue
    p.re.lastIndex = 0
    const m = p.re.exec(text)
    if (m) return { kind: p.kind, line: text.slice(0, m.index).split('\n').length }
  }
  return null
}

/** `text` with every secret replaced by a marker, and the first kind found. */
export function redact(text: string): { text: string; kind: string | null } {
  let kind: string | null = null
  let out = text
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    if (!p.re.test(out)) continue
    kind = kind ?? p.kind
    p.re.lastIndex = 0
    out = out.replace(p.re, (whole: string, ...groups: unknown[]) => {
      // a value an earlier pattern already replaced is left as its marker
      if (p.kind === 'env-secret') return String(groups[1]).startsWith('[redacted') ? whole : `${String(groups[0])}=[redacted ${p.kind} by secret-shield]`
      if (p.kind === 'password-url') return whole.replace(String(groups[0]), '[redacted-password]')
      if (p.kind === 'assignment') return String(groups[0]).startsWith('[redacted') ? whole : whole.replace(String(groups[0]), '[redacted by secret-shield]')
      return `[redacted ${p.kind} by secret-shield]`
    })
  }
  return { text: out, kind }
}

export function shortPath(file: string): string {
  const parts = file.split('/').filter(Boolean)
  return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/')
}
