# Guardrail Hooks: a case study

**The bet:** code whose whole job is catching an agent's mistakes deserves the most adversarial review in the repo, because a bug in a guardrail does not just fail, it fails while telling you everything is fine. So before these four hooks went public I put them through three rounds of independent review, and the pack that was "done" turned out to be carrying two HIGH severity bugs.

## The problem

These hooks had been running on my own machine for months, which felt like proof they worked, but running is not the same as reviewed. The first adversarial pass found the irony immediately: the secret scanner missed a real hardcoded key when it sat in the classic fallback position (`process.env.X || "sk-realkey..."`), because the line-scoped filter that was supposed to skip env-var references threw away the whole line, key included. And the config-protection hook, which exists to stop an agent from weakening a lint config, could be bypassed by case-swapping the filename: writing to `.ESLintRC.js` hit the same file on a case-insensitive filesystem (macOS, Windows) but sailed past the case-sensitive blocklist. A pack built to catch mistakes was about to ship with exactly the mistakes it was built to catch. Packaged is not reviewed.

## The decisions that mattered most

- **Verify every finding against the code before acting on it.** The review ran 3 rounds with 5 independent looks: two fresh subagents with neutral briefs, a GPT-class reviewer (Codex) twice, and a second-vendor Gemini-class model once. Every finding, all of them, got an empirical repro against the actual code before I touched anything, and that discipline paid twice: it separated the roughly fifteen real defects (2 HIGH, the rest medium and low) from a handful of confidently asserted non-issues (path traversal, ReDoS, command injection all checked out clean), and it caught one reviewer's proposed fix that was itself wrong. A reviewer's verdict is a lead, not a patch. The test suite grew 21 to 53 along the way, one non-vacuous regression lock per fix.

- **Buy one look from a different vendor.** The single best catch of the whole exercise came from the second-vendor model on round 3, after two subagents and two GPT-class passes had all signed off: an uninitialized-memory read in the transcript tail reader, which ignored the actual bytes read and decoded the whole unsafely-allocated buffer, so a transcript shrinking mid-read would leak whatever memory happened to be there. Four looks from the same vendor family missed it because they share blind spots; same-vendor redundancy is not independence. One cross-vendor pass found in minutes what four same-vendor passes had all missed.

- **Know when the fixing stops.** Round 3 ended not with an empty findings list but with a deliberate DOCUMENTED-not-fixed list: a generic (unprefixed) secret in fallback position, a symlink alias around config-protection, the Bash heredoc bypass of both write-scoped hooks, and captured subagent output that is never secret-scanned. Each one is real, each one is disclosed in plain words in the README, and none of them got fixed, because these hooks are friction-raisers against an agent's honest mistakes, not a sandbox against an adversary trying to defeat them. Closing those holes would mean building a Bash command parser and a filesystem-identity resolver inside a hook, which adds more new failure surface than it removes. Matching rigor to the threat model is the decision; endless hardening is just the absence of one.

## What I deliberately left out

Everything on that documented list, plus the temptation to broaden the generic-secret pattern until it caught the fallback case, since prefixed keys (the ones that identify a real provider) are already caught there and widening the generic net just trades one missed pattern for a stream of false positives that would train users to ignore the hook. A guardrail people mute is worse than a narrower one they trust.

## What I'd do next

The honest next step is watching how the hooks behave on other people's setups, because every threshold in them (the pause-guard phrase list, the config blocklist, the scan patterns) was tuned on one person's usage. And the review method itself is the reusable part: verify before fixing, buy at least one cross-vendor look, and write down where you chose to stop.

---

*Built by [Akshey Walia](https://www.linkedin.com/in/aksheywalia/). The project: [claude-code-guardrail-hooks](https://github.com/aksheyw/claude-code-guardrail-hooks) · companion: [claude-code-ship-gate](https://github.com/aksheyw/claude-code-ship-gate).*
