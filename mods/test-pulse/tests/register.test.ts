import { describe, expect, mock, test } from 'claude-code/testing'
import { parse } from '../hooks/register'

const BAND = {
  plugin: 'test-pulse',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 140, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const BUN_FAIL = 'src/auth.test.ts:\n✓ refreshes expired token\n✗ revokes on logout\n  error: expected 401, got 200\n\n 3 pass\n 1 fail\n'
const BUN_PASS = 'src/auth.test.ts:\n✓ refreshes expired token\n\n 4 pass\n 0 fail\n'

function project(on: Parameters<Parameters<typeof test>[1]>[1], output: { exitCode: number; stdout: string }) {
  on('fs.exists', ($, e) => ({ value: /package\.json$|bun\.lock$/.test(e.path) }))
  on('fs.read', () => ({ value: JSON.stringify({ scripts: { test: 'bun test' } }) }))
  on('process.run', ($, e) => (e.argv.join(' ') === 'bun run test' ? { value: { ...output, stderr: '' } } : { deny: `unexpected ${e.argv.join(' ')}` }))
}

describe('register', () => {
  test('runs the suite after a turn that changed source, and reports under the answer', async ($, on) => {
    mock.clock(on)
    on('tool.call', () => ({ result: 'ok' }))
    on('turn.complete', () => ({ text: '' }))
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
    project(on, { exitCode: 1, stdout: BUN_FAIL })

    await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/auth.ts', old_string: 'a', new_string: 'b' })
    const done = await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, usage: null })
    expect(done.text).toContain('✗ 3 pass, 1 fail')
    expect(done.text).toContain('revokes on logout')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /✗ tests 3 pass, 1 fail/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a turn that changed no source runs nothing', async ($, on) => {
    mock.clock(on)
    let runs = 0
    on('tool.call', () => ({ result: 'ok' }))
    on('turn.complete', () => ({ text: '' }))
    on('process.run', () => {
      runs++
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    })
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => ({ value: '{}' }))
    await $.tool.call({ tool: 'Write', file_path: '/work/app/README.md', content: '# hi' })
    const done = await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, usage: null })
    expect(done.text).toBe('')
    expect(runs).toBe(0)
  })

  test('toasts when the suite goes red and when it recovers', async ($, on) => {
    mock.clock(on)
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    let output = { exitCode: 0, stdout: BUN_PASS }
    on('fs.exists', ($, e) => ({ value: /package\.json$|bun\.lock$/.test(e.path) }))
    on('fs.read', () => ({ value: JSON.stringify({ scripts: { test: 'bun test' } }) }))
    on('process.run', () => ({ value: { ...output, stderr: '' } }))

    await $.command.run({ command: 'tests', args: '' })
    expect(toasts).toEqual([])
    output = { exitCode: 1, stdout: BUN_FAIL }
    await $.command.run({ command: 'tests', args: '' })
    expect(toasts[0]).toContain('went red')
    output = { exitCode: 0, stdout: BUN_PASS }
    await $.command.run({ command: 'tests', args: '' })
    expect(toasts[1]).toContain('green again')
  })

  test('parses the common runners', () => {
    expect(parse(BUN_FAIL)).toEqual({ passed: 3, failed: 1, firstFailure: 'revokes on logout' })
    expect(parse('Tests:       1 failed, 11 passed, 12 total\n● auth › revokes on logout\n')).toMatchObject({ passed: 11, failed: 1 })
    expect(parse('FAILED tests/test_auth.py::test_logout - assert 200 == 401\n==== 1 failed, 7 passed in 0.42s ====')).toEqual({ passed: 7, failed: 1, firstFailure: 'tests/test_auth.py::test_logout' })
    expect(parse('test result: ok. 12 passed; 0 failed; 0 ignored')).toMatchObject({ passed: 12, failed: 0 })
    expect(parse('ok  \tapp/auth\t0.1s\nFAIL\tapp/session\t0.2s\n')).toMatchObject({ passed: 1, failed: 1 })
  })
})
