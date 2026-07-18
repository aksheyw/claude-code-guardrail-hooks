#!/usr/bin/env node
/**
 * Pause Guard Hook (PreToolUse, matcher "*")
 *
 * PURPOSE — primary: the EFFORT-DECISION gap.
 *   The repeatedly-failing moment is: the user asks me to reevaluate my reasoning
 *   effort ("is medium good enough?", "should I bump you to high?", "is this too
 *   low for this task?") and I answer AND keep working in the same turn — instead
 *   of stopping so they can set the right level first. Wrong level is expensive
 *   both ways: mundane work at high effort burns tokens; complex work at low
 *   effort misses edge cases. So when the user opens an effort-decision, this hook
 *   BLOCKS every tool call (exit 2) — my only legal move is a text answer, then
 *   stop until they set the level and give a new go-ahead.
 *
 * PURPOSE — secondary: a SLIM hard-pause backup.
 *   A tiny, high-precision set of halt interjections — pause / wait / stop /
 *   hold on — for the general "I said stop and you kept going" case. Deliberately
 *   NOT a broad pause net: the fuzzy patterns (let-me-check, compound clauses,
 *   "not yet", effort-as-a-noun) caused false blocks and were dropped.
 *
 * Because the hook keys off the LATEST typed user message, a later "go ahead" /
 * "stay on medium" becomes the newest message and naturally unblocks.
 *
 * DESIGN DECISIONS
 *   - FAIL OPEN. Any error => exit 0 (allow). This is a nudge-enforcer, NOT a
 *     security boundary; a fail-closed bug would wedge every tool call of every
 *     session. Opposite of check-push.sh, on purpose.
 *   - LATEST REAL TYPED MESSAGE. Walk the transcript backward; skip tool_result
 *     echoes AND isMeta entries (slash-command expansions / system injections are
 *     stored as type:"user" isMeta:true — they are NOT what the user typed).
 *   - TAIL-READ. Read only the last 1 MB of the transcript, not the whole file —
 *     long sessions reach many MB and this runs on every tool call.
 *   - TWO GATES. Effort questions are reasoned (longer) => generous ceiling
 *     (1000). Hard-pause interjections are short commands => tight ceiling (280).
 *   - PRECISION OVER RECALL. A missed pause = one reminder; a false block self-
 *     heals on the next message. Effort triggers require a model-effort context
 *     (a level word / "your effort" / "reasoning effort"), never bare "effort",
 *     so "the effort tracker" / "change the effort field" do NOT fire.
 *
 * KILL SWITCH  PAUSE_GUARD_DISABLED=1|true|yes  => exit 0 immediately.
 * TUNABLES     PAUSE_GUARD_EFFORT_MAXLEN (1000), PAUSE_GUARD_HARD_MAXLEN (280),
 *              PAUSE_GUARD_TAIL_BYTES (1048576)
 * Exit codes: 0 = allow, 2 = block (guidance on stderr).
 */

'use strict';

const fs = require('fs');

const MAX_STDIN = 1024 * 1024;
const DEFAULT_EFFORT_MAXLEN = 1000;
const DEFAULT_HARD_MAXLEN = 280;
const DEFAULT_TAIL_BYTES = 1024 * 1024;

// Leading delimiter for interjections: start, whitespace, or sentence punctuation.
// Intentionally EXCLUDES hyphen so hyphenated compounds ("hard-pause", "non-stop",
// "auto-pause") do NOT match when the feature itself is being discussed.
const LEAD = "(?:^|[\\s,;.!?\"'(])";

// ── Explicit go-anyway overrides (checked first; win over any block) ──────────
const NEGATE = [
  /\b(?:keep going|carry on|go ahead|proceed|press on|crack on|continue)\b/,
  /\b(?:do(?:n['’]?t| not)|no need to|you do(?:n['’]?t| not) need to|don['’]?t bother(?:\s+to)?)\s+(?:change|adjust|switch|touch|raise|lower|reduce|increase|bump|drop|pause|stop|wait|hold)\b/,
  // decision to NOT change the level => proceed at current effort
  /\b(?:keep|leave|stay(?:ing)?)\b[^.?!]{0,18}\b(?:medium|med|high|low|max|maximum|fast|the same|as[-\s]?is|current|where you are)\b/,
];

// ── EFFORT-decision triggers (PRIMARY) ───────────────────────────────────────
// Every pattern requires a MODEL-effort context — a level word, "your effort",
// "reasoning effort", "effort level", or an effort/level adequacy question — so
// the work-quantity sense of "effort" (effort tracker/field/estimate, low-effort
// task, "more effort into the copy") does NOT trigger.
const EFFORT = [
  /\byour\s+(?:reasoning\s+)?effort(?:\s+(?:level|setting|mode))?\b/, // "your effort", "your effort level"
  /\breasoning\s+effort\b/, // "reasoning effort" — bare "effort level" REMOVED (FP-1): it
  // false-blocked work requests that merely mention "effort level" (e.g. "tell me at what
  // effort level should opus run"). Real cases survive via "your effort" / adjust-verb / adequacy.
  /\b(?:effort|reasoning)\b[^.?!]{0,20}\b(?:to|at|up to|down to)\s+(?:high|higher|medium|med|low|lower|max|maximum|min|minimum|fast)\b/, // "effort to high"
  /\b(?:higher|lower|increase|reduce|raise|bump(?:\s*up)?|drop|dial(?:\s*(?:up|down))?|crank(?:\s*up)?|turn(?:\s*(?:up|down))?|upgrade|downgrade)\s+(?:the\s+|your\s+|its\s+)?(?:reasoning\s+)?effort\b/, // "raise the effort", "bump up effort"
  /\b(?:change|adjust|switch|modify)\b[^.?!]{0,15}\byour\s+(?:reasoning\s+)?effort\b/, // "change your effort" (requires "your")
  /\b(?:should|shall|do|would|can|could|want|need|wanna)\s+(?:i|we|you|u)\b[^.?!]{0,40}\b(?:reasoning\s+)?effort\b/, // "should I change your effort?"
  // adequacy question around an effort LEVEL name (either order)
  /\b(?:high|higher|medium|med|low|lower|max|maximum|fast)\b[^.?!]{0,30}\b(?:good enough|enough|sufficient|too (?:much|low|little|high|weak|strong)|overkill|adequate|the right|right (?:level|amount)|cut it|work for)\b/,
  /\b(?:is|are|isn['’]?t|would|should|will|does|do)\b[^.?!]{0,25}\b(?:high|higher|medium|med|low|lower|max|maximum|fast)\b[^.?!]{0,20}\b(?:enough|good|ok|okay|fine|right|sufficient|overkill)\b/,
  // "switch/put/move/bump/drop you to <level>"
  /\b(?:switch|put|move|bump|drop|push|take)\s+(?:me|you|u)\b[^.?!]{0,15}\b(?:to|on|at|up to|down to)\s+(?:high|higher|medium|med|low|lower|max|maximum|fast)\b/,
  // "too low/high effort" (either order) — reasoning-level adjective, not "too much
  // effort" (work-sense). "is this too low effort for this task?"
  /\btoo (?:low|high)\b[^.?!]{0,12}\beffort\b/,
  /\beffort\b[^.?!]{0,10}\btoo (?:low|high)\b/,
];

// ── SLIM hard-pause interjections (SECONDARY) ─────────────────────────────────
function hardPause(lower) {
  // "pause" — but not a UI/feature noun, not "play/pause", and not a TOPIC mention
  // ("where to pause", "pause point", "pause-guard") rather than a command.
  if (
    // object/compound noun: "pause button", "pause-guard", "pause point", "pause/resume"
    !/\bpause[-\s/]+(?:button|feature|icon|screen|menu|modal|state|mode|toggle|timer|control|functionality|handler|logic|option|element|component|page|view|method|function|point|guard|trigger|behaviou?r|when|if|resume|and resume)/.test(lower) &&
    !/\bplay\s*\/?\s*pause\b/.test(lower) &&
    !/\bto pause\b/.test(lower) && // infinitive: "where/when to pause", "tell it to pause" = topic
    !/\b(?:where|when|how|whether|should|if|would|could|will|does|do)\b[^.?!]{0,12}\bpause\b/.test(lower) && // interrogative framing = discussing pausing
    new RegExp(LEAD + 'pause\\b').test(lower)
  ) {
    return true;
  }
  // "hold on" / "hold up" — but not "hold on to <something>" (= retain)
  if (/\bhold (?:on|up)\b(?!\s+to\b)/.test(lower)) return true;
  // standalone "stop" — but not "stop the server / build / process ..."
  if (
    !/\bstop(?:p?ing|p?ed)?\s+(?:the|this|that|it|all|my|your|our|a |an |server|build|process|container|loop|dev|script|job|run|test|service|workflow|deploy|task|recording|sharing|watching|polling)\b/.test(lower) &&
    new RegExp(LEAD + '(?:just |please )?stop\\b').test(lower)
  ) {
    return true;
  }
  // standalone "wait" — but not "wait for / until / on ..."
  if (
    !/\bwait\s+(?:for|until|till|on|while|and see)\b/.test(lower) &&
    new RegExp(LEAD + 'wait\\b').test(lower)
  ) {
    return true;
  }
  return false;
}

// Returns 'effort' | 'hard' | null
function classify(text, limits) {
  const t = (text || '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (NEGATE.some((r) => r.test(lower))) return null; // explicit go-anyway wins
  if (t.length <= limits.effort && EFFORT.some((r) => r.test(lower))) return 'effort';
  if (t.length <= limits.hard && hardPause(lower)) return 'hard';
  return null;
}

// Read only the tail of the transcript (avoids loading multi-MB files every call).
function readTail(path, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

// Walk the tail backward; return the most recent REAL typed user message as
// { text, isSidechain, entrypoint }. Skips tool_result echoes and isMeta
// (slash-command / system-injected) entries. A leading partial line from the
// tail cut simply fails JSON.parse and is skipped.
function latestUserMessage(transcriptPath, tailBytes) {
  const data = readTail(transcriptPath, tailBytes);
  if (data == null) return null; // fail open
  const lines = data.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || o.type !== 'user' || o.isMeta === true) continue;
    const msg = o.message;
    if (!msg || typeof msg !== 'object') continue;
    const c = msg.content;
    let text = null;
    if (typeof c === 'string') {
      const s = c.trim();
      if (s) text = s;
    } else if (Array.isArray(c)) {
      if (c.some((b) => b && b.type === 'tool_result')) continue; // tool-result echo
      const t = c
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (t) text = t;
    }
    if (text == null) continue;
    return {
      text,
      isSidechain: o.isSidechain === true,
      entrypoint: typeof o.entrypoint === 'string' ? o.entrypoint : null,
    };
  }
  return null;
}

function isDisabled() {
  return /^(1|true|yes)$/i.test(String(process.env.PAUSE_GUARD_DISABLED || ''));
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MESSAGES = {
  effort:
    'PAUSED — EFFORT DECISION. The user is asking you to reevaluate your reasoning ' +
    'effort level (e.g. "is medium good enough?", "bump you to high?"). This is the ' +
    'one moment this guard exists for. Answer in TEXT ONLY, make NO tool calls, and ' +
    'STOP so the user can set the right level before you continue. They cannot change ' +
    'your effort mid-turn — only they can, via /model — so do not proceed on the ' +
    'current level. Resume when they give a new go-ahead.',
  hard:
    'PAUSED BY USER. Your latest instruction is a halt (pause / wait / stop / hold on). ' +
    'Respond in TEXT ONLY, make NO tool calls, and stop until the user gives a new ' +
    'go-ahead. An explicit pause categorically overrides "decide-and-do".',
  tail: ' (Misfire? Send your next message, or set PAUSE_GUARD_DISABLED=1 to disable this hook.)',
};

// Pure decision from a parsed payload object — exported for tests.
function decide(input) {
  if (isDisabled()) return { exitCode: 0 };
  const transcriptPath = input && (input.transcript_path || input.transcriptPath);
  if (!transcriptPath) return { exitCode: 0 }; // fail open
  let m;
  try {
    m = latestUserMessage(String(transcriptPath), envInt('PAUSE_GUARD_TAIL_BYTES', DEFAULT_TAIL_BYTES));
  } catch {
    return { exitCode: 0 }; // fail open
  }
  if (!m || m.text == null) return { exitCode: 0 };
  // F5 — never block non-interactive contexts. A pause is a signal to a present
  // human; with nobody to set the level or say "go", blocking would wedge the run.
  //  - isSidechain: subagents/Task dispatches (verified flag on transcript entries).
  //  - PAUSE_GUARD_SKIP_ENTRYPOINTS: comma-list of entrypoints to skip (e.g. a
  //    headless "cli"/print mode), tunable since only "claude-desktop" is observed
  //    locally. (Cloud/cron agents run remotely and never invoke this local hook.)
  if (m.isSidechain) return { exitCode: 0 };
  const skip = String(process.env.PAUSE_GUARD_SKIP_ENTRYPOINTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (m.entrypoint && skip.includes(m.entrypoint.toLowerCase())) return { exitCode: 0 };
  const reason = classify(m.text, {
    effort: envInt('PAUSE_GUARD_EFFORT_MAXLEN', DEFAULT_EFFORT_MAXLEN),
    hard: envInt('PAUSE_GUARD_HARD_MAXLEN', DEFAULT_HARD_MAXLEN),
  });
  if (reason) return { exitCode: 2, stderr: MESSAGES[reason] + MESSAGES.tail };
  return { exitCode: 0 };
}

module.exports = { classify, hardPause, latestUserMessage, decide, EFFORT, NEGATE };

// ── Stdin entrypoint ─────────────────────────────────────────────────────────
if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
  });
  process.stdin.on('end', () => {
    let result;
    try {
      const input = raw.trim() ? JSON.parse(raw) : {};
      result = decide(input);
    } catch {
      result = { exitCode: 0 }; // fail open
    }
    if (result.stderr) process.stderr.write(result.stderr + '\n');
    process.exit(result.exitCode === 2 ? 2 : 0);
  });
  process.stdin.on('error', () => process.exit(0));
}
