# receipts

A ledger of what Claude touched this session.

```text
 ✻ Thinking · 2 files · 3 cmds…
```

```text
╭──────────────────────────────────────────────╮
│ ▤ receipts  2 files · 3 commands · 1 failed  │
│  2 files changed, 14 insertions(+), 3 del…   │
│                                              │
│ Files                                        │
│ new src/audit.ts                             │
│ mod src/auth.ts ×2                           │
│                                              │
│ Commands                                     │
│ ✗ bun test                                   │
│ ✓ git status --porcelain                     │
│                                              │
│ [ Copy as Markdown ]  [ Clear ]  [ Close ]   │
╰──────────────────────────────────────────────╯
```

| Hook | What it does |
| --- | --- |
| `tool.call` on `Write` and `Edit` | Records the file, counting whole writes and in-place edits separately. A refused or failed call is not recorded. |
| `tool.call` on `Bash` | Records the command and whether it failed. |
| `turn.complete` | Runs `git diff --shortstat` so the ledger has line counts. |
| `ui.render` on `Spinner` | Adds `· 2 files · 3 cmds` after the spinner's word while Claude works. |
| `/receipts` | Prints the ledger as Markdown and opens the pane. `/receipts copy` puts it on the clipboard instead. |

The Markdown is written for a pull request description or a standup note:

```markdown
## Session receipts

3 turns · 2 files · 5 commands · 2 files changed, 14 insertions(+), 3 deletions(-)

### Files
- new `src/audit.ts`
- modified `src/auth.ts` (2 edits)

### Commands
- ✗ `bun test`
- ✓ `git status --porcelain`
```

The ledger lives in `$.state`, so it survives a hot reload of the mod and resets with `/clear`.

## Install

```bash
claude plugin marketplace add ryx2/slopshopper
claude plugin install receipts@slopshopper
```

Tested with Claude Code 2.1.289. `claude plugin validate` and `claude plugin test` pass. The only process it starts is `git diff --shortstat`.
