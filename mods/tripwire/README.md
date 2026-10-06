# tripwire

Holds destructive commands until you say so.

```text
 ⏺ Bash(git push --force origin main)
   tripwire · force-push: rewrites a protected branch for everyone

   git push --force origin main

   Run this command?
   ❯ 1. Run it
     2. Refuse
```

The question opens in Claude's own dialog and the tool call waits for it. Nothing runs until you answer; the time you take does not count against the hook's budget, because the wait happens inside `$.ui.ask`.

| What trips it | Rule | Then |
| --- | --- | --- |
| `rm -r` of `/`, `~`, `..`, a glob, a system path, or anything outside the working directory; `rm -r` inside it (see `askForRm`) | `rm` | asks |
| `git push --force` / `-f` (never `--force-with-lease`) | `force-push` | asks; names the branch when it is protected |
| `git push --delete <protected>`, `git branch -D <protected>` | `branch-delete` | **refuses**, never asks |
| `git reset --hard`, `git checkout -- .`, `git restore .`, `git clean -f`, `git stash drop`, `git filter-branch`, `git reflog expire`, `git gc --prune=now` | `reset-hard`, `discard`, `clean`, `stash`, `rewrite`, `reflog`, `gc` | asks |
| `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, a bare `DELETE FROM t` | `sql` | asks |
| `curl … \| sh`, `wget … \| bash` | `pipe-to-shell` | asks |
| `sudo …` (see `allowSudo`) | `sudo` | asks |
| `chmod -R`/`chown -R` on `/`, `~` or to `777` | `permissions` | asks |
| `kill -9 -1`, `killall`, `pkill -f` | `kill` | asks |
| `docker system prune`, `volume rm`, `terraform destroy`, `npm publish`, `gh repo delete`, `rsync --delete`, `find -delete`, `crontab -r`, `history -c` | various | asks |
| `mkfs`, `fdisk`, `dd of=/dev/…`, `> /dev/sd…` | `disk` | **refuses** |
| `Write` or `Edit` to `.env`, `.env.local`, … | `env-file` | asks |

When Claude is refused it reads a deny message that tells it not to retry or work around the command, and to ask you instead.

**Fail-closed.** If the guard itself throws or times out, the `.catch` handler answers with a refusal, so a broken guard never lets a command through. In `claude -p`, where nobody can answer, every held command is refused.

`/tripwire` prints the session's decisions: what tripped, which rule, and whether it ran, was refused, or was denied.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `protectedBranches` | `main,master,production,release` | Force pushes to these are questioned by name; deleting one is refused. |
| `askForRm` | `true` | Also hold a recursive `rm` of a path inside the working directory. |
| `allowSudo` | `false` | Let `sudo` through without asking. |

## Install

```bash
claude plugin marketplace add ryx2/slopshopper
claude plugin install tripwire@slopshopper
```

Tested with Claude Code 2.1.289. `claude plugin validate` and `claude plugin test` pass. The command matching is text matching: an obfuscated command (`r''m -rf`) passes. Protect what matters on the server side too.
