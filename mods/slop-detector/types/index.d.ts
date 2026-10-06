export type Finding = {
  /** The file the slop landed in. */
  file: string
  /** 1-based line within the written text. */
  line: number
  /** Short name of the pattern: truncation, todo-stub, not-implemented, debug-print, ts-ignore, lorem, placeholder, duplicate-lines, long-line. */
  kind: string
  /** The offending line, trimmed. */
  snippet: string
  /** How much it counts toward the session's slop score. */
  weight: number
  /** True for a finding that destroys code if the write goes through. */
  hard: boolean
  /** The turn it was found in. */
  turn: number
}

declare module 'claude-code' {
  interface PluginState {
    'slop-detector': {
      findings: Finding[]
      turnCount: number
      turnFindings: number
      isHidden: boolean
    }
  }
}
