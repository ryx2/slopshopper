import { describe, expect, test } from 'claude-code/testing'
import { firstSecret, redact } from '../hooks/register'

// `claude plugin test` has nothing beneath the mods to store a session row, so
// the session.append hook is covered through the pure functions it calls;
// the hook itself is three lines of mapping over the row's blocks.

const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'

const BAND = {
  plugin: 'secret-shield',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

describe('register', () => {
  test('refuses a Write that contains an API key, and counts it in the band', async ($, on) => {
    on('tool.call', () => ({ result: 'ok' }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
    const out = await $.tool.call({ tool: 'Write', file_path: '/work/app/config.ts', content: `export const key = "${KEY}"\n` })
    expect(out.deny).toContain('anthropic-key')
    const clean = await $.tool.call({ tool: 'Write', file_path: '/work/app/config.ts', content: 'export const key = process.env.ANTHROPIC_API_KEY\n' })
    expect(clean.deny).toBeUndefined()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /1 refused/ })).toBeDefined()
      await ui.unmount()
    }
    const answer = await $.command.run({ command: 'secrets', args: '' })
    expect(answer.text).toContain('1× refused anthropic-key')
  })

  test('refuses a Bash command that embeds a token', async ($, on) => {
    on('tool.call', () => ({ result: 'ok' }))
    on('ui.toast', () => ({ value: undefined }))
    const out = await $.tool.call({ tool: 'Bash', command: `curl -H "Authorization: Bearer ghp_${'x'.repeat(36)}" https://api.github.com/user` })
    expect(out.deny).toContain('github-token')
    const ok = await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user' })
    expect(ok.deny).toBeUndefined()
  })

  test('redact() replaces secrets in a tool result and keeps the rest', () => {
    // assembled at run time so no secret-shaped literal sits in the repository
    const stripe = ['sk', 'live', '51H' + 'x'.repeat(24)].join('_')
    const env = `DATABASE_URL=postgres://app:hunter2secret@db.internal:5432/app\nSTRIPE_SECRET_KEY=${stripe}\nPORT=3000\n`
    const r = redact(env)
    expect(r.kind).toBe('stripe-key')
    expect(r.text).not.toContain('hunter2secret')
    expect(r.text).not.toContain('sk_live_')
    expect(r.text).toContain('PORT=3000')
    expect(r.text).toContain('DATABASE_URL=postgres://app:[redacted-password]@db.internal:5432/app')
    expect(r.text).toContain('[redacted stripe-key by secret-shield]')
  })

  test('redact() leaves ordinary output alone', () => {
    const r = redact('src/auth.ts\nsrc/api.ts\nconst token = await issue(claims.sub)\n')
    expect(r.kind).toBeNull()
    expect(r.text).toBe('src/auth.ts\nsrc/api.ts\nconst token = await issue(claims.sub)\n')
  })

  test('firstSecret() reports the kind and line, and honors highOnly', () => {
    expect(firstSecret(`a\nb\n${KEY}\n`, true)).toEqual({ kind: 'anthropic-key', line: 3 })
    expect(firstSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----', true)?.kind).toBe('private-key')
    expect(firstSecret('API_TOKEN=abcdefghijklmnop', true)).toBeNull()
    expect(firstSecret('API_TOKEN=abcdefghijklmnop', false)?.kind).toBe('env-secret')
    expect(firstSecret('nothing to see', false)).toBeNull()
  })
})
