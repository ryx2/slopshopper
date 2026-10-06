import { describe, expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'slop-detector',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const PANE = {
  plugin: 'slop-detector',
  component: 'Pane',
  requestId: 'slop-detector',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Slop', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

describe('register', () => {
  test('refuses a Write that stands in for code with a truncation comment', async ($, on) => {
    on('tool.call', () => ({ result: 'ok' }))
    const out = await $.tool.call({ tool: 'Write', file_path: '/work/app/src/a.ts', content: 'export const a = 1\n// ... rest of the code unchanged\n' })
    expect(out.deny).toContain('truncation')
    expect(out.deny).toContain('src/a.ts')
  })

  test('refuses an Edit whose new text is "... existing code ..."', async ($, on) => {
    on('tool.call', () => ({ result: 'ok' }))
    const out = await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/b.py', old_string: 'x = 1', new_string: '# ... existing code ...\nx = 2' })
    expect(out.deny).toBeDefined()
  })

  test('lets clean code through and ignores test files', async ($, on) => {
    on('tool.call', () => ({ result: 'ok' }))
    const clean = await $.tool.call({ tool: 'Write', file_path: '/work/app/src/c.ts', content: 'export const c = () => 3\n' })
    expect(clean.deny).toBeUndefined()
    const test = await $.tool.call({ tool: 'Write', file_path: '/work/app/src/c.test.ts', content: '// TODO: implement\n// ... rest of the code\n' })
    expect(test.deny).toBeUndefined()
  })

  test('records a TODO stub, toasts, draws the band, and counts it under the answer', async ($, on) => {
    on('tool.call', () => ({ result: 'ok' }))
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))

    await $.turn.start({ turnId: 't1' })
    await $.tool.call({ tool: 'Write', file_path: '/work/app/src/audit.ts', content: "// TODO: implement persistence later\nexport const audit = () => {}\nconsole.log('here')\n" })
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('src/audit.ts')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /2 findings/ })).toBeDefined()
      await ui.unmount()
    }

    const done = await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1000, isAborted: false, usage: null })
    expect(done.text).toContain('2 findings this turn')
  })

  test('/slop opens the pane and the pane lists findings with a Clear button', async ($, on) => {
    on('tool.call', () => ({ result: 'ok' }))
    on('ui.toast', () => ({ value: undefined }))
    const opened: string[] = []
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/work/app/src/d.ts', content: 'throw new Error("not implemented")\n' })
    const answer = await $.command.run({ command: 'slop', args: '' })
    expect(answer.text).toContain('1 finding')
    expect(opened).toEqual(['slop-detector'])

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'not-implemented' })).toBeDefined()
    await ui.press({ key: 'clear' })
    expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
    await ui.unmount()
  })
})
