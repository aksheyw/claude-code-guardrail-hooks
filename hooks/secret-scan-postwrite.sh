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

# Fail loud, not silent, if jq is missing — a security control must not no-op quietly.
if ! command -v jq >/dev/null 2>&1; then
  printf '{"systemMessage":"secret-scan hook skipped: jq not found (install jq to enable)"}\n'
  exit 0
fi

HITS=""
# Surface only the LINE NUMBER and the matched PATTERN LABEL — never the secret text itself,
# so the secret is not echoed into the model context / transcript / session-data.
add(){ HITS="${HITS}  [$1] line $2 (value redacted)\n"; }

scan(){
  local label="$1" pat="$2"
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    local ln="${m%%:*}"
    add "$label" "$ln"
  # Exclude env-var REFERENCES (the correct pattern) so we flag hardcoded values, not usage.
  done < <(grep -niEI -e "$pat" "$FILE" 2>/dev/null \
            | grep -vE 'process\.env|import\.meta\.env|os\.(getenv|environ)|Deno\.env|ENV\[|\$\{?[A-Za-z_]' \
            | head -3)
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
# quoted assignment OR bare .env-style assignment (KEY=longvalue, no quotes required)
scan "generic-secret"  '(secret|api[_-]?key|password|access[_-]?token)[[:space:]]*[:=][[:space:]]*["'"'"'`]?[A-Za-z0-9_+/=-]{16,}'

if [ -n "$HITS" ]; then
  MSG="⚠️ SECRET SCAN: possible hardcoded secret(s) in $(basename "$FILE"). Move to an env var BEFORE any commit/push (see ~/.claude/rules/security.md). If this is a false positive (placeholder/example), note it explicitly:\n\n${HITS}"
  jq -cn --arg ctx "$MSG" '{systemMessage:"⚠️ Possible secret written — see agent context",hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
fi
exit 0
