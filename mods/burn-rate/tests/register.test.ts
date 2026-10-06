import { describe, expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'burn-rate',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 140, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const usage = (percent: number, usd = 0.42) => ({
  value: {
    startedAt: 0,
    context: { tokens: Math.round((percent / 100) * 200_000), window: 200_000, percent },
    rateLimits: [{ kind: 'five_hour', percentUsed: 31, resetsAt: 10_000_000 }],
    cost: { usd },
  },
})

describe('register', () => {
  test('draws the gauge after a turn and /burn prints the figures', async ($, on) => {
    const clock = mock.clock(on, { now: 1_800_000 })
    on('session.usage', () => usage(49))
    on('turn.complete', () => ({ text: '' }))
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))

    await $.turn.complete({
      turnId: 't1',
      answer: 'done',
      durationMs: 4000,
      isAborted: false,
      usage: { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 4000, model: 'claude-test' },
    })
    void clock

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: '49%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /\$0\.42/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /5h 31%/ })).toBeDefined()
      await ui.unmount()
    }

    const answer = await $.command.run({ command: 'burn', args: '' })
    expect(answer.text).toContain('context 49%')
    expect(answer.text).toContain('cost $0.42')
    expect(answer.text).toContain('1 turn recorded')
  })

  test('warns once when the window passes the threshold', async ($, on) => {
    mock.clock(on, { now: 1_800_000 })
    let percent = 60
    on('session.usage', () => usage(percent))
    on('turn.complete', () => ({ text: '' }))
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const turn = () => $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
    await turn()
    expect(toasts).toEqual([])
    percent = 85
    await turn()
    await turn()
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('85%')
  })

  test('the × button hides the band', async ($, on) => {
    mock.clock(on, { now: 1_800_000 })
    on('session.usage', () => usage(20))
    on('turn.complete', () => ({ text: '' }))
    on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
    await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '20%' })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ type: 'Text', text: '20%' })).toBeUndefined()
    await ui.unmount()
  })
})
