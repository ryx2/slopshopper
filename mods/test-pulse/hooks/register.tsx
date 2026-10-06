// test-pulse: runs the tests after a turn that changed source, and keeps the
// result above the prompt.
//
// tool.call (Write, Edit): marks the session dirty when a source file changes.
// turn.complete: if dirty, runs the test command (detected, or configured),
//   parses the counts, stores the run, toasts a regression or a recovery, and
//   adds a line under the answer.
// ui.render (AbovePrompt): the last result; Details opens the pane.
// ui.render (Pane): the output tail, with Re-run.
// /tests runs the suite now.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TestRun } from '../types'

const PANE = 'test-pulse'
const TAIL = 30

const last = atom({ plugin: 'test-pulse', key: 'last' } as const, null)
const isRunning = atom({ plugin: 'test-pulse', key: 'isRunning' } as const, false)
const isHidden = atom({ plugin: 'test-pulse', key: 'isHidden' } as const, false)
const dirty = atom({ plugin: 'test-pulse', key: 'dirty' } as const, false)

export const register: Register = (on, options) => {
  const configured = String(options.command ?? '').trim()
  const timeoutMs = Math.min(600_000, Math.max(5_000, (typeof options.timeoutSeconds === 'number' ? options.timeoutSeconds : 120) * 1000))
  const extensions = new Set(
    String(options.extensions ?? 'ts,tsx,js,jsx,mjs,py,rs,go')
      .split(',')
      .map(s => s.trim().replace(/^\./, ''))
      .filter(Boolean),
  )

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'tests', description: 'Run the test suite now and show the result above the prompt', immediate: true })
    } catch {
      // the name is taken; the band still runs after turns
    }
    return next(e)
  })

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const ext = String(e.file_path ?? '').split('.').pop() ?? ''
    if (extensions.has(ext)) await update($, dirty, () => true)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted || !(await read($, dirty))) return result
    const run = await runTests($, configured, timeoutMs)
    if (run === null) return result
    return { ...result, text: lineFor(run) }
  })

  on('command.run', { command: 'tests' }, async $ => {
    const run = await runTests($, configured, timeoutMs)
    if (run === null) return { text: 'test-pulse: no test command found. Set one in /config under test-pulse.' }
    await $.ui.open({ id: PANE, title: 'Tests', focus: true, closeOnEscape: true })
    return { text: lineFor(run) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const run = await read($, last)
    const running = await read($, isRunning)
    if (e.props.hasSurvey || (await read($, isHidden)) || (run === null && !running)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (running) {
      return (
        <Box flexDirection="row" columnGap={2} paddingX={1}>
          <Text color="yellow">◌ tests running</Text>
          <Text dimColor>{run ? `last: ${run.ok ? 'pass' : 'fail'}` : ''}</Text>
        </Box>
      )
    }
    const r = run!
    const counts = r.passed !== null || r.failed !== null ? `${r.passed ?? 0} pass${r.failed ? `, ${r.failed} fail` : ''}` : r.ok ? 'passed' : 'failed'
    return (
      <Box flexDirection="row" columnGap={2} paddingX={1}>
        <Text color={r.ok ? 'green' : 'red'} bold>
          {r.ok ? '✓' : '✗'} tests {counts}
        </Text>
        {!r.ok && r.firstFailure !== null && (
          <Text color="red" wrap="truncate-end">
            {r.firstFailure.slice(0, Math.max(10, e.props.bodyColumns - 50))}
          </Text>
        )}
        {r.timedOut && <Text color="yellow">timed out</Text>}
        <Text dimColor>
          {r.command} · {(r.durationMs / 1000).toFixed(1)}s
        </Text>
        <Button key="details" label="Details" hotkey="d" plain onPress={() => $.ui.open({ id: PANE, title: 'Tests', focus: true, closeOnEscape: true })} />
        <Button key="rerun" label="Re-run" hotkey="t" plain onPress={() => runTests($, configured, timeoutMs)} />
        <Button key="hide" label="Hide" hotkey="h" plain dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, last)
    const running = await read($, isRunning)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold color={running ? 'yellow' : r === null ? undefined : r.ok ? 'green' : 'red'}>
            {running ? '◌ running' : r === null ? 'no run yet' : r.ok ? '✓ passing' : '✗ failing'}
          </Text>
          {r !== null && (
            <Text dimColor>
              {r.command} · {(r.durationMs / 1000).toFixed(1)}s{r.passed !== null ? ` · ${r.passed} pass` : ''}{r.failed ? ` · ${r.failed} fail` : ''}
            </Text>
          )}
        </Box>
        {r !== null && (
          <Box flexDirection="column" marginTop={1}>
            {r.tail.map(line => (
              <Text color={/fail|error|✗|FAILED|panicked/i.test(line) ? 'red' : /pass|✓|ok\b/i.test(line) ? 'green' : undefined} dimColor={!/fail|error|✗|pass|✓|ok\b/i.test(line)} wrap="truncate-end">
                {line.slice(0, Math.max(10, e.props.bodyColumns - 1))}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          <Button key="rerun" label="Re-run" hotkey="t" variant="primary" onPress={() => runTests($, configured, timeoutMs)} />
          <Button key="close" label="Close" hotkey="q" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

/** Runs the suite once; null when no command applies. */
async function runTests($: EngineInterface, configured: string, timeoutMs: number): Promise<TestRun | null> {
  if (await read($, isRunning)) return read($, last)
  const argv = configured ? configured.split(/\s+/) : await detect($)
  if (argv === null || argv.length === 0) return null
  await update($, isRunning, () => true)
  await update($, dirty, () => false)
  const started = await $.clock.now()
  let run: TestRun
  try {
    const out = await $.process.run(argv, { timeoutMs })
    const text = `${out.stdout}\n${out.stderr}`
    const parsed = parse(text)
    run = { command: argv.join(' '), ok: out.exitCode === 0, passed: parsed.passed, failed: parsed.failed, firstFailure: parsed.firstFailure, durationMs: (await $.clock.now()) - started, tail: tailOf(text), at: started, timedOut: false }
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    run = { command: argv.join(' '), ok: false, passed: null, failed: null, firstFailure: null, durationMs: (await $.clock.now()) - started, tail: [message.slice(0, 200)], at: started, timedOut: /time|kill/i.test(message) }
  }
  const previous = await read($, last)
  await update($, last, () => run)
  await update($, isRunning, () => false)
  if (previous !== null && previous.ok && !run.ok) $.ui.toast(`Tests went red: ${run.firstFailure ?? `${run.failed ?? ''} failing`}`)
  else if (previous !== null && !previous.ok && run.ok) $.ui.toast(`Tests are green again (${run.passed ?? 'all'} pass)`)
  return run
}

/** The project's test command, from what is in the working directory. */
async function detect($: EngineInterface): Promise<string[] | null> {
  try {
    if (await $.fs.exists('package.json')) {
      const pkg = JSON.parse(await $.fs.read('package.json')) as { scripts?: Record<string, string> }
      if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) {
        if (await $.fs.exists('bun.lock')) return ['bun', 'run', 'test']
        if (await $.fs.exists('bun.lockb')) return ['bun', 'run', 'test']
        if (await $.fs.exists('pnpm-lock.yaml')) return ['pnpm', 'test']
        if (await $.fs.exists('yarn.lock')) return ['yarn', 'test']
        return ['npm', 'test', '--silent']
      }
      if (await $.fs.exists('bun.lock')) return ['bun', 'test']
    }
    if ((await $.fs.exists('pytest.ini')) || (await $.fs.exists('conftest.py')) || (await $.fs.exists('pyproject.toml')) || (await $.fs.exists('tests'))) {
      if (await $.fs.exists('uv.lock')) return ['uv', 'run', 'pytest', '-q']
      return ['pytest', '-q']
    }
    if (await $.fs.exists('Cargo.toml')) return ['cargo', 'test', '--quiet']
    if (await $.fs.exists('go.mod')) return ['go', 'test', './...']
    if (await $.fs.exists('mix.exs')) return ['mix', 'test']
    if (await $.fs.exists('Gemfile')) return ['bundle', 'exec', 'rspec']
  } catch {
    // unreadable project files: no command
  }
  return null
}

export function parse(text: string): { passed: number | null; failed: number | null; firstFailure: string | null } {
  const num = (re: RegExp) => {
    const m = re.exec(text)
    return m ? Number(m[1]) : null
  }
  let passed: number | null = null
  let failed: number | null = null
  // bun test
  if (/^\s*\d+ pass\b/m.test(text)) {
    passed = num(/^\s*(\d+) pass\b/m)
    failed = num(/^\s*(\d+) fail\b/m) ?? 0
  } else if (/Tests:\s/.test(text)) {
    // jest / vitest
    passed = num(/Tests:[^\n]*?(\d+) passed/) ?? 0
    failed = num(/Tests:[^\n]*?(\d+) failed/) ?? 0
  } else if (/\d+ passed|\d+ failed/.test(text) && /pytest|passed in|failed in|=+ /.test(text)) {
    passed = num(/(\d+) passed/) ?? 0
    failed = num(/(\d+) failed/) ?? 0
  } else if (/test result:/.test(text)) {
    passed = num(/test result:[^\n]*?(\d+) passed/) ?? 0
    failed = num(/test result:[^\n]*?(\d+) failed/) ?? 0
  } else if (/^(ok|FAIL)\s+\S+/m.test(text)) {
    passed = (text.match(/^ok\s+\S+/gm) ?? []).length
    failed = (text.match(/^FAIL\s+\S+/gm) ?? []).length
  } else if (/\d+ examples?, \d+ failures?/.test(text)) {
    const ex = num(/(\d+) examples?/) ?? 0
    failed = num(/(\d+) failures?/) ?? 0
    passed = ex - failed
  } else if (/\d+ tests?, \d+ failures?/.test(text)) {
    const ex = num(/(\d+) tests?,/) ?? 0
    failed = num(/(\d+) failures?/) ?? 0
    passed = ex - failed
  }
  const firstFailure =
    /^(?:FAILED|ERROR)\s+(\S+)/m.exec(text)?.[1] ??
    /^\s*(?:✗|✕|×|FAIL:?|not ok \d+ -?|---- )\s*(.+?)\s*(?:\[\d+(?:\.\d+)?m?s\])?\s*$/m.exec(text)?.[1]?.replace(/\s+stdout\s*----$/, '') ??
    /^\s*●\s+(.+?)\s*$/m.exec(text)?.[1] ??
    null
  return { passed, failed, firstFailure: firstFailure ? firstFailure.slice(0, 120) : null }
}

function tailOf(text: string): string[] {
  const lines = text.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map(l => l.trimEnd()).filter((l, i, arr) => l !== '' || arr[i - 1] !== '')
  return lines.slice(-TAIL)
}

function lineFor(run: TestRun): string {
  const counts = run.passed !== null || run.failed !== null ? `${run.passed ?? 0} pass${run.failed ? `, ${run.failed} fail` : ''}` : run.ok ? 'passed' : 'failed'
  return `test-pulse: ${run.ok ? '✓' : '✗'} ${counts}${!run.ok && run.firstFailure ? ` · first failure: ${run.firstFailure}` : ''} (${run.command}, ${(run.durationMs / 1000).toFixed(1)}s)${run.ok ? '' : ' · /tests to re-run'}`
}
