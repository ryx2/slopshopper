# test-pulse

Runs your tests after every turn in which Claude changed source, and keeps the result above the prompt.

```text
 ✗ tests 3 pass, 1 fail  revokes on logout  bun run test · 2.1s   d: Details   t: Re-run   h: Hide
```

```text
 ✓ tests 12 pass  bun run test · 1.4s   d: Details   t: Re-run   h: Hide
```

| Hook | What it does |
| --- | --- |
| `tool.call` on `Write` and `Edit` | Marks the session dirty when a file with a source extension changes. |
| `turn.complete` | If dirty, runs the test command once, parses the counts, stores the run, and adds a line under the answer: `test-pulse: ✗ 3 pass, 1 fail · first failure: revokes on logout (bun run test, 2.1s)`. Subagent turns and interrupted turns are skipped. |
| `ui.render` on `AbovePrompt` | The last result, green or red, with the first failing test's name. |
| `ui.render` on `Pane` | Details: the last 30 lines of output, with Re-run. |
| `/tests` | Runs the suite now, even while Claude is working. |

A toast fires when the suite goes from green to red and when it recovers.

## Which command runs

| Found in the working directory | Command |
| --- | --- |
| `package.json` with a `test` script, and `bun.lock` | `bun run test` |
| … and `pnpm-lock.yaml` / `yarn.lock` / neither | `pnpm test` / `yarn test` / `npm test --silent` |
| `bun.lock` without a test script | `bun test` |
| `pytest.ini`, `conftest.py`, `pyproject.toml` or `tests/` | `pytest -q`, or `uv run pytest -q` with a `uv.lock` |
| `Cargo.toml` | `cargo test --quiet` |
| `go.mod` | `go test ./...` |
| `mix.exs`, `Gemfile` | `mix test`, `bundle exec rspec` |

Set `command` to override detection. Counts are parsed for bun, jest/vitest, pytest, cargo, go, rspec and ExUnit; for anything else the band shows pass or fail from the exit code.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `command` | `` (detect) | The command to run, split on spaces. |
| `timeoutSeconds` | `120` | How long to wait before giving up on a run. |
| `extensions` | `ts,tsx,js,jsx,mjs,py,rs,go,rb,java,kt,swift,c,cc,cpp,h,hpp,cs,ex,exs` | Which file edits count as source changes. |

The suite runs inside the `turn.complete` hook through `$.process.run`, so a slow suite delays the end-of-turn line but not Claude's answer, and the time it takes does not count against the hook's budget.

## Install

```bash
claude plugin marketplace add ryx2/slopshopper
claude plugin install test-pulse@slopshopper
```

Tested with Claude Code 2.1.289. `claude plugin validate` and `claude plugin test` pass.
