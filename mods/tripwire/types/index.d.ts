export type Decision = {
  /** The command or file the call concerned, trimmed. */
  what: string
  /** Why it tripped: force-push, rm, reset, drop-table, pipe-to-shell, sudo, env-file, ... */
  rule: string
  /** What happened: ran, refused, or denied (never askable). */
  outcome: 'ran' | 'refused' | 'denied'
  /** Who decided: the person, the rule, or the guard failing closed. */
  by: 'person' | 'rule' | 'fail-closed' | 'no-one-to-ask'
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    tripwire: {
      decisions: Decision[]
    }
  }
}
