#!/bin/bash
# PostToolUse hook: scan a just-written/edited file for hardcoded secrets using the
# patterns from ~/.claude/rules/security.md. Surfaces matches back to the agent via
# additionalContext so it removes the secret BEFORE it reaches a commit/push.
#
# Non-blocking (the write already happened); always exits 0. Silent when no match.
# LIMITATION (by design): only fires on Write/Edit/MultiEdit. Files created via Bash
# (echo/heredoc/cat) are NOT scanned here — the ship-gate push hook + opt-in insaits
# PreToolUse monitor are the backstops for that path.
# Deliberately conservative to avoid false-positive fatigue: skips its own rule/hook
# files (which contain these patterns as examples) and non-text/large files.

INPUT=$(cat)

# Fail loud, not silent, if jq is missing — a security control must not no-op
# quietly. This check MUST come before the first jq use below: otherwise jq at the
# FILE= line produces an empty FILE and the script exits 0 before ever reaching a
# "jq not found" message, silently disabling the scan. Emit BOTH systemMessage (for
# a human watching the UI) and hookSpecificOutput.additionalContext (so an
# unattended/headless agent is told in-context the scanner is off).
if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' '{"systemMessage":"secret-scan hook skipped: jq not found (install jq to enable)","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"⚠️ secret-scan hook is DISABLED: jq is not installed, so written files are not being scanned for hardcoded secrets. Install jq to re-enable."}}'
  exit 0
fi

FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[ -z "$FILE" ] && exit 0
[ -f "$FILE" ] || exit 0

# Skip files that legitimately CONTAIN secret patterns as documentation/regex,
# and anything under the claude config (rules, hooks, skills) to avoid self-flagging.
case "$FILE" in
  */.claude/rules/*|*/.claude/scripts/*|*/.claude/skills/*|*/.claude/commands/*) exit 0 ;;
  *.lock|*.min.js|*.map|*.svg|*.png|*.jpg|*.jpeg|*.gif|*.pdf|*.woff*|*.ttf) exit 0 ;;
esac

# Skip very large files (>512KB) to stay fast
SIZE=$(wc -c < "$FILE" 2>/dev/null || echo 0)
[ "$SIZE" -gt 524288 ] && exit 0

HITS=""
# Surface only the LINE NUMBER and the matched PATTERN LABEL — never the secret text itself,
# so the secret is not echoed into the model context / transcript / session-data.
add(){ HITS="${HITS}  [$1] line $2 (value redacted)\n"; }

# scan LABEL PATTERN
# The `--` before "$FILE" stops a filename beginning with `-` being read as a grep
# option. The while loop stays in the CURRENT shell (process substitution, not a
# pipe) so `add` actually mutates HITS.
#
# NOTE — no env-reference exclusion. An earlier version filtered out lines
# containing `process.env` / `import.meta.env` / `ENV[...]` etc. to avoid flagging
# legitimate env usage. That was line-scoped, so it HID a real hardcoded key that
# shared a line with an env reference — the classic fallback leak
#   const k = process.env.X || "sk-realkey..."
# The filter is also unnecessary: every real env-reference syntax contains a `.`,
# `[`, `{` or `(` that breaks the value character class below, so none of these
# patterns match legitimate env usage in the first place. Dropping the filter is
# both simpler and strictly safer (no false negatives from an adjacent env ref).
scan(){
  local label="$1" pat="$2"
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    local ln="${m%%:*}"
    add "$label" "$ln"
  done < <(grep -niEI -e "$pat" -- "$FILE" 2>/dev/null | head -3)
}

# scanCS LABEL PATTERN: the same as scan() but case-SENSITIVE. An identity number is
# defined partly by its case (a PAN is upper case), and folding case is what makes the
# pattern match ordinary hashes and lowercase identifiers.
scanCS(){
  local label="$1" pat="$2"
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    local ln="${m%%:*}"
    add "$label" "$ln"
  done < <(grep -nEI -e "$pat" -- "$FILE" 2>/dev/null | head -3)
}

scan "openrouter-key"  'sk-or-v1-[A-Za-z0-9]{20,}'
scan "anthropic-key"   'sk-ant-[A-Za-z0-9-]{20,}'
scan "openai-key"      'sk-[A-Za-z0-9]{30,}'
scan "aws-access-key"  'AKIA[0-9A-Z]{16}'
scan "github-token"    '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'
scan "google-api-key"  'AIza[0-9A-Za-z_-]{30,}'
scan "private-key"     '-----BEGIN [A-Z ]*PRIVATE KEY-----'
scan "jwt"             'eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]{20,}'
scan "telegram-token"  '[0-9]{8,12}:[A-Za-z0-9_-]{35,}'
# GENERIC assignment (KEY="longvalue"). Best-effort and low-confidence by design:
# the value char class stops at the first `.`/`[`/`{`/`(`, so a generic literal
# used only as an env FALLBACK (password = process.env.X || "literal") is not
# caught — the high-confidence prefixed patterns above are what catch real keys in
# fallback position.
scan "generic-secret"  '(secret|api[_-]?key|password|access[_-]?token)[[:space:]]*[:=][[:space:]]*["'"'"'`]?[A-Za-z0-9_+/=-]{16,}'

# IDENTITY NUMBERS. The key patterns above match key SHAPES and do not match a tax ID or a
# bank code, which is how one can reach a commit with a scanner already running.
# These patterns are for Indian identifiers; adapt them to your country's.
# The 12-digit rule is KEYWORD-GATED on purpose: a bare 12-digit match fires on order
# numbers, timestamps and quantities far more often than on a real ID.
# NOTE the class is [^0-9] and NOT [^0-9\n]. In a POSIX bracket expression a backslash
# is literal, so on BSD grep (macOS) [^0-9\n] excludes the LETTER n, and a line like
# "PRAN number: <12 digits>" becomes a silent miss.
scanCS "indian-pan"    '\b[A-Z]{5}[0-9]{4}[A-Z]\b'
scanCS "ifsc"          '\b[A-Z]{4}0[A-Z0-9]{6}\b'
scan   "id-12-digit"   '\b(pran|aadhaar|uan|folio|demat)\b[^0-9]{0,40}\b[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}\b'

if [ -n "$HITS" ]; then
  MSG="⚠️ SECRET SCAN: possible hardcoded secret(s) in $(basename -- "$FILE"). Move to an env var BEFORE any commit/push (see ~/.claude/rules/security.md). If this is a false positive (placeholder/example), note it explicitly:\n\n${HITS}"
  jq -cn --arg ctx "$MSG" '{systemMessage:"⚠️ Possible secret written — see agent context",hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
fi
exit 0
