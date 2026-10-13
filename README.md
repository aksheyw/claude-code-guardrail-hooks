<div align="center">

# 🔧 Claude Code Guardrail Hooks: catch the mistake at the tool call

### Four small scripts, instead of a rule asking the model to behave. Two block a bad move before it lands. Two flag or save what a block does not cover.

![requires](https://img.shields.io/badge/requires-Claude%20Code-D97757) ![hooks](https://img.shields.io/badge/hooks-4-0E9384) ![tests](https://img.shields.io/badge/tests-53%20passing-1B2A4A) ![license](https://img.shields.io/badge/license-MIT-green)

</div>

---

Claude Code is Anthropic's AI coding assistant: it runs in your terminal, reads your project's files, and can change them. A **hook** is a small script it runs automatically at a fixed moment, so it can block or catch an action.

These are the four hooks I run on every project. A rule in your `CLAUDE.md`, the instructions file the model reads, is one it can drift from; a hook fires on every matching tool call, every time.

<img src="docs/where-each-hook-fires.svg" width="100%"
     alt="Where each hook fires. Before a tool call, two PreToolUse hooks can block it: pause-guard, on every tool, stops all tool calls when you ask it to rethink its reasoning effort or tell it to stop; config-protection, on file writes, blocks editing an existing lint or format config to dodge a failing check. Then the tool call runs. After it, two PostToolUse hooks can only observe, not undo: secret-scan, after a write, flags a hardcoded secret in the file just written, reporting the line number and a label but never the secret itself; capture, after a subagent the main assistant waited for, saves its output to a file so it survives the chat being compacted.">

## What each hook does

A hook fires either just **before** a **tool call** (the model about to write a file or run a command), where a **PreToolUse** hook can block it, or just **after**, where a **PostToolUse** hook can only react. Two of these fire before, two after.

| Hook | When it fires | What it does |
|------|---------------|--------------|
| [`pause-guard.js`](hooks/pause-guard.js) | before every tool call | Blocks all tool calls when your latest message asks it to reconsider its reasoning effort ("is medium good enough?", "bump you to high?"), or is a bare halt ("stop", "wait", "hold on"). Forces a text-only reply so you decide before it keeps working. |
| [`config-protection.js`](hooks/config-protection.js) | before a file write | Blocks edits to an existing linter/formatter config (`.eslintrc*`, `prettier.config.js`, `biome.json`, `ruff.toml`, and the rest). Stops the common reflex of weakening the config to make a check pass instead of fixing the code. Still lets you create one that doesn't exist yet, so scaffolding a fresh repo works. |
| [`secret-scan-postwrite.sh`](hooks/secret-scan-postwrite.sh) | after a file write | Scans the just-written file for hardcoded secrets (OpenAI, Anthropic and OpenRouter keys, AWS keys, GitHub tokens, Google API keys, private-key blocks, JWTs, Telegram tokens, and generic `secret=`/`password=` assignments) and reports the line number and a label so you can pull the key before you commit. It flags the write, it does not block it, and the matched secret text is discarded, never echoed back. |
| [`capture-subagent-output.js`](hooks/capture-subagent-output.js) | after a subagent runs | Saves each substantial output (800 characters or more) from a **subagent** (a separate assistant the main one spins up for a sub-task) to a dated file under `~/.claude/agent-outputs/`, so its research and verdicts don't get lost when the conversation is trimmed to save space. It catches a subagent the main assistant waits for. A subagent sent to run in the background delivers its report later, after this hook has run, so the hook never sees it. For those, say in the subagent's instructions that it must save its own report to a file. |

## Why these four

Every one of these fixes a failure I hit more than once:

- **pause-guard** exists because I'd ask "is medium good enough for this?" and the agent would answer *and keep working in the same turn*, which was the one moment I actually needed it to stop and let me set the level first.
- **config-protection** exists because an agent chasing a green lint run will, left alone, edit `.eslintrc.js` instead of the code that's actually wrong.
- **secret-scan-postwrite** exists because a hardcoded key written mid-session is easy to miss in a large change, and a `.gitignore` entry doesn't help once the key has already landed in a tracked file.
- **capture-subagent-output** exists because subagent output is the single biggest thing that gets lost. It arrives, gets summarised into a shorter reply, and the raw text is gone by the time the session ends.

How each of these was reviewed and hardened before I first published it is written up in [CASE-STUDY.md](CASE-STUDY.md).

## What these are NOT

These are guardrails against an agent's own mistakes under normal operation, not a sandbox, and not a defense against adversarial prompt injection actively trying to evade them. Treat them as one useful layer, not the whole defense.

<details>
<summary><b>🔍 The known, deliberate limitations, in detail</b></summary>

- **Write-scoped, so Bash bypasses them.** `config-protection` and `secret-scan-postwrite` only fire on the `Write`/`Edit`/`MultiEdit` tools. A file created via a shell heredoc or `echo` redirect bypasses both; so does deleting a config with `rm` (Bash) and then `Write`-ing a weaker one, since config-protection is stateless and reads that as a new file. Closing this would need a separate PreToolUse Bash-command scanner, which is out of scope here.
- **config-protection matches by basename, and doesn't resolve symlinks.** It also only blocks writes to a *known config name*: it won't stop an edit to `.eslintrc.js` made through a differently-named symlink (`alias.js -> .eslintrc.js`), nor stop adding a *new* competing config type (e.g. creating `eslint.config.js` when `.eslintrc.js` already exists). It's a friction-raiser against the common "just weaken the config" reflex, not an airtight lock.
- **A generic secret in fallback position is missed.** The generic `secret=`/`password=` pattern stops at the first `.`, so a literal used as an env fallback (`const pw = process.env.PW || "literalsecret"`) slips past it. Prefixed provider keys (`sk-`, `ghp_`, and the rest) ARE still caught in that position, so this only affects unprefixed generic values. Broadening the generic pattern to match anywhere after the keyword would catch it, at the cost of enough false positives that you would start ignoring the hook, so it deliberately stays narrow.
- **secret-scan skips a few `.claude/` subdirs unconditionally.** It full-file-skips `.claude/rules/`, `.claude/scripts/`, `.claude/skills/`, and `.claude/commands/` so example secret patterns in those files don't self-flag, which also means a *real* secret hardcoded inside one of those paths is never flagged. It's a content-blind skip, not a "unless it looks real" one. (Other `.claude/` files, e.g. `settings.json`, are still scanned.)
- **Captured subagent output is NOT secret-scanned.** `capture-subagent-output.js` writes via `fs.writeFileSync` from a `Task`/`Agent` hook, a path that never goes through a `Write` tool, so `secret-scan-postwrite.sh` never sees it. A subagent report that legitimately quotes a secret it found gets persisted verbatim under `~/.claude/agent-outputs/`. **Treat `~/.claude/agent-outputs/` as sensitive: keep it out of any repo or backup that isn't itself scanned, and never commit a real captured file** (its header also embeds your local `cwd`/username).

</details>

## Install

You need [Claude Code](https://claude.com/claude-code) itself first. `~/.claude/` is the folder it keeps its own settings in. The hooks are plain scripts: copy them somewhere stable and wire them into your settings.

```bash
git clone https://github.com/aksheyw/claude-code-guardrail-hooks.git
mkdir -p ~/.claude/scripts/hooks
cp claude-code-guardrail-hooks/hooks/*.js claude-code-guardrail-hooks/hooks/*.sh ~/.claude/scripts/hooks/
```

Then add the hook entries to `~/.claude/settings.json` (or a project's `.claude/settings.json`). Each entry names the event, a `matcher` for which tools it fires on, and the command to run:

```json
{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"/absolute/path/to/hooks/pause-guard.js\"" }] }
```

The full four-hook block is in [`examples/settings-snippet.json`](examples/settings-snippet.json); merge its `hooks` block into your existing config rather than overwriting it. **Claude Code hook `command` fields need absolute paths** (no `~` expansion), so swap `/absolute/path/to/hooks/...` for wherever you actually copied the files. The `.js` hooks need Node; `secret-scan-postwrite.sh` needs `bash` and `jq`.

Take only the hooks you want: they're fully independent, with no dependency between them.

<details>
<summary><b>📋 Check it worked, and how to confirm one is live</b></summary>

```bash
cd claude-code-guardrail-hooks
node tests/run-tests.js
```

Should print `TOTAL: 53 passed, 0 failed`. This runs the hooks in the cloned **repo** directly (unit tests for `pause-guard.js` / `config-protection.js`, which export testable functions; integration tests that pipe real JSON payloads at `capture-subagent-output.js` and `secret-scan-postwrite.sh`, which don't). It confirms the code is sound, not that you've wired the copies in `~/.claude/scripts/hooks/` into `settings.json`.

To confirm a hook is actually wired into a live session: start a fresh Claude Code session, ask something like *"is medium reasoning effort good enough for this task?"*, and the agent should stop and answer in text only, with no tool calls, until you set a level.

</details>

<details>
<summary><b>📄 Design principles, worth reading before you wire these in</b></summary>

- **Fail open vs. fail closed is a deliberate per-hook choice, not an accident.** `pause-guard` fails OPEN on any internal error, because it's a nudge, not a security boundary, and a fail-closed bug there would wedge every tool call of every session. `config-protection` fails CLOSED on a truncated payload: better to over-block a config edit than silently let one through. Read the header comment in each file before changing its error handling.
- **Never echo the matched SECRET VALUE.** `secret-scan-postwrite.sh` reports only a line number and a pattern label ("openrouter-key", "aws-access-key"), and the matched secret text is discarded and never echoed back into the agent's context or the session transcript. (The one thing it does print verbatim is the file's basename, so don't put a secret in a filename.)
- **Kill switches where they matter.** `pause-guard` (which fires on every tool call) and `capture` (which fires on every subagent call) each have an environment-variable escape hatch (`PAUSE_GUARD_DISABLED=1` and `CAPTURE_HOOK_DISABLED=1`) so a false positive never becomes a recurring annoyance. The two `Write`-scoped hooks (config-protection, secret-scan) are disabled by removing their entry from `settings.json`; they only fire on file writes, so there's no recurring-annoyance case to guard against.
- **Self-exclusion.** The secret scanner skips its own hook/rule/skill directories, because otherwise a file documenting *what a secret pattern looks like* would flag itself every time.

</details>

<details>
<summary><b>📦 Tunables (environment variables)</b></summary>

| Hook | Env var | Default | Purpose |
|------|---------|---------|---------|
| pause-guard | `PAUSE_GUARD_DISABLED` | unset | Set `1` to disable entirely |
| pause-guard | `PAUSE_GUARD_EFFORT_MAXLEN` | 1000 | Max message length considered for the effort-decision gate |
| pause-guard | `PAUSE_GUARD_HARD_MAXLEN` | 280 | Max message length considered for the hard-pause gate |
| pause-guard | `PAUSE_GUARD_TAIL_BYTES` | 1048576 | How much of the transcript tail to read per call |
| pause-guard | `PAUSE_GUARD_SKIP_ENTRYPOINTS` | unset | Comma-list of entrypoints to never block (e.g. a headless/print mode) |
| capture-subagent-output | `CAPTURE_HOOK_DISABLED` | unset | Set `1` to disable entirely |

</details>

## Companion repos

Part of my Claude Code config series:

- [`claude-code-rules`](https://github.com/aksheyw/claude-code-rules): the standing instructions these hooks enforce, including the pause-and-effort discipline `pause-guard` backstops
- [`claude-code-deep-review`](https://github.com/aksheyw/claude-code-deep-review): a 14-lens iterative review skill
- [`claude-code-pm-agents`](https://github.com/aksheyw/claude-code-pm-agents): 7 product-builder subagents, plus a 9-seat review council
- [`claude-code-learned-skills`](https://github.com/aksheyw/claude-code-learned-skills): 12 skills taken from real debugging and research sessions
- [`career-command-center-template`](https://github.com/aksheyw/career-command-center-template): a full plugin template for an AI-native job search

## License

MIT (see [LICENSE](LICENSE)).

---

Built by [Akshey Walia](https://github.com/aksheyw). If one of these misfires on a case I didn't hit, open an issue.
