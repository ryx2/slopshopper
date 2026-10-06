import { describe, expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'receipts',
  component: 'Pane',
  requestId: 'receipts',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Receipts', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const SPINNER = {
  plugin: 'receipts',
  component: 'Spinner',
  requestId: 'main',
  viewport: { columns: 120, rows: 40 },
  props: { word: 'Thinking', message: null, suffix: '', mode: 'thinking' },
} as const

describe('register', () => {
  test('records files and commands and prints them as Markdown', async ($, on) => {
    on('tool.call', ($, e) => (e.tool === 'Bash' && String(e.command).includes('test') ? { result: 'fail', isError: true } : { result: 'ok' }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: ' 2 files changed, 14 insertions(+), 3 deletions(-)\n', stderr: '' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))

    await $.turn.start({ turnId: 't1' })
    await $.tool.call({ tool: 'Write', file_path: '/work/app/src/audit.ts', content: 'export {}' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/auth.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/auth.ts', old_string: 'b', new_string: 'c' })
    await $.tool.call({ tool: 'Bash', command: 'bun test' })
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, usage: null })

    const out = await $.command.run({ command: 'receipts', args: '' })
    expect(out.text).toContain('1 turn · 2 files · 2 commands · 2 files changed')
    expect(out.text).toContain('- new `/work/app/src/audit.ts`')
    expect(out.text).toContain('- modified `/work/app/src/auth.ts` (2 edits)')
    expect(out.text).toContain('- ✗ `bun test`')
    expect(out.text).toContain('- ✓ `git status`')
  })

  test('the spinner counts the turn, and the pane lists and clears', async ($, on) => {
    on('tool.call', () => ({ result: 'ok' }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: [`${e.props.word}${e.props.suffix}`] }))

    await $.turn.start({ turnId: 't1' })
    await $.tool.call({ tool: 'Write', file_path: '/work/app/a.ts', content: '' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const spinner = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
    expect(await spinner.find({ type: 'Text', text: /1 file · 1 cmd/ })).toBeDefined()
    await spinner.unmount()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /1 file · 1 command/ })).toBeDefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'clear' })
    expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
    await ui.unmount()
  })

  test('/receipts copy puts the ledger on the clipboard', async ($, on) => {
    on('tool.call', () => ({ result: 'ok' }))
    let copied = ''
    on('ui.copy', ($, e) => {
      copied = e.text
      return { value: { isCopied: true } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/work/app/b.ts', content: '' })
    const out = await $.command.run({ command: 'receipts', args: 'copy' })
    expect(out.text).toContain('copied')
    expect(copied).toContain('## Session receipts')
  })
})
