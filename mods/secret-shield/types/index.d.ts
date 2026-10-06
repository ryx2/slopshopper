export type ShieldEvent = {
  /** 'redacted' for a tool result, 'refused' for a write or command. */
  action: 'redacted' | 'refused'
  /** The secret's kind: anthropic-key, github-token, private-key, ... */
  kind: string
  /** The tool that produced or carried it. */
  tool: string
  /** The turn it happened in. */
  turn: number
}

declare module 'claude-code' {
  interface PluginState {
    'secret-shield': {
      events: ShieldEvent[]
      turnCount: number
      isHidden: boolean
    }
  }
}
