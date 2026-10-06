# slop-detector

Catches slop as Claude writes it.

```text
 ⚠ slop 7  3 findings · latest: todo-stub in src/audit.ts:1   r: Review   h: Hide
```

| Hook | What it does |
| --- | --- |
| `tool.call` on `Write` and `Edit` | Scans the text about to land in the file. A truncation marker (`// ... rest of the code`, `# ... existing code ...`) is **refused**: letting it through would replace real code with a comment, and the deny text tells Claude to write the whole file. Softer leftovers are recorded and toasted. |
| `turn.complete` | Adds a line under the answer: `slop-detector: 2 findings this turn · /slop to review`. |
| `ui.render` on `AbovePrompt` | The session's slop score, the latest finding, and buttons to review or hide. |
| `ui.render` on `Pane` | `/slop` opens a pane listing every finding, file by file, with Clear and Close. |

## What counts as slop

| Kind | Weight | Example |
| --- | --- | --- |
| `truncation` (refused) | 10 | `// ... rest of the code unchanged`, `# ... existing code ...`, `/* previous implementation stays */` |
| `not-implemented` | 4 | `throw new Error('not implemented')`, `NotImplementedError`, `todo!()` |
| `todo-stub` | 3 | `// TODO: implement this later` |
| `placeholder` | 3 | `// your code here`, `pass  # TODO` |
| `lorem` | 2 | `lorem ipsum` |
| `debug-print` | 2 | `console.log('here')`, `debugger`, `breakpoint()` |
| `ts-ignore` | 2 | `@ts-ignore`, `eslint-disable`, `# type: ignore` |
| `todo` | 1 | any other `TODO` or `FIXME` comment |
| `any-cast` | 1 | `as any` |
| `duplicate-lines`, `long-line` | 1 | the same non-trivial line four times; a 400-column line |

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `strict` | `false` | Also refuse edits that add a stub of weight 3 or more, not only truncation markers. |
| `ignore` | `.test.,.spec.,.md,/fixtures/,/snapshots/` | Comma-separated path fragments that are never scanned. |

Set options in `~/.claude/settings.json` under `pluginConfigs` → `slop-detector@slopshopper`, or in `/config`.

## Install

```bash
claude plugin marketplace add ryx2/slopshopper
claude plugin install slop-detector@slopshopper
```

Tested with Claude Code 2.1.289. `claude plugin validate` and `claude plugin test` pass.
