// Shared data shapes for the index, previews, and the site build.

export type ModKind = 'community' | 'slopshopper' | 'sample' | 'builtin'

export type ModAuthor = { name: string; url?: string; email?: string }

export type ModRepo = {
  fullName: string
  url: string
  stars: number
  forks: number
  license: string | null
  pushedAt: string
  createdAt: string
  description: string | null
  homepage: string | null
  topics: string[]
  archived: boolean
  ownerAvatar: string
  ownerUrl: string
  defaultBranch: string
}

export type UserConfigField = {
  type?: string
  title?: string
  description?: string
  default?: unknown
  options?: string[]
  secret?: boolean
}

export type ModEntry = {
  slug: string
  name: string
  displayName?: string
  description: string
  version?: string
  author?: ModAuthor
  license?: string
  homepage?: string
  keywords: string[]
  kind: ModKind
  repo: ModRepo
  /** Directory of the plugin inside the repo ('' for the repo root). */
  path: string
  modules: string[]
  entry: string
  userConfig?: Record<string, UserConfigField>
  hasTypes: boolean
  hasTests: boolean
  hasMarketplace: boolean
  marketplaceName?: string
  readme?: string
  firstSeen: string
  modUpdatedAt: string
  /** Source files kept for the preview harness and the source viewer. */
  files: Record<string, string>
  fileBytes: number
}

export type Index = {
  generatedAt: string
  mods: ModEntry[]
}

// ---- preview output ----------------------------------------------------

export type Tree = { type: string; props: Record<string, unknown>; children: TreeChild[] } | { type: 'engine'; ref: number; props?: Record<string, unknown> }
export type TreeChild = Tree | string | number | null | boolean | undefined

export type SiteRender = { ok: true; tree: Tree } | { ok: false; reason: string } | { ok: 'engine'; props?: Record<string, unknown> }

export type Preview = {
  slug: string
  generatedAt: string
  harness: {
    ok: boolean
    error?: string
    hooks: { event: string; matcher?: Record<string, unknown> }[]
    commands: { name: string; description: string; argumentHint?: string; immediate?: boolean; output?: string }[]
    tools: { name: string; description: string }[]
    panes: { id: string; title?: string }[]
    toasts: string[]
    status?: string
    logs: string[]
    denies: { tool: string; reason: string }[]
    rewrites: { event: string; summary: string }[]
    apiCalls: Record<string, number>
    timers: { kind: 'every' | 'after'; ms: number }[]
    sites: {
      AbovePrompt?: SiteRender
      Spinner?: SiteRender
      PromptHint?: SiteRender
      TurnDuration?: SiteRender
      SessionMode?: SiteRender
      InfoNotice?: SiteRender
      UserMessage?: SiteRender
      AssistantMessage?: SiteRender
      ToolUse?: SiteRender
      CommandOutput?: SiteRender
      Pane?: Record<string, SiteRender>
    }
    script: string[]
    console: string[]
  }
  validate: {
    ok: boolean
    errors: string[]
    warnings: string[]
    hooks: string[]
    calls: string[]
    stateReads: string[]
    stateWrites: string[]
    envReads: string[]
    raw?: unknown
  }
}
