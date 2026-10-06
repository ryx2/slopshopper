// receipts: a ledger of what Claude touched this session.
//
// tool.call (Write, Edit): records the file; (Bash): records the command and
//   whether it failed.
// turn.complete: reads `git diff --shortstat` so the ledger has line counts.
// ui.render (Spinner): adds "· 2 files · 3 cmds" after the spinner's word.
// /receipts prints the ledger as Markdown and opens a pane with Copy, Clear
//   and Close.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CommandReceipt, FileReceipt } from '../types'

const PANE = 'receipts'
const MAX_COMMANDS = 150

const files = atom({ plugin: 'receipts', key: 'files' } as const, [])
const commands = atom({ plugin: 'receipts', key: 'commands' } as const, [])
const turnCount = atom({ plugin: 'receipts', key: 'turnCount' } as const, 0)
const diffstat = atom({ plugin: 'receipts', key: 'diffstat' } as const, '')
const turnFiles = atom({ plugin: 'receipts', key: 'turnFiles' } as const, 0)
const turnCommands = atom({ plugin: 'receipts', key: 'turnCommands' } as const, 0)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'receipts', description: 'Everything Claude touched this session, as Markdown', argumentHint: '[copy]' })
    } catch {
      // the name is taken; the pane can still be opened by other means
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, turnCount, n => n + 1)
    await update($, turnFiles, () => 0)
    await update($, turnCommands, () => 0)
    return next(e)
  })

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const path = String(e.file_path ?? '')
    const turn = await read($, turnCount)
    const isWrite = e.tool === 'Write'
    await update($, files, list => {
      const i = list.findIndex(f => f.path === path)
      if (i < 0) return [...list, { path, writes: isWrite ? 1 : 0, edits: isWrite ? 0 : 1, turn }]
      const cur = list[i]!
      const nextEntry: FileReceipt = { ...cur, writes: cur.writes + (isWrite ? 1 : 0), edits: cur.edits + (isWrite ? 0 : 1) }
      return [...list.slice(0, i), nextEntry, ...list.slice(i + 1)]
    })
    await update($, turnFiles, n => n + 1)
    $.ui.invalidate('ui.render')
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const turn = await read($, turnCount)
    const receipt: CommandReceipt = { command: String(e.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 160), isError: ran.isError === true, turn }
    await update($, commands, list => [...list, receipt].slice(-MAX_COMMANDS))
    await update($, turnCommands, n => n + 1)
    $.ui.invalidate('ui.render')
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await refreshDiffstat($)
    return result
  })

  on('command.run', { command: 'receipts' }, async ($, e) => {
    const text = await ledger($)
    if (/\bcopy\b/i.test(e.args)) {
      const copied = await $.ui.copy({ text })
      return { text: copied.isCopied ? 'receipts: copied the ledger to the clipboard.' : `receipts: could not copy (${copied.reason}); here it is instead.\n\n${text}` }
    }
    await $.ui.open({ id: PANE, title: 'Receipts', focus: true, closeOnEscape: true })
    return { text }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const f = await read($, turnFiles)
    const c = await read($, turnCommands)
    if (f === 0 && c === 0) return next(e)
    const parts = [f > 0 ? `${f} file${f === 1 ? '' : 's'}` : '', c > 0 ? `${c} cmd${c === 1 ? '' : 's'}` : ''].filter(Boolean)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix ?? ''} · ${parts.join(' · ')}` } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const fl = await read($, files)
    const cl = await read($, commands)
    const stat = await read($, diffstat)
    const width = e.props.bodyColumns
    const failed = cl.filter(c => c.isError).length
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold>▤ receipts</Text>
          <Text dimColor>
            {fl.length} file{fl.length === 1 ? '' : 's'} · {cl.length} command{cl.length === 1 ? '' : 's'}
            {failed > 0 ? ` · ${failed} failed` : ''}
          </Text>
        </Box>
        {stat !== '' && <Text color="cyan">{stat}</Text>}
        {fl.length === 0 && cl.length === 0 && <Text dimColor>Nothing yet. Files and commands appear as Claude works.</Text>}
        {fl.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Files</Text>
            {fl.slice(-14).map(f => (
              <Box flexDirection="row" columnGap={1}>
                <Text color={f.writes > 0 && f.edits === 0 ? 'green' : 'yellow'}>{f.writes > 0 && f.edits === 0 ? 'new' : 'mod'}</Text>
                <Text wrap="truncate-start">{shortPath(f.path, width - 12)}</Text>
                <Text dimColor>{f.edits > 1 ? `×${f.edits}` : ''}</Text>
              </Box>
            ))}
          </Box>
        )}
        {cl.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Commands</Text>
            {cl.slice(-8).map(c => (
              <Box flexDirection="row" columnGap={1}>
                <Text color={c.isError ? 'red' : 'green'}>{c.isError ? '✗' : '✓'}</Text>
                <Text dimColor={c.isError ? undefined : true} wrap="truncate-end">
                  {c.command.slice(0, Math.max(10, width - 4))}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          <Button key="copy" label="Copy as Markdown" hotkey="c" variant="primary" onPress={async () => void (await $.ui.copy({ text: await ledger($) }))} />
          <Button key="clear" label="Clear" hotkey="x" onPress={async () => clear($)} />
          <Button key="close" label="Close" hotkey="q" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

async function refreshDiffstat($: EngineInterface): Promise<void> {
  try {
    const out = await $.process.run(['git', 'diff', '--shortstat'], { timeoutMs: 5000 })
    if (out.exitCode === 0) await update($, diffstat, () => out.stdout.trim())
  } catch {
    // not a git repository, or git is slow; the ledger just has no diffstat
  }
}

async function clear($: EngineInterface): Promise<void> {
  await update($, files, () => [])
  await update($, commands, () => [])
  await update($, diffstat, () => '')
}

/** The ledger as Markdown. */
async function ledger($: EngineInterface): Promise<string> {
  const fl = await read($, files)
  const cl = await read($, commands)
  const stat = await read($, diffstat)
  const turns = await read($, turnCount)
  if (fl.length === 0 && cl.length === 0) return 'receipts: nothing touched yet this session.'
  const lines: string[] = [`## Session receipts`, '', `${turns} turn${turns === 1 ? '' : 's'} · ${fl.length} file${fl.length === 1 ? '' : 's'} · ${cl.length} command${cl.length === 1 ? '' : 's'}${stat ? ` · ${stat}` : ''}`]
  if (fl.length) {
    lines.push('', '### Files')
    for (const f of fl) lines.push(`- ${f.writes > 0 && f.edits === 0 ? 'new' : 'modified'} \`${f.path}\`${f.edits > 1 ? ` (${f.edits} edits)` : ''}`)
  }
  if (cl.length) {
    lines.push('', '### Commands')
    for (const c of cl.slice(-40)) lines.push(`- ${c.isError ? '✗' : '✓'} \`${c.command}\``)
  }
  return lines.join('\n')
}

export function shortPath(path: string, room: number): string {
  if (path.length <= room) return path
  const parts = path.split('/')
  let out = parts[parts.length - 1] ?? path
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + '/' + out
    if (next.length + 1 > room) return '…/' + out
    out = next
  }
  return out
}
