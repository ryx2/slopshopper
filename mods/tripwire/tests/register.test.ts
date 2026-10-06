import { describe, expect, mock, test } from 'claude-code/testing'

const answering = (label: string) => ($: unknown, e: { tool: string; questions?: { question: string }[] }) =>
  e.tool === 'AskUserQuestion' ? { result: { answers: { [e.questions![0]!.question]: label } } } : { result: 'ok' }

describe('register', () => {
  test('a force push is held, and a refusal denies the command', async ($, on) => {
    mock.clock(on)
    on('tool.call', answering('Refuse'))
    on('ui.toast', () => ({ value: undefined }))
    const out = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
    expect(out.deny).toContain('force-push')
    expect(out.deny).toContain('refused')
    const log = await $.command.run({ command: 'tripwire', args: '' })
    expect(log.text).toContain('refused')
    expect(log.text).toContain('force-push')
  })

  test('"Run it" lets the command through', async ($, on) => {
    mock.clock(on)
    on('tool.call', answering('Run it'))
    const out = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    expect(out.deny).toBeUndefined()
    expect(out.result).toBe('ok')
  })

  test('ordinary commands never ask', async ($, on) => {
    let asked = 0
    on('tool.call', ($, e) => {
      if (e.tool === 'AskUserQuestion') asked++
      return { result: 'ok' }
    })
    for (const command of ['git status', 'git push origin feat/x', 'git push --force-with-lease origin feat/x', 'rm build/out.js', 'ls -la', 'bun test', 'rm -f /tmp/x.lock', 'cat .env'])
      expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
    expect(asked).toBe(0)
  })

  test('deleting a protected branch is refused without asking, and so is writing a disk', async ($, on) => {
    mock.clock(on)
    let asked = 0
    on('tool.call', ($, e) => {
      if (e.tool === 'AskUserQuestion') asked++
      return { result: 'ok' }
    })
    on('ui.toast', () => ({ value: undefined }))
    const branch = await $.tool.call({ tool: 'Bash', command: 'git push origin --delete main' })
    expect(branch.deny).toContain('branch-delete')
    const disk = await $.tool.call({ tool: 'Bash', command: 'dd if=/dev/zero of=/dev/sda bs=1M' })
    expect(disk.deny).toContain('disk')
    expect(asked).toBe(0)
  })

  test('with nobody to ask, a held command is refused', async ($, on) => {
    mock.clock(on)
    on('tool.call', ($, e) => {
      if (e.tool === 'AskUserQuestion') throw new Error('no one to ask')
      return { result: 'ok' }
    })
    const out = await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~3' })
    expect(out.deny).toContain('nobody was there')
  })

  test('an edit to .env is held too', async ($, on) => {
    mock.clock(on)
    on('tool.call', answering('Refuse'))
    const out = await $.tool.call({ tool: 'Edit', file_path: '/work/app/.env', old_string: 'A=1', new_string: 'A=2' })
    expect(out.deny).toContain('.env')
    const ok = await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/env.ts', old_string: 'A=1', new_string: 'A=2' })
    expect(ok.deny).toBeUndefined()
  })
})
