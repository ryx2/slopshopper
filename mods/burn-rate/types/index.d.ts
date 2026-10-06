export type Reading = {
  /** Input tokens the last response was answered over. */
  tokens: number
  /** The model's context window, in tokens. */
  window: number
  /** tokens over window, 0 to 100. */
  percent: number
  /** Dollars spent this session, when the host keeps a ledger. */
  usd: number | null
  /** Dollars per hour since the session started. */
  usdPerHour: number | null
  /** The tightest rate-limit window, when the account has one. */
  limit: { kind: string; percentUsed: number } | null
  /** When the reading was taken, in clock milliseconds. */
  at: number
}

export type TurnStat = {
  /** Uncached + cached input tokens of the turn's requests. */
  input: number
  output: number
  durationMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'burn-rate': {
      reading: Reading | null
      turns: TurnStat[]
      isHidden: boolean
      hasWarned: boolean
    }
  }
}
