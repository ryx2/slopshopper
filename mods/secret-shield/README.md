# secret-shield

Keeps secrets out of the transcript and out of the repo.

```text
 ⛨ secret-shield  2 redacted  1 refused  latest: stripe-key in a Bash result   h: Hide
```

| Hook | What it does |
| --- | --- |
| `tool.call` on `Write` and `Edit` | Refuses new text that contains a high-confidence secret, and tells Claude to read it from the environment instead. |
| `tool.call` on `Bash` | Refuses a command line that embeds one, because commands are stored in the transcript as typed. `$VAR` references pass. |
| `session.append` for tool results | Replaces secrets in a tool's result with `[redacted <kind> by secret-shield]` before Claude reads it and before the transcript file stores it. A `cat .env` still shows every variable name. |
| `ui.render` on `AbovePrompt` | Counts what was redacted and refused. `/secrets` prints the tally. |

## What it recognizes

| Kind | Refuses writes | Example |
| --- | :-: | --- |
| `anthropic-key` | yes | `sk-ant-…` |
| `openai-key` | yes | `sk-…`, `sk-proj-…` |
| `github-token` | yes | `ghp_…`, `github_pat_…` |
| `aws-access-key` | yes | `AKIA…` |
| `slack-token` | yes | `xoxb-…` |
| `stripe-key` | yes | `sk_live_…`, `rk_test_…` |
| `google-api-key` | yes | `AIza…` |
| `private-key` | yes | `-----BEGIN PRIVATE KEY-----` blocks |
| `password-url` | yes | `postgres://user:password@host` (only the password is redacted) |
| `jwt`, `bearer-token`, `env-secret`, `assignment` | redact only | `eyJ….eyJ….…`, `Bearer …`, `FOO_SECRET=…`, `api_key: "…"` |

The lower-confidence kinds only redact results; they never refuse a write, so a test fixture with a fake token still lands.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `blockWrites` | `true` | Refuse writes and commands that embed a high-confidence secret. |
| `redactResults` | `true` | Redact tool results. |

## What it does not do

It does not read your prompt: if you paste a secret, Claude still sees it. It does not scan files Claude reads with the `Read` tool's own structured output beyond the text blocks a result carries. Patterns are patterns: a long random string that happens to match is redacted, and an unusual key format is not. Rotate any secret that reached a transcript.

## Install

```bash
claude plugin marketplace add ryx2/slopshopper
claude plugin install secret-shield@slopshopper
```

Tested with Claude Code 2.1.289. `claude plugin validate` and `claude plugin test` pass.
