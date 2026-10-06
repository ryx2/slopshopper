export type FileReceipt = {
  path: string
  /** Times the file was written whole. */
  writes: number
  /** Times it was edited in place. */
  edits: number
  /** The turn it was first touched in. */
  turn: number
}

export type CommandReceipt = {
  command: string
  isError: boolean
  turn: number
}

declare module 'claude-code' {
  interface PluginState {
    receipts: {
      files: FileReceipt[]
      commands: CommandReceipt[]
      turnCount: number
      /** `git diff --shortstat` after the last turn, or ''. */
      diffstat: string
      turnFiles: number
      turnCommands: number
    }
  }
}
