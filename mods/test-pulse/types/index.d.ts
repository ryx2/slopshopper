export type TestRun = {
  command: string
  ok: boolean
  /** Counts parsed from the output; null when the runner's format is unknown. */
  passed: number | null
  failed: number | null
  /** The first failing test's name, when the output names one. */
  firstFailure: string | null
  durationMs: number
  /** The last lines of combined output. */
  tail: string[]
  at: number
  /** The run was cut short by the timeout. */
  timedOut: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'test-pulse': {
      last: TestRun | null
      isRunning: boolean
      isHidden: boolean
      dirty: boolean
    }
  }
}
