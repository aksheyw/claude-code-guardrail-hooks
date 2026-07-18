# Claude Code Guardrail Hooks

> **Four small, self-contained hooks that stop an agent from doing the wrong thing at the exact moment it's about to do it — not by asking nicely in a rule file, but by actually blocking or capturing the tool call.**

Rules in `CLAUDE.md` or a global rules file are instructions. An agent under context pressure can drift away from them mid-session. A hook runs on every matching tool call, every time, regardless of what's in context. These four are the ones I've found earn their keep enough to run on every project, every session.

## What's in this repo

| Hook | Event | What it does |
|------|-------|---------------|
| [`pause-guard.js`](hooks/pause-guard.js) | PreToolUse (`*`) | Blocks every tool call when the user's latest message is asking the agent to reconsider its reasoning effort ("is medium good enough?", "bump you to high?"), or is a bare halt ("stop", "wait", "hold on"). Forces a text-only reply so the human decides before the agent keeps working. |
| [`config-protection.js`](hooks/config-protection.js) | PreToolUse (`Write\|Edit\|MultiEdit`) | Blocks edits to existing linter/formatter config files (`.eslintrc*`, `prettier.config.js`, `biome.json`, `ruff.toml`, etc.). Stops the common failure mode of an agent weakening the lint config to make a check pass instead of fixing the code. Allows first-time creation of a config in a project that has none. |
| [`secret-scan-postwrite.sh`](hooks/secret-scan-postwrite.sh) | PostToolUse (`Write\|Edit\|MultiEdit`) | Scans a just-written file for hardcoded secrets (OpenAI/Anthropic/OpenRouter keys, AWS keys, GitHub tokens, Google API keys, private key blocks, JWTs, Telegram bot tokens, generic `secret=`/`password=` assignments) and surfaces the line number + pattern label back to the agent — never the secret value itself. |
| [`capture-subagent-output.js`](hooks/capture-subagent-output.js) | PostToolUse (`Task\|Agent`) | Auto-saves every substantial subagent/sub-task output to a dated file under `~/.claude/agent-outputs/`, so research and verdicts a subagent produced don't get lost the moment the conversation compacts. |

## Why these four

Every one of these fixes a failure I hit more than once:

- **pause-guard** exists because I'd ask "is medium good enough for this?" and the agent would answer *and keep working in the same turn* — the one moment I actually needed it to stop and let me set the level first.
- **config-protection** exists because an agent chasing a green lint run will, left unsupervised, edit `.eslintrc.js` instead of the code that's actually wrong.
- **secret-scan-postwrite** exists because a hardcoded key written mid-session is easy to miss in a large diff, and a `.gitignore` entry doesn't help if the key already landed in a tracked file.
- **capture-subagent-output** exists because subagent output is the single biggest thing that gets lost — it arrives, gets summarized into a shorter reply, and the raw text is gone by the time the session ends.

## Design principles (worth reading before you wire these in)

- **Fail open vs. fail closed is a deliberate per-hook choice, not an accident.** `pause-guard` fails OPEN on any internal error — it's a nudge, not a security boundary, and a fail-closed bug there would wedge every tool call of every session. `config-protection` fails CLOSED on a truncated payload — better to over-block a config edit than silently let one through. Read the header comment in each file before changing its error handling.
- **Never block on the SECRET VALUE itself.** `secret-scan-postwrite.sh` reports only a line number and a pattern label ("openrouter-key", "aws-access-key") — the actual matched text never gets echoed back into the agent's context or the session transcript.
- **Kill switches, always.** Every hook here has an environment-variable escape hatch (`PAUSE_GUARD_DISABLED=1`, `CAPTURE_HOOK_DISABLED=1`) so a false positive never becomes a session-long annoyance.
- **Self-exclusion.** The secret scanner skips its own hook/rule/skill directories — otherwise a file documenting *what a secret pattern looks like* would flag itself every time.

## Install

Hooks are plain scripts — there's no plugin manifest here, just copy them somewhere stable and wire them into your `settings.json`.

```bash
git clone https://github.com/aksheyw/claude-code-guardrail-hooks.git
mkdir -p ~/.claude/scripts/hooks
cp claude-code-guardrail-hooks/hooks/*.js claude-code-guardrail-hooks/hooks/*.sh ~/.claude/scripts/hooks/
```

Then add the hook entries to `~/.claude/settings.json` (or a project's `.claude/settings.json`). See [`examples/settings-snippet.json`](examples/settings-snippet.json) for the exact shape — merge its `hooks` block into your existing config rather than overwriting it. **Claude Code hook `command` fields need absolute paths** (no `~` expansion), so swap `/absolute/path/to/hooks/...` for wherever you actually copied the files.

Take only the hooks you want — they're fully independent; there's no dependency between them.

## Verify install worked

```bash
node tests/run-tests.js
```

Should print `TOTAL: 21 passed, 0 failed`. This runs the hooks directly (unit tests for `pause-guard.js` / `config-protection.js`, which export testable functions; integration tests that pipe real JSON payloads at `capture-subagent-output.js` and `secret-scan-postwrite.sh`, which don't).

To confirm a hook is actually wired into a live session: start a fresh Claude Code session, ask something like *"is medium reasoning effort good enough for this task?"*, and the agent should stop and answer in text only, with no tool calls, until you set a level.

## Tunables

| Hook | Env var | Default | Purpose |
|------|---------|---------|---------|
| pause-guard | `PAUSE_GUARD_DISABLED` | unset | Set `1` to disable entirely |
| pause-guard | `PAUSE_GUARD_EFFORT_MAXLEN` | 1000 | Max message length considered for the effort-decision gate |
| pause-guard | `PAUSE_GUARD_HARD_MAXLEN` | 280 | Max message length considered for the hard-pause gate |
| pause-guard | `PAUSE_GUARD_TAIL_BYTES` | 1048576 | How much of the transcript tail to read per call |
| pause-guard | `PAUSE_GUARD_SKIP_ENTRYPOINTS` | unset | Comma-list of entrypoints to never block (e.g. a headless/print mode) |
| capture-subagent-output | `CAPTURE_HOOK_DISABLED` | unset | Set `1` to disable entirely |

## What these are NOT

These are guardrails against an agent's own mistakes under normal operation — not a sandbox and not a defense against an adversarial prompt injection trying to actively evade them. `config-protection` and `secret-scan-postwrite` only fire on the `Write`/`Edit`/`MultiEdit` tools; a file created via a shell heredoc or `echo` redirect bypasses both (a separate PreToolUse Bash-command scanner would be needed to close that gap — out of scope here). Treat these as one useful layer, not the whole defense.

## License

MIT — see [LICENSE](LICENSE).
