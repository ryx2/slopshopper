// The preview harness that runs INSIDE the vm context. Everything here lives
// in the sandbox realm: it builds a fake mods API (`$`), a fake `claude-code`
// module, loads the mod's bundled hooks module, replays a scripted session,
// then asks every render site to draw. The host gets one JSON string back.
//
// Nothing from the host realm is ever handed to the mod: the host only passes
// strings in and reads a string out.

type AnyFn = (...args: any[]) => any
type Hook = { event: string; matcher?: Record<string, unknown>; hook: AnyFn; catcher?: AnyFn }

declare const globalThis: any

const BASE_NOW = 1_760_000_000_000

const result = {
  ok: true as boolean,
  error: undefined as string | undefined,
  hooks: [] as { event: string; matcher?: Record<string, unknown> }[],
  commands: [] as { name: string; description: string; argumentHint?: string; immediate?: boolean; output?: string }[],
  tools: [] as { name: string; description: string }[],
  panes: [] as { id: string; title?: string }[],
  toasts: [] as string[],
  status: undefined as string | undefined,
  logs: [] as string[],
  denies: [] as { tool: string; reason: string }[],
  rewrites: [] as { event: string; summary: string }[],
  apiCalls: {} as Record<string, number>,
  timers: [] as { kind: 'every' | 'after'; ms: number }[],
  sites: {} as Record<string, unknown>,
  script: [] as string[],
  console: [] as string[],
}

const count = (name: string) => {
  result.apiCalls[name] = (result.apiCalls[name] ?? 0) + 1
}
const note = (s: string) => {
  if (result.script.length < 400) result.script.push(s)
}
const short = (v: unknown, n = 160) => {
  let s: string
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    s = String(v)
  }
  s = s ?? String(v)
  return s.length > n ? s.slice(0, n) + '…' : s
}

// ---- tiny web-API shims (inner realm, pure JS) ---------------------------

class AbortSignalShim {
  aborted = false
  reason: unknown = undefined
  private listeners: AnyFn[] = []
  addEventListener(_t: string, fn: AnyFn) {
    this.listeners.push(fn)
  }
  removeEventListener(_t: string, fn: AnyFn) {
    this.listeners = this.listeners.filter(f => f !== fn)
  }
  throwIfAborted() {
    if (this.aborted) throw this.reason
  }
  _abort(reason: unknown) {
    if (this.aborted) return
    this.aborted = true
    this.reason = reason
    for (const l of this.listeners) {
      try {
        l({ type: 'abort' })
      } catch {}
    }
  }
}
class AbortControllerShim {
  signal = new AbortSignalShim()
  abort(reason?: unknown) {
    this.signal._abort(reason ?? new Error('aborted'))
  }
}
globalThis.AbortController = AbortControllerShim
globalThis.AbortSignal = AbortSignalShim
globalThis.structuredClone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
globalThis.queueMicrotask = (fn: AnyFn) => {
  Promise.resolve().then(fn)
}
globalThis.TextEncoder = class {
  encode(s = '') {
    const bytes: number[] = []
    for (const ch of unescape(encodeURIComponent(s))) bytes.push(ch.charCodeAt(0))
    return Uint8Array.from(bytes)
  }
}
globalThis.TextDecoder = class {
  decode(b?: ArrayBufferView | ArrayBuffer) {
    if (!b) return ''
    const u8 = b instanceof Uint8Array ? b : new Uint8Array(b instanceof ArrayBuffer ? b : (b as ArrayBufferView).buffer)
    let s = ''
    for (const x of u8) s += String.fromCharCode(x)
    try {
      return decodeURIComponent(escape(s))
    } catch {
      return s
    }
  }
}
globalThis.btoa = (s: string) => Uint8Array.from([...s].map(c => c.charCodeAt(0) & 255)).toBase64()
globalThis.atob = (s: string) => {
  const u8 = (Uint8Array as any).fromBase64(s) as Uint8Array
  let out = ''
  for (const x of u8) out += String.fromCharCode(x)
  return out
}
globalThis.setTimeout = (fn: AnyFn, ms = 0) => {
  // the real mod environment has no timer globals; a mod that uses one is told so
  note(`setTimeout(${ms}) called (not available to mods; ran at once)`)
  Promise.resolve().then(() => fn())
  return 0
}
globalThis.clearTimeout = () => {}
globalThis.setInterval = () => {
  note('setInterval called (not available to mods; ignored)')
  return 0
}
globalThis.clearInterval = () => {}
globalThis.console = {
  log: (...a: unknown[]) => result.console.push(a.map(x => short(x, 300)).join(' ')),
  info: (...a: unknown[]) => result.console.push(a.map(x => short(x, 300)).join(' ')),
  warn: (...a: unknown[]) => result.console.push('warn: ' + a.map(x => short(x, 300)).join(' ')),
  error: (...a: unknown[]) => result.console.push('error: ' + a.map(x => short(x, 300)).join(' ')),
  debug: () => {},
}

// ---- elements ----------------------------------------------------------

const ELEMENT_NAMES = ['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown', 'Client', 'Raster', 'Image', 'Svg']

function normalizeChildren(children: unknown): unknown[] {
  const out: unknown[] = []
  const walk = (c: unknown) => {
    if (c === null || c === undefined || c === false || c === true) return
    if (Array.isArray(c)) {
      for (const x of c) walk(x)
      return
    }
    if (typeof c === 'number') {
      out.push(String(c))
      return
    }
    out.push(c)
  }
  walk(children)
  return out
}

function element(type: string, props: Record<string, unknown> | null | undefined, ...rest: unknown[]) {
  const p = { ...(props ?? {}) }
  const children = rest.length ? rest : p.children
  delete p.children
  return { type, props: p, children: normalizeChildren(children) }
}

function makeTable(surface: string) {
  const table: Record<string, AnyFn> = {}
  const names = surface === 'terminal' ? ELEMENT_NAMES.filter(n => n !== 'Svg') : ELEMENT_NAMES.filter(n => n !== 'Raster' && n !== 'Image')
  for (const n of names) table[n] = (props: Record<string, unknown>) => element(n, props)
  return Object.freeze(table)
}
const TABLES: Record<string, Record<string, AnyFn>> = { terminal: makeTable('terminal'), desktop: makeTable('desktop'), vscode: makeTable('vscode'), mobile: makeTable('mobile') }

// JSX factory: a tag is either a constructor from a table or a string
globalThis.h = (tag: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
  if (typeof tag === 'function') return (tag as AnyFn)({ ...(props ?? {}), children: children.length ? children : (props as any)?.children })
  if (tag === globalThis.Fragment) return normalizeChildren(children)
  return element(String(tag), props, ...children)
}
globalThis.Fragment = Symbol('Fragment')

// ---- the hook chain ------------------------------------------------------

const hooks: Hook[] = []
const on = (event: string, a: unknown, b?: unknown) => {
  const matcher = typeof a === 'function' ? undefined : (a as Record<string, unknown>)
  const hook = (typeof a === 'function' ? a : b) as AnyFn
  const entry: Hook = { event, matcher, hook }
  hooks.push(entry)
  result.hooks.push({ event, matcher: matcher ? safeMatcher(matcher) : undefined })
  return {
    catch(h: AnyFn) {
      entry.catcher = h
      return this
    },
  }
}
function safeMatcher(m: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(m)) out[k] = v instanceof RegExp ? `/${v.source}/${v.flags}` : typeof v === 'object' && v && !Array.isArray(v) ? safeMatcher(v as Record<string, unknown>) : v
  return out
}
function matches(m: unknown, e: unknown): boolean {
  if (m === undefined) return true
  if (m instanceof RegExp) return typeof e === 'string' && m.test(e)
  if (Array.isArray(m)) return m.some(x => matches(x, e))
  if (m && typeof m === 'object') {
    if (!e || typeof e !== 'object') return false
    return Object.entries(m as Record<string, unknown>).every(([k, v]) => matches(v, (e as Record<string, unknown>)[k]))
  }
  return m === e
}
function eventMatches(pattern: string, event: string) {
  if (pattern === event) return true
  if (pattern === '*') return !event.startsWith('telemetry.')
  if (pattern.endsWith('.*')) return event.startsWith(pattern.slice(0, -1))
  return false
}

const $: Record<string, any> = {}
let turnCount = 0

async function dispatch(event: string, e: Record<string, unknown>, core: (e: Record<string, unknown>) => unknown): Promise<any> {
  const chain = hooks.filter(h => eventMatches(h.event, event) && matches(h.matcher, e))
  const signal = new AbortSignalShim()
  const run = async (i: number, ev: Record<string, unknown>): Promise<unknown> => {
    if (i >= chain.length) return core(ev)
    const h = chain[i]!
    const frozen = deepFreeze(ev)
    let called = false
    const next: any = (e2: Record<string, unknown>) => {
      called = true
      return run(i + 1, e2 ?? ev)
    }
    next.signal = signal
    next.origin = { plugin: 'engine', tier: 'core' }
    next.budget = { ms: 10_000, remainingMs: 10_000 }
    next.to = (e2: Record<string, unknown>) => run(chain.length, e2 ?? ev)
    try {
      const out = h.hook($, frozen, next)
      // async generator hooks (turn.step, process.spawn): drain them
      if (out && typeof out === 'object' && typeof (out as any)[Symbol.asyncIterator] === 'function' && typeof (out as any).next === 'function') {
        let step = await (out as any).next()
        while (!step.done) step = await (out as any).next()
        return step.value
      }
      return await out
    } catch (err) {
      note(`${event}: hook threw ${short(String((err as Error)?.message ?? err), 120)}${called ? ' (after next)' : ''}`)
      if (h.catcher) {
        try {
          const n2: any = (e2: Record<string, unknown>) => run(i + 1, e2 ?? ev)
          n2.error = { kind: 'throw', message: String((err as Error)?.message ?? err) }
          n2.called = called
          n2.signal = signal
          return await h.catcher($, frozen, n2)
        } catch (err2) {
          note(`${event}: catch handler threw ${short(String(err2), 100)}`)
        }
      }
      if (called) return core(ev)
      return run(i + 1, ev)
    }
  }
  return run(0, e)
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as any)[k])
  }
  return v
}

// ---- the fake mods API ---------------------------------------------------

const store = new Map<string, unknown>()
const state = new Map<string, { value: unknown; version: number }>()
const panes = new Map<string, { id: string; title?: string }>()
const stateKey = (ref: any) => `${ref.plugin}.${ref.key}${ref.id !== undefined ? `[${ref.id}]` : ''}`
let now = BASE_NOW

const CANNED_FILES: Record<string, string> = {
  '/work/app/package.json': JSON.stringify({ name: 'app', version: '1.4.2', scripts: { test: 'bun test', build: 'bun run build.ts', lint: 'eslint .' }, dependencies: { hono: '^4.7.0', zod: '^3.24.0' } }, null, 2),
  '/work/app/README.md': '# app\n\nAn example service. Run `bun test` to test.\n',
  '/work/app/src/auth.ts': "import { verify } from './jwt'\n\nexport async function refresh(token: string) {\n  const claims = await verify(token)\n  if (!claims) throw new Error('invalid token')\n  return issue(claims.sub)\n}\n",
  '/work/app/src/auth.test.ts': "import { test, expect } from 'bun:test'\nimport { refresh } from './auth'\n\ntest('refreshes expired token', async () => {\n  expect(await refresh('expired')).toBeTruthy()\n})\n",
  // the fake key is assembled so no secret-shaped literal sits in the repository
  '/work/app/.env': `DATABASE_URL=postgres://app:hunter2@db.internal:5432/app\nSTRIPE_SECRET_KEY=${['sk', 'live', '51H' + 'x'.repeat(24)].join('_')}\n`,
  '/work/app/CLAUDE.md': '# Project notes\n\nUse bun. Run tests before committing.\n',
  '/work/app/bun.lock': '# bun lockfile v1\n',
  '/work/app/.gitignore': 'node_modules\ndist\n.env\n',
}
const resolvePath = (p: string) => (p.startsWith('/') ? p : p.startsWith('~') ? p.replace('~', '/Users/dev') : `/work/app/${p.replace(/^\.\//, '')}`)

function cannedProcess(argv: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const cmd = argv.join(' ')
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
  if (/^git (branch --show-current|rev-parse --abbrev-ref HEAD|symbolic-ref)/.test(cmd)) return ok('feat/auth-refresh\n')
  if (/^git rev-parse --show-toplevel/.test(cmd)) return ok('/work/app\n')
  if (/^git rev-parse/.test(cmd)) return ok('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n')
  if (/^git status/.test(cmd)) return ok(' M src/auth.ts\n?? src/auth.test.ts\n')
  if (/^git diff.*--shortstat/.test(cmd)) return ok(' 2 files changed, 14 insertions(+), 3 deletions(-)\n')
  if (/^git diff.*--numstat/.test(cmd)) return ok('11\t3\tsrc/auth.ts\n3\t0\tsrc/auth.test.ts\n')
  if (/^git diff.*--stat/.test(cmd)) return ok(' src/auth.ts      | 14 +++++++++---\n src/auth.test.ts |  3 +++\n 2 files changed, 14 insertions(+), 3 deletions(-)\n')
  if (/^git diff.*--name-only/.test(cmd)) return ok('src/auth.ts\nsrc/auth.test.ts\n')
  if (/^git diff/.test(cmd)) return ok("diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -3,4 +3,5 @@\n export async function refresh(token: string) {\n   const claims = await verify(token)\n-  if (!claims) throw new Error('invalid token')\n+  if (!claims || claims.exp < Date.now() / 1000) throw new Error('invalid token')\n+  await audit('refresh', claims.sub)\n   return issue(claims.sub)\n")
  if (/^git log/.test(cmd)) return ok('a1b2c3d fix: refresh expired tokens (2 minutes ago)\n9f8e7d6 feat: add audit log (3 hours ago)\n')
  if (/^git remote/.test(cmd)) return ok('https://github.com/acme/app.git\n')
  if (/^git (stash list|worktree list)/.test(cmd)) return ok('')
  if (/^git /.test(cmd)) return ok('')
  if (/^gh pr (checks|status|view)/.test(cmd)) return ok('[{"name":"ci","state":"SUCCESS"},{"name":"lint","state":"PENDING"}]\n')
  if (/^gh /.test(cmd)) return ok('')
  if (/^(bun|npm|pnpm|yarn|npx) (test|run test|t)\b|^(pytest|cargo test|go test|vitest|jest|mocha)/.test(cmd)) return { exitCode: 1, stdout: 'src/auth.test.ts:\n✓ refreshes expired token\n✓ rejects a bad signature\n✓ issues a new token\n✗ revokes on logout\n  error: expected 401, got 200\n\n 3 pass\n 1 fail\n', stderr: '' }
  if (/^(tsc|bunx tsc|npx tsc)/.test(cmd)) return ok('')
  if (/^(eslint|biome|ruff|prettier)/.test(cmd)) return ok('')
  if (/^(sleep|true|echo)/.test(cmd)) return ok(argv[0] === 'echo' ? argv.slice(1).join(' ') + '\n' : '')
  if (/^(rg|grep)/.test(cmd)) return ok('src/api.ts:12:import { refresh } from "./auth"\nsrc/session.ts:4:import { refresh } from "./auth"\n')
  if (/^(ls|find|fd)/.test(cmd)) return ok('package.json\nREADME.md\nsrc\n')
  if (/^(wc)/.test(cmd)) return ok('   42 src/auth.ts\n')
  if (/^(pbcopy|xclip|wl-copy|osascript|notify-send|say|afplay|open|xdg-open)/.test(cmd)) return ok('')
  if (/^(uname|hostname|whoami|date|which|node|bun|python|python3|uv)\b/.test(cmd)) return ok('dev\n')
  return ok('')
}

function makeStream(final: unknown) {
  const s: any = {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true, value: final }) }
    },
    then: (res: AnyFn, rej?: AnyFn) => Promise.resolve(final).then(res, rej),
    catch: (rej: AnyFn) => Promise.resolve(final).catch(rej),
    finally: (fn: AnyFn) => Promise.resolve(final).finally(fn),
    next: async () => ({ done: true, value: final }),
    return: async () => ({ done: true, value: final }),
  }
  return s
}

const PLUGIN = { name: 'mod', root: '/plugins/mod' }
let sleeps = 0
let snapshots = 0
let rendering = false
let pendingSnapshot: Promise<void> | null = null
const transient: Record<string, unknown> = {} // latest real tree per site, taken mid-session

async function snapshot() {
  if (rendering) return
  rendering = true
  try {
    for (const id of panes.keys()) {
      const r = await renderSite('Pane', id, { title: panes.get(id)?.title ?? id, isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} })
      if (r.ok === true) transient[`Pane:${id}`] = { ...r, transient: true, title: panes.get(id)?.title }
    }
    const band = await renderSite('AbovePrompt', 'band', { ...SITE_PROPS.AbovePrompt, isWorking: true })
    if (band.ok === true) transient.AbovePrompt = { ...band, transient: true }
    const spinner = await renderSite('Spinner', 'main', SITE_PROPS.Spinner!)
    if (spinner.ok === true || (spinner.ok === 'engine' && spinner.props)) transient.Spinner = { ...spinner, transient: true }
  } catch {
    // a snapshot never fails the preview
  } finally {
    rendering = false
  }
}
const usage = () => ({
  startedAt: BASE_NOW - 1_800_000,
  context: { tokens: 97_400, window: 200_000, percent: 49 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 31, resetsAt: BASE_NOW + 3_600_000 }],
  cost: { usd: 0.42 },
})

function buildApi() {
  const rec = (ns: string, name: string, impl: AnyFn) => (...a: unknown[]) => {
    count(`$.${ns}.${name}`)
    return impl(...a)
  }
  const ns = (name: string, impls: Record<string, AnyFn>) => {
    const o: Record<string, AnyFn> = {}
    for (const [k, v] of Object.entries(impls)) o[k] = rec(name, k, v)
    $[name] = o
  }
  $.plugin = PLUGIN
  ns('ui', {
    resolve: (e: { surface?: string }) => TABLES[e?.surface ?? 'terminal'] ?? TABLES.terminal,
    invalidate: () => {
      // redraw what is open right now; the latest real tree per site is kept
      // as a fallback for sites that draw nothing once the session is idle
      if (!rendering && snapshots < 60) {
        snapshots++
        pendingSnapshot = snapshot()
      }
    },
    blit: async () => ({}),
    log: (text: string) => {
      result.logs.push(String(text))
    },
    ask: async (question: string, options?: string[] | { options?: string[] }) => {
      const opts = Array.isArray(options) ? options : options?.options ?? []
      // a guard's question is answered with the cautious option, so the
      // preview shows the guard doing its job
      const cautious = opts.find(o => /refuse|cancel|deny|block|skip|don'?t|no\b/i.test(String(o)))
      const answer = String(cautious ?? opts[0] ?? 'Yes')
      note(`$.ui.ask(${short(question, 80)}) → "${answer}"`)
      return answer
    },
    toast: (text: string) => {
      result.toasts.push(String(text))
    },
    status: (text: string | undefined) => {
      result.status = text === undefined ? undefined : String(text)
    },
    open: async (p: { id: string; title?: string }) => {
      panes.set(p.id, { id: p.id, title: p.title })
      if (!result.panes.some(x => x.id === p.id)) result.panes.push({ id: p.id, title: p.title })
      note(`$.ui.open(${p.id})`)
      return { isPlaced: true }
    },
    close: async (p: { id: string }) => {
      panes.delete(p.id)
    },
    panes: async () => [...panes.values()].map(p => ({ ...p, isPlaced: true })),
    scroll: async () => ({}),
    focus: async () => ({}),
    copy: async () => ({ isCopied: true }),
    selection: async () => undefined,
    notice: () => {},
  })
  ns('command', {
    register: async (spec: { name: string; description: string; argumentHint?: string; immediate?: boolean }) => {
      result.commands.push({ name: spec.name, description: spec.description, argumentHint: spec.argumentHint, immediate: spec.immediate })
    },
    run: (e: Record<string, unknown>) => dispatch('command.run', { args: '', origin: { kind: 'plugin', name: PLUGIN.name }, presentation: { isFullscreen: true, columns: 160 }, ...e }, () => ({ text: '' })),
    list: async () => result.commands.map(c => ({ name: c.name, description: c.description })),
  })
  ns('tool', {
    register: async (spec: { name: string; description: string }) => {
      result.tools.push({ name: spec.name, description: spec.description })
    },
    call: (e: Record<string, unknown>) => dispatch('tool.call', { tool_use_id: `plugin-${Math.random().toString(36).slice(2, 8)}`, ...e }, () => ({ ref: 1, result: 'ok', text: 'ok', isError: false })),
    check: async () => ({ decision: 'allow' }),
    list: async () => [],
  })
  ns('agent', { register: async () => {}, spawn: async () => ({ answer: '', durationMs: 0, isAborted: false, turnId: 'agent-1', reason: 'answer' }), list: async () => [] })
  ns('model', {
    complete: async () => ({ isAnswered: true, text: 'OK', usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    fork: async () => ({ isAnswered: true, text: 'OK', usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    classify: async () => ({ isAnswered: false, reason: 'aborted' }),
  })
  ns('prompt', {
    submit: async () => ({}),
    read: async () => ({ text: '', cursor: 0 }),
    fill: async () => ({ isFilled: true }),
    suggest: async () => ({}),
    compose: async () => ({ sections: [] }),
  })
  ns('turn', { abort: async () => ({}) })
  ns('session', {
    messages: async () => [
      { role: 'user', text: 'fix the failing auth test', toolUses: [] },
      { role: 'assistant', text: 'I updated src/auth.ts to reject expired claims and added an audit call.', toolUses: [{ name: 'Edit', input: { file_path: '/work/app/src/auth.ts' } }] },
    ],
    cwd: async () => '/work/app',
    root: async () => '/work/app',
    model: async () => 'claude-opus-5-5',
    turns: async () => turnCount,
    id: async () => 'preview-session',
    repo: async () => ({ root: '/work/app', remote: 'https://github.com/acme/app.git', internal: false, allowlisted: null }),
    surfaces: async () => ['terminal'],
    surface: async () => 'terminal',
    usage: async () => usage(),
    version: async () => ({ version: '2.1.289', base: '2.1.289', builtAt: '2026-10-03T00:00:00Z' }),
    compact: async () => ({}),
    send: async () => ({ isDelivered: true }),
    append: async () => ({ uuid: 'row-1' }),
    authorize: async () => ({}),
  })
  ns('config', { list: async () => [], set: async () => ({}) })
  ns('settings', { read: async () => ({}) })
  ns('env', {
    get: async (name: string) => ({ HOME: '/Users/dev', USER: 'dev', SHELL: '/bin/zsh', TERM: 'xterm-256color', PATH: '/usr/local/bin:/usr/bin:/bin', TERM_PROGRAM: 'ghostty', LANG: 'en_US.UTF-8' } as Record<string, string>)[name],
    set: async () => {},
  })
  ns('fs', {
    read: async (p: string, opts?: { as?: string }) => {
      const f = CANNED_FILES[resolvePath(p)]
      if (f === undefined) throw new Error(`ENOENT: no such file ${p}`)
      return opts?.as === 'bytes' ? { base64: btoa(f) } : f
    },
    write: async (p: string) => {
      note(`$.fs.write(${p})`)
    },
    list: async (p = '.') => (resolvePath(p) === '/work/app' ? [{ name: 'package.json', kind: 'file', size: 240, isLink: false }, { name: 'src', kind: 'directory', size: 0, isLink: false }, { name: 'README.md', kind: 'file', size: 60, isLink: false }] : []),
    exists: async (p: string) => resolvePath(p) in CANNED_FILES || resolvePath(p) === '/work/app' || resolvePath(p) === '/work/app/src',
    stat: async (p: string) => {
      const r = resolvePath(p)
      if (!(r in CANNED_FILES) && r !== '/work/app' && r !== '/work/app/src') throw new Error(`ENOENT: ${p}`)
      return { kind: r in CANNED_FILES ? 'file' : 'directory', size: CANNED_FILES[r]?.length ?? 0, mtimeMs: BASE_NOW - 60_000, isLink: false, realPath: r }
    },
    ancestors: async () => [],
  })
  ns('store', {
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => {
      store.set(k, v)
    },
    delete: async (k: string) => {
      store.delete(k)
    },
    keys: async () => [...store.keys()],
  })
  ns('state', {
    get: async (ref: any) => {
      const s = state.get(stateKey(ref))
      return s ? { value: s.value, version: s.version } : { version: 0 }
    },
    set: async (ref: any, value: unknown) => {
      const k = stateKey(ref)
      const v = (state.get(k)?.version ?? 0) + 1
      state.set(k, { value, version: v })
      return { isSet: true, version: v }
    },
  })
  ns('clock', {
    // every reading moves time a little, so a loop that polls the clock ends
    now: async () => (now += 20),
    sleep: async (ms: number) => {
      now += Math.min(Number(ms) || 0, 60_000)
    },
    after: (ms: number, fn: AnyFn) => {
      result.timers.push({ kind: 'after', ms: Number(ms) })
      return { cancel() {} }
    },
    every: (ms: number, fn: AnyFn) => {
      result.timers.push({ kind: 'every', ms: Number(ms) })
      return { cancel() {} }
    },
  })
  ns('http', { fetch: async (url: string) => {
    note(`$.http.fetch(${short(url, 100)}) → blocked in preview`)
    return { ok: false, status: 0, headers: {}, text: '' }
  } })
  ns('process', {
    run: async (argv: readonly string[]) => {
      const r = cannedProcess(argv)
      if (argv[0] === 'sleep') {
        now += Math.max(1, Math.round(Number(argv[1] ?? 1) * 1000))
        sleeps++
        if (sleeps === 1) await snapshot() // a hold loop: capture what it drew while holding
        if (sleeps > 5000) throw new Error('preview: too many sleeps; the hold was abandoned')
      } else note(`$.process.run(${short(argv.join(' '), 80)}) → exit ${r.exitCode}`)
      return { ...r, isStdoutTruncated: false, isStderrTruncated: false }
    },
    spawn: (req: { argv?: string[] }) => {
      note(`$.process.spawn(${short((req?.argv ?? []).join(' '), 80)})`)
      return makeStream({ exitCode: 0 })
    },
  })
  ns('mcp', { call: async () => ({}), connect: async () => ({}) })
  ns('audio', { play: async () => {}, speak: async () => {} })
  ns('telemetry', { log: async () => {}, mark: async () => {} })
}

// ---- the fake `claude-code` module ---------------------------------------

const claudeCode = {
  atom: (ref: any, initial: unknown) => ({ __atom: true, ref, initial }),
  derive: (sources: unknown[], fn: AnyFn) => ({ __derived: true, sources, fn }),
  memberOf: (family: any, e: { requestId?: string }) => ({ ...family, ref: { ...family.ref, id: e?.requestId }, initial: family.initial?.byId ?? family.initial }),
  read: async (api: any, src: any): Promise<unknown> => {
    if (src?.__derived) return src.fn(...(await Promise.all((src.sources as any[]).map(s => claudeCode.read(api, s)))))
    const ref = src?.__atom ? src.ref : src
    const got = await api.state.get(ref)
    return got.value === undefined ? src?.initial : got.value
  },
  update: async (api: any, src: any, fn: AnyFn) => {
    const ref = src?.__atom ? src.ref : src
    const cur = await claudeCode.read(api, src)
    const next = fn(cur)
    await api.state.set(ref, next)
    return next
  },
}

// ---- the scripted session ------------------------------------------------

const toolResult = (text: string, extra: Record<string, unknown> = {}) => ({ ref: 1, result: text, text, isError: false, isReadOnly: false, ...extra })

async function replay() {
  const core = (v: unknown) => () => v
  await dispatch('session.start', { cwd: '/work/app', surface: 'terminal', isInteractive: true }, core({ cwd: '/work/app' }))
  note('session.start')
  await dispatch('classic.SessionStart', { hook_event_name: 'SessionStart', session_id: 'preview-session', transcript_path: '/Users/dev/.claude/projects/app/preview.jsonl', cwd: '/work/app', source: 'startup', model: 'claude-opus-5-5' }, core({}))

  const prompt = 'fix the failing auth test and add an audit log call'
  const submitted = await dispatch('prompt.submit', { text: prompt, origin: { kind: 'composer' } }, (e: any) => ({ text: e.text, context: e.context }))
  if (submitted && typeof submitted === 'object' && 'drop' in submitted) result.rewrites.push({ event: 'prompt.submit', summary: `dropped: ${short((submitted as any).drop, 100)}` })
  else if (submitted && (submitted as any).text !== prompt) result.rewrites.push({ event: 'prompt.submit', summary: `text → ${short((submitted as any).text, 140)}` })
  else if ((submitted as any)?.context?.length) result.rewrites.push({ event: 'prompt.submit', summary: `context added: ${short((submitted as any).context, 140)}` })
  await dispatch('classic.UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 'preview-session', transcript_path: '', cwd: '/work/app', prompt }, core({}))
  turnCount++
  await dispatch('turn.start', { turnId: 'turn-1' }, core({ turnId: 'turn-1' }))

  const calls: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ tool: 'Read', file_path: '/work/app/src/auth.ts' }, toolResult(CANNED_FILES['/work/app/src/auth.ts']!, { isReadOnly: true })],
    [{ tool: 'Grep', pattern: 'refresh\\(', path: '/work/app/src' }, toolResult('src/api.ts:12\nsrc/session.ts:4', { isReadOnly: true })],
    [{ tool: 'Edit', file_path: '/work/app/src/auth.ts', old_string: "if (!claims) throw new Error('invalid token')", new_string: "if (!claims || claims.exp < Date.now() / 1000) throw new Error('invalid token')\n  await audit('refresh', claims.sub)" }, toolResult('The file /work/app/src/auth.ts has been updated.')],
    [{ tool: 'Write', file_path: '/work/app/src/audit.ts', content: "// TODO: implement persistence\nexport async function audit(event: string, subject: string) {\n  console.log('audit', event, subject)\n  // ... rest of the implementation\n}\n" }, toolResult('File created successfully at: /work/app/src/audit.ts')],
    [{ tool: 'Write', file_path: '/work/app/src/cache.ts', content: "// TODO: implement eviction later\nconst store = new Map<string, unknown>()\n\nexport function remember(key: string, value: unknown) {\n  console.log('here')\n  store.set(key, value)\n}\n" }, toolResult('File created successfully at: /work/app/src/cache.ts')],
    [{ tool: 'Bash', command: 'bun test', description: 'Run the test suite' }, { ref: 1, result: cannedProcess(['bun', 'test']).stdout, text: cannedProcess(['bun', 'test']).stdout, isError: true }],
    [{ tool: 'Bash', command: 'git status --porcelain', description: 'Show working tree status' }, toolResult(' M src/auth.ts\n?? src/audit.ts\n', { isReadOnly: true })],
    [{ tool: 'Bash', command: 'rm -rf build && git push --force origin main', description: 'Clean build output and push' }, toolResult('')],
    [{ tool: 'Bash', command: 'cat .env', description: 'Show environment file' }, toolResult(CANNED_FILES['/work/app/.env']!, { isReadOnly: true })],
  ]
  let n = 0
  for (const [input, out] of calls) {
    n++
    const id = `toolu_0${n}`
    const e = { tool_use_id: id, ...input }
    const res = await dispatch('tool.call', e, () => out)
    const name = String(input.tool)
    if (res && typeof res === 'object' && typeof (res as any).deny === 'string') {
      result.denies.push({ tool: name === 'Bash' ? `${name}: ${short(input.command, 60)}` : `${name}: ${short(input.file_path ?? '', 60)}`, reason: String((res as any).deny).slice(0, 300) })
      note(`tool.call ${name} denied: ${short((res as any).deny, 100)}`)
      continue
    }
    if (res && typeof res === 'object' && (res as any).text !== (out as any).text && (res as any).result !== (out as any).result) result.rewrites.push({ event: 'tool.call', summary: `${name} result rewritten → ${short((res as any).text ?? (res as any).result, 140)}` })
    note(`tool.call ${name}${name === 'Bash' ? ' ' + short(input.command, 50) : ''}`)
    await dispatch('classic.PostToolUse', { hook_event_name: 'PostToolUse', session_id: 'preview-session', transcript_path: '', cwd: '/work/app', tool_name: name, tool_input: input, tool_response: (out as any).result, tool_use_id: id }, core({}))
    await dispatch('session.append', { door: 'tool-result', origin: { kind: 'tool', tool: name }, uuid: `row-${n}`, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: String((out as any).text ?? ''), is_error: Boolean((out as any).isError) }] } }, (e: any) => ({ message: e.message, uuid: e.uuid }))
  }

  const turnUsage = { input_tokens: 2_100, output_tokens: 1_480, cache_read_input_tokens: 91_000, cache_creation_input_tokens: 4_300, model: 'claude-opus-5-5' }
  const answer = 'Done. I made `refresh` reject expired claims, added an audit call, and created `src/audit.ts`. One test still fails (`revokes on logout`), which looks unrelated to this change.'
  const completed = await dispatch('turn.complete', { answer, durationMs: 42_000, isAborted: false, turnId: 'turn-1', reason: 'answer', usage: turnUsage }, core({ text: '', usage: turnUsage }))
  if (completed && typeof completed === 'object' && (completed as any).text) result.rewrites.push({ event: 'turn.complete', summary: `line under the answer: ${short((completed as any).text, 140)}` })
  await dispatch('session.measure', { context: usage().context, rateLimits: usage().rateLimits, cost: usage().cost, changed: ['context', 'cost'] }, core({ changed: ['context', 'cost'] }))
  await dispatch('classic.Stop', { hook_event_name: 'Stop', session_id: 'preview-session', transcript_path: '', cwd: '/work/app', stop_hook_active: false }, core({}))
  note('turn.complete')

  // run each command the mod registered, once, now that the session has
  // something to show; a pane a command opens is drawn afterwards
  for (const c of [...result.commands]) {
    try {
      const out = await dispatch('command.run', { command: c.name, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }, core({ text: '' }))
      if (out && typeof out === 'object' && typeof (out as any).text === 'string' && (out as any).text) c.output = String((out as any).text).slice(0, 2000)
      note(`/${c.name} → ${short((out as any)?.text ?? '', 80)}`)
    } catch (err) {
      note(`/${c.name} threw ${short(String(err), 80)}`)
    }
  }
}

// ---- rendering -----------------------------------------------------------

const SITE_PROPS: Record<string, Record<string, unknown>> = {
  AbovePrompt: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
  Spinner: { word: 'Thinking', message: null, suffix: '', mode: 'thinking' },
  PromptHint: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  TurnDuration: { word: 'Worked', durationMs: 42_000 },
  SessionMode: { modes: ['auto-accept edits'] },
  InfoNotice: { text: 'Tip: use /diff to review changes', command: null },
  UserMessage: { text: 'fix the failing auth test and add an audit log call', origin: { kind: 'composer' }, isExpanded: false },
  AssistantMessage: { text: 'Done. I made refresh reject expired claims and added an audit call.' },
  ToolUse: { tool: 'Edit', input: { file_path: '/work/app/src/auth.ts' }, isResolved: true },
  CommandOutput: { command: '', text: '' },
}

async function renderSite(component: string, requestId: string, props: Record<string, unknown>) {
  let ref = 0
  try {
    const out = await dispatch(
      'ui.render',
      { component, surface: 'terminal', requestId, props, viewport: { columns: 160, rows: 42, isFullscreen: true } },
      (e: any) => ({ type: 'engine', ref: ++ref, props: e.props }),
    )
    if (!out || typeof out !== 'object') return { ok: false, reason: `hook returned ${short(out, 60)}` }
    if ((out as any).type === 'engine') {
      const changed = JSON.stringify((out as any).props) !== JSON.stringify(props)
      return { ok: 'engine', props: changed ? (out as any).props : undefined }
    }
    return { ok: true, tree: stripFunctions(out) }
  } catch (err) {
    return { ok: false, reason: short(String(err), 200) }
  }
}

function stripFunctions(v: unknown, depth = 0): unknown {
  if (depth > 40) return '…'
  if (Array.isArray(v)) return v.map(x => stripFunctions(x, depth + 1))
  if (typeof v === 'function') return '[fn]'
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'function') o[k] = '[fn]'
      else if (k === 'cells' && typeof val === 'string' && val.length > 4000) o[k] = val.slice(0, 4000)
      else o[k] = stripFunctions(val, depth + 1)
    }
    return o
  }
  if (typeof v === 'string' && v.length > 20_000) return v.slice(0, 20_000)
  return v
}

async function renderAll() {
  if (pendingSnapshot) await pendingSnapshot
  rendering = true
  const sites: Record<string, unknown> = {}
  const hooked = (component: string) => hooks.some(h => h.event === 'ui.render' && (!h.matcher || h.matcher.component === undefined || matches(h.matcher.component, component)))
  for (const [component, props] of Object.entries(SITE_PROPS)) {
    if (!hooked(component)) continue
    const requestId = component === 'ToolUse' ? 'toolu_03' : component === 'CommandOutput' ? 'msg-cmd' : component === 'Spinner' ? 'main' : 'msg-1'
    const p = component === 'CommandOutput' && result.commands[0] ? { command: result.commands[0].name, text: result.commands[0].output ?? '' } : props
    sites[component] = await renderSite(component, requestId, p)
  }
  if (hooked('Pane')) {
    const ids = new Set<string>(panes.keys())
    for (const h of hooks) if (h.event === 'ui.render' && h.matcher?.component === 'Pane' && typeof h.matcher.requestId === 'string') ids.add(h.matcher.requestId)
    if (ids.size === 0) ids.add(result.commands[0]?.name ?? PLUGIN.name)
    const out: Record<string, unknown> = {}
    for (const id of ids) {
      const title = panes.get(id)?.title ?? id
      const r = await renderSite('Pane', id, { title, isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} })
      out[id] = r.ok === true ? { ...r, title } : (transient[`Pane:${id}`] ?? { ...r, title })
    }
    for (const [k, v] of Object.entries(transient)) if (k.startsWith('Pane:') && !(k.slice(5) in out)) out[k.slice(5)] = v
    sites.Pane = out
  }
  for (const k of ['AbovePrompt', 'Spinner'] as const) {
    const cur = sites[k] as { ok: unknown } | undefined
    if (transient[k] && (!cur || cur.ok !== true)) sites[k] = transient[k]
  }
  result.sites = sites
}

// ---- entry ---------------------------------------------------------------

globalThis.__slop = {
  async run(bundle: string, optionsJson: string): Promise<string> {
    const opts = JSON.parse(optionsJson || '{}') as { name?: string; options?: Record<string, unknown> }
    PLUGIN.name = opts.name ?? 'mod'
    PLUGIN.root = `/plugins/${PLUGIN.name}`
    buildApi()
    try {
      const module = { exports: {} as Record<string, unknown> }
      const require = (id: string) => {
        if (id === 'claude-code') return claudeCode
        throw new Error(`cannot require ${id} in a hooks module`)
      }
      const fn = new Function('module', 'exports', 'require', 'h', 'Fragment', bundle + '\n')
      fn(module, module.exports, require, globalThis.h, globalThis.Fragment)
      const register = (module.exports.register ?? (module.exports.default as any)?.register ?? module.exports.default) as AnyFn | undefined
      if (typeof register !== 'function') throw new Error('the module exports no register function')
      await register(on, opts.options ?? {})
      await replay()
      await renderAll()
    } catch (err) {
      result.ok = false
      result.error = short(String((err as Error)?.stack ?? err), 600)
    }
    return JSON.stringify(result)
  },
}
