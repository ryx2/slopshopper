# burn-rate

A fuel gauge above the prompt.

```text
 ▮▮▮▮▮▮▯▯▯▯▯▯  49%  97k/200k  $0.42  $0.84/h  5h 31%  ⇅ 97k/1.5k  ▁▃▂█  ×
```

| Figure | Where it comes from |
| --- | --- |
| bar and percent | `$.session.usage().context`: the same numbers as the status line's `used_percentage` |
| tokens | input tokens of the last response over the model's context window |
| `$0.42` | the session's cost ledger, when the host keeps one |
| `$0.84/h` | cost divided by hours since the session started |
| `5h 31%` | the tightest rate-limit window your plan reports |
| `⇅ 97k/1.5k` | the last turn's input and output tokens |
| sparkline | input tokens of the last 16 turns |

The bar turns yellow at 50%, magenta at 75%, red at 90%, and once the window passes `warnAt` (default 80) a toast suggests compacting.

`/burn` prints the same figures as text, which also works in `claude -p`.

| Hook | What it does |
| --- | --- |
| `session.start` | Registers `/burn` and takes a first reading. |
| `turn.complete` | Records the turn's token counts and takes a reading. Subagent turns are skipped. |
| `session.measure` | Takes a reading when the host reports new figures. |
| `ui.render` on `AbovePrompt` | Draws the gauge. Hides itself while a survey is up, and after you press `×`. |

The band is one line; on a terminal narrower than 70 columns it drops the rate, the plan window and the sparkline.

## Install

```bash
claude plugin marketplace add ryx2/slopshopper
claude plugin install burn-rate@slopshopper
```

Tested with Claude Code 2.1.289. `claude plugin validate` and `claude plugin test` pass. The mod calls no model and sends nothing anywhere.
