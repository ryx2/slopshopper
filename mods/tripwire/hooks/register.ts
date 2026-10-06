// tripwire: holds destructive commands until you say so.
//
// tool.call (Bash): classifies the command. A rule that can never be undone
//   (writing a block device, mkfs, deleting a protected branch) is refused.
//   Anything else that trips holds the call in $.ui.ask with "Run it" and
//   "Refuse". A hook failure answers with a refusal, never a run.
// tool.call (Write, Edit): holds edits to .env files the same way.
// /tripwire lists this session's decisions.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision } from '../types'

const MAX = 100
const decisions = atom({ plugin: 'tripwire', key: 'decisions' } as const, [])

type Trip = { rule: string; why: string; deny?: true }

export const register: Register = (on, options) => {
  const protectedBranches = String(options.protectedBranches ?? 'main,master')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const askForRm = options.askForRm !== false
  const allowSudo = options.allowSudo === true

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'tripwire', description: 'The destructive commands tripwire held this session, and what you decided' })
    } catch {
      // the name is taken; the guard still runs
    }
    return next(e)
  })

  on('command.run', { command: 'tripwire' }, async $ => {
    const list = await read($, decisions)
    if (list.length === 0) return { text: 'tripwire: nothing tripped this session.' }
    return { text: list.map(d => `${d.outcome.padEnd(7)} ${d.rule.padEnd(14)} ${d.what}  (${d.by})`).join('\n') }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const trip = classify(command, { protectedBranches, askForRm, allowSudo })
    if (trip === null) return next(e)
    const what = command.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (trip.deny) {
      await record($, { what, rule: trip.rule, outcome: 'denied', by: 'rule', at: await $.clock.now() })
      $.ui.toast(`tripwire refused: ${trip.rule}`)
      return { deny: `tripwire refused this command (${trip.rule}): ${trip.why}. It cannot be undone, so tripwire never asks. Do not retry it or look for another way to do the same thing; tell the user what you wanted to do.` }
    }
    const answer = await ask($, `tripwire · ${trip.rule}: ${trip.why}\n\n${what}\n\nRun this command?`)
    if (answer === 'Run it') {
      await record($, { what, rule: trip.rule, outcome: 'ran', by: 'person', at: await $.clock.now() })
      return next(e)
    }
    await record($, { what, rule: trip.rule, outcome: 'refused', by: answer === null ? 'no-one-to-ask' : 'person', at: await $.clock.now() })
    return { deny: `tripwire held this command (${trip.rule}) and ${answer === null ? 'nobody was there to approve it' : 'the user refused it'}. Do not retry it or work around it; ask the user before trying anything with the same effect.` }
  }).catch(async ($, e) => ({ deny: `tripwire's guard failed (${$.plugin.name}: ${String(e.command ?? '').slice(0, 60)}), so the command was not run. Ask the user before retrying.` }))

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const file = String(e.file_path ?? '')
    if (!/(^|\/)\.env(\.[\w.-]+)?$/.test(file)) return next(e)
    const what = `${e.tool} ${file}`
    const answer = await ask($, `tripwire · env-file: ${e.tool} to ${file} changes secrets or configuration outside version control.\n\nLet it through?`)
    if (answer === 'Run it') {
      await record($, { what, rule: 'env-file', outcome: 'ran', by: 'person', at: await $.clock.now() })
      return next(e)
    }
    await record($, { what, rule: 'env-file', outcome: 'refused', by: answer === null ? 'no-one-to-ask' : 'person', at: await $.clock.now() })
    return { deny: `tripwire held this ${e.tool} to ${file} and ${answer === null ? 'nobody was there to approve it' : 'the user refused it'}. Tell the user what you wanted to change there instead.` }
  }).catch(async ($, e) => ({ deny: `tripwire's guard failed on ${e.tool} ${String(e.file_path ?? '')}, so the edit was not made. Ask the user before retrying.` }))
}

/** Puts the question to the person; null when nobody can answer. */
async function ask($: EngineInterface, question: string): Promise<string | null> {
  try {
    return await $.ui.ask(question, ['Run it', 'Refuse'])
  } catch {
    return null
  }
}

async function record($: EngineInterface, d: Decision): Promise<void> {
  await update($, decisions, list => [...list, d].slice(-MAX))
}

const SHELL_SPLIT = /\s*(?:&&|\|\||;|\|(?!\|)|\n)\s*/

/** The first rule a command trips, or null. */
export function classify(command: string, o: { protectedBranches: string[]; askForRm: boolean; allowSudo: boolean }): Trip | null {
  const segments = command.split(SHELL_SPLIT).map(s => s.trim()).filter(Boolean)
  // pipe to shell is about the whole line
  if (/\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(command)) return { rule: 'pipe-to-shell', why: 'runs whatever a download contains' }
  for (const raw of segments) {
    const seg = raw.replace(/^(?:env\s+)?(?:[A-Z_][A-Z0-9_]*=\S+\s+)*/, '')
    const words = seg.split(/\s+/)
    const first = words[0] ?? ''
    if (/^(mkfs(\.\w+)?|fdisk|parted|wipefs)$/.test(first) || /\bdd\s+.*\bof=\/dev\//.test(seg) || />\s*\/dev\/(sd|nvme|disk|hd|mmcblk)/.test(seg)) return { rule: 'disk', why: 'writes a block device or a filesystem', deny: true }
    if (first === 'sudo' && !o.allowSudo) return { rule: 'sudo', why: 'runs with root privileges' }
    if (/^(rm|trash)$/.test(first) || /^sudo$/.test(first)) {
      const body = first === 'sudo' ? seg.replace(/^sudo\s+/, '') : seg
      if (/^rm\b/.test(body)) {
        const r = rmTrip(body, o.askForRm)
        if (r) return r
      }
    }
    if (first === 'git') {
      const g = gitTrip(words.slice(1), o.protectedBranches)
      if (g) return g
    }
    if (/^(chmod|chown|chgrp)$/.test(first) && /\s-[a-zA-Z]*R/.test(seg) && /\s(\/|~|\$HOME|777)\b/.test(seg)) return { rule: 'permissions', why: 'changes permissions or ownership recursively on a broad path' }
    if (/\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*;?\s*$)/i.test(seg)) return { rule: 'sql', why: 'destroys data in a database' }
    if (/^(kill|pkill|killall)$/.test(first) && (/\s-9\s+-1\b/.test(seg) || /^killall\s+-?\w*$/.test(seg) || /pkill\s+-f\s+\S+/.test(seg))) return { rule: 'kill', why: 'kills processes broadly' }
    if (/^(docker|podman)$/.test(first) && /\b(system prune|volume (rm|prune)|rm\s+-f|rmi\s+-f)\b/.test(seg)) return { rule: 'containers', why: 'removes containers, images or volumes' }
    if (/^(terraform|pulumi|cdk)$/.test(first) && /\b(destroy)\b/.test(seg)) return { rule: 'infra', why: 'destroys infrastructure' }
    if (/^(npm|pnpm|yarn|bun)$/.test(first) && /\bpublish\b/.test(seg)) return { rule: 'publish', why: 'publishes a package' }
    if (/^(gh)$/.test(first) && /\b(repo delete|release delete|secret delete)\b/.test(seg)) return { rule: 'github', why: 'deletes something on GitHub' }
    if (/^(rsync)$/.test(first) && /\s--delete\b/.test(seg)) return { rule: 'rsync-delete', why: 'deletes files at the destination' }
    if (/^(find)$/.test(first) && /\s-(delete|exec\s+rm)\b/.test(seg)) return { rule: 'find-delete', why: 'deletes every file it matches' }
    if (/^(crontab)$/.test(first) && /\s-r\b/.test(seg)) return { rule: 'crontab', why: 'removes every cron job' }
    if (/^(history)$/.test(first) && /\s-c\b/.test(seg)) return { rule: 'history', why: 'clears the shell history' }
  }
  return null
}

function rmTrip(seg: string, askInside: boolean): Trip | null {
  const words = seg.split(/\s+/).slice(1)
  const flags = words.filter(w => w.startsWith('-')).join(' ')
  const recursive = /r|R|-recursive/.test(flags)
  const targets = words.filter(w => !w.startsWith('-'))
  if (targets.length === 0) return null
  for (const t of targets) {
    const bare = t.replace(/['"]/g, '')
    if (/^(\/|~|\$HOME|\*|\.|\.\.|\/\*|~\/\*|\$HOME\/\*|\.\/\*)$/.test(bare) || /^\/(usr|etc|var|bin|lib|opt|home|Users|System|Library)(\/|$)/.test(bare)) return { rule: 'rm', why: `removes ${bare}, which reaches far outside this project` }
    if (bare.includes('*') && recursive) return { rule: 'rm', why: `removes everything matching ${bare}` }
    if (bare.startsWith('/') || bare.startsWith('~') || bare.startsWith('$HOME') || bare.startsWith('..')) return { rule: 'rm', why: `removes ${bare}, outside the working directory` }
  }
  if (recursive && askInside) return { rule: 'rm', why: `removes ${targets.join(', ')} recursively` }
  return null
}

function gitTrip(args: string[], protectedBranches: string[]): Trip | null {
  const sub = args.find(a => !a.startsWith('-')) ?? ''
  const line = args.join(' ')
  const protectedRe = new RegExp(`(^|[\\s:/])(${protectedBranches.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(\\s|$)`)
  if (sub === 'push') {
    const forced = /(^|\s)(--force|-f)(\s|$)/.test(line) && !/--force-with-lease/.test(line)
    const deletes = /(^|\s)(--delete|-d)(\s|$)/.test(line) || /\s:\S+/.test(line)
    if (deletes && protectedRe.test(line)) return { rule: 'branch-delete', why: 'deletes a protected branch on the remote', deny: true }
    if (forced && protectedRe.test(line)) return { rule: 'force-push', why: 'rewrites a protected branch for everyone' }
    if (forced) return { rule: 'force-push', why: 'rewrites history on the remote' }
    if (deletes) return { rule: 'branch-delete', why: 'deletes a branch on the remote' }
    return null
  }
  if (sub === 'reset' && /(^|\s)--hard(\s|$)/.test(line)) return { rule: 'reset-hard', why: 'throws away uncommitted work' }
  if ((sub === 'checkout' || sub === 'restore') && /(\s--\s+\.|\s\.$|\s--\s*\*|\s\*$)/.test(line) && !/(^|\s)-b(\s|$)/.test(line)) return { rule: 'discard', why: 'discards every uncommitted change' }
  if (sub === 'clean' && /(^|\s)-[a-zA-Z]*f/.test(line)) return { rule: 'clean', why: 'deletes untracked files' }
  if (sub === 'branch' && /(^|\s)-D(\s|$)/.test(line)) {
    if (protectedRe.test(line)) return { rule: 'branch-delete', why: 'deletes a protected branch', deny: true }
    return { rule: 'branch-delete', why: 'deletes a branch and its unmerged commits' }
  }
  if (sub === 'stash' && /\b(drop|clear)\b/.test(line)) return { rule: 'stash', why: 'drops stashed work' }
  if (sub === 'rebase' && !/(--abort|--continue|--skip|--quit)/.test(line) && protectedRe.test(line) && /\s-i\b|--interactive/.test(line)) return { rule: 'rebase', why: 'rewrites a protected branch' }
  if (sub === 'filter-branch' || sub === 'filter-repo') return { rule: 'rewrite', why: 'rewrites the whole history' }
  if (sub === 'reflog' && /\bexpire\b/.test(line)) return { rule: 'reflog', why: 'drops the safety net for recovering commits' }
  if (sub === 'gc' && /--prune=now/.test(line)) return { rule: 'gc', why: 'drops unreachable commits now' }
  return null
}
