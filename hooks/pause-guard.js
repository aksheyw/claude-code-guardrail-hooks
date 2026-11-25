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
 * 2026-11-19 FIX. A trial found 16 of 28 real fires in 30 days were wrong, and all
 *   10 ordinary product-spec lines tested were blocked ("Users must wait 3 days...").
 *   The halt check now needs the halt SHAPE (word opens a clause or is addressed to
 *   "you", and is followed by nothing, punctuation, or a short whitelist),
 *   quoted/pasted text is ignored, work-sense effort (story/Jira/team/"effort on X")
 *   is skipped, and "I've set effort to high" counts as a go-ahead.
 *   Tests: tests/pause-guard.test.js. What changed and its limits: CHANGELOG.md.
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

// ── Explicit go-anyway overrides (checked first; win over any block) ──────────
// The negative lookbehind on the first pattern stops a NEGATED go-word from
// reading as a go-anyway: "stop; do not continue" / "wait, don't proceed" must NOT
// override the halt just because the words "continue"/"proceed" appear inside a
// prohibition. (V8 supports variable-length lookbehind.)
const NEGATE = [
  /(?<!\b(?:do not|don['’]?t|never|not|no|cannot|can['’]?t|won['’]?t|wont)\s)\b(?:keep going|carry on|go ahead|proceed|press on|crack on|continue)\b/,
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
  // adequacy question around an effort LEVEL name (either order). The level words
  // here are restricted to medium/med/max/maximum — the ones that read as an
  // effort/model level rather than a plain English adjective. high/higher/low/
  // lower/fast were REMOVED from these bare-adjacency patterns: they false-fired on
  // ordinary dev questions ("is this fast enough?", "low latency is good enough",
  // "is the high quality setting good enough"). Explicit effort phrasing for
  // high/low still fires via the "your effort" / "effort to high" / "bump you to
  // high" patterns above and below.
  /\b(?:medium|med|max|maximum)\b[^.?!]{0,30}\b(?:good enough|enough|sufficient|too (?:much|low|little|high|weak|strong)|overkill|adequate|the right|right (?:level|amount)|cut it|work for)\b/,
  /\b(?:is|are|isn['’]?t|would|should|will|does|do)\b[^.?!]{0,25}\b(?:medium|med|max|maximum)\b[^.?!]{0,20}\b(?:enough|good|ok|okay|fine|right|sufficient|overkill)\b/,
  // "switch/put/move/bump/drop you to <level>"
  /\b(?:switch|put|move|bump|drop|push|take)\s+(?:me|you|u)\b[^.?!]{0,15}\b(?:to|on|at|up to|down to)\s+(?:high|higher|medium|med|low|lower|max|maximum|fast)\b/,
  // "too low/high effort" (either order) — reasoning-level adjective, not "too much
  // effort" (work-sense). "is this too low effort for this task?"
  /\btoo (?:low|high)\b[^.?!]{0,12}\beffort\b/,
  /\beffort\b[^.?!]{0,10}\btoo (?:low|high)\b/,
];

// ── Work-sense effort (2026-11-19 fix) ───────────────────────────────────────
// The trial found PM lines blocked as effort questions: "Set effort to high for the
// API story in Jira", "Is medium priority enough for this bug?", "Should we raise the
// effort on onboarding next quarter?". Only the GENERIC effort patterns below are
// subject to these filters; the STRONG ones ("your effort", "reasoning effort",
// "bump you to high", "too low effort") always count.
const STRONG_EFFORT = new Set([0, 1, 4, 8, 9, 10]); // indexes into EFFORT
const WORK_CONTEXT =
  /\b(?:stor(?:y|ies)|tickets?|jira|epics?|sprints?|estimates?|estimation|points|quarter|roadmap|backlog|okrs?|headcount|squad|team)\b/;
const EFFORT_TARGET = /\beffort\s+(?:on|into|towards?|across|behind)\s+(?!this\b|that\b|it\b|these\b|those\b)/;
// "medium priority" / "high severity" are not effort levels; blank them out first.
const LEVEL_NOUN =
  /\b(?:medium|med|max|maximum|high|low)[\s-]+(?:priority|severity|risk|size|sized|impact|confidence|tier|plan|term|scope|complexity|budget|quality|volume|traffic|length|income|value)\b/g;
// A statement that the level is ALREADY set is a go-ahead, not a pending decision.
const EFFORT_ALREADY_SET =
  /\bi(?:['’]?ve| have| just| already|['’]?ve just|['’]?ve already)\s+(?:set|raised|lowered|changed|switched|bumped|dropped|put|moved|turned)\b[^.?!]{0,20}\b(?:effort|you|u)\b|\bi\s+(?:raised|lowered|changed|switched|bumped|dropped|moved|turned)\b[^.?!]{0,20}\b(?:effort|you|u)\b/;

function effortDecision(lower) {
  if (EFFORT_ALREADY_SET.test(lower)) return false;
  const t = lower.replace(LEVEL_NOUN, ' ');
  const workSense = WORK_CONTEXT.test(t) || EFFORT_TARGET.test(t);
  return EFFORT.some((r, i) => r.test(t) && (STRONG_EFFORT.has(i) || !workSense));
}

// ── Quoted text is not an instruction (2026-11-19 fix) ───────────────────────
// Replay showed pasted assistant text ("> ... I lifted the pause ...") firing the
// guard. Drop blockquote lines, HTML comments, and quoted spans before matching.
// Linear-time removal of <!-- ... --> comments. Same result as
// text.replace(/<!--[\s\S]*?-->/g, ' '), but that regex rescans to the end of the
// text from every unclosed "<!--", which is quadratic on a long message.
function stripComments(text) {
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf('<!--', i);
    if (open === -1) break;
    const close = text.indexOf('-->', open + 4);
    if (close === -1) break; // unclosed: no later "<!--" can close either
    out += text.slice(i, open) + ' ';
    i = close + 3;
  }
  return out + text.slice(i);
}

function stripQuoted(text) {
  return stripComments(text)
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/"[^"\n]{0,200}"/g, ' ')
    .replace(/“[^”\n]{0,200}”/g, ' ')
    .replace(/`[^`\n]{0,200}`/g, ' ')
    .replace(/(^|[\s(])['‘][^'’\n]{1,80}['’](?=$|[\s.,;:!?)])/g, '$1 ');
}

// ── SLIM hard-pause interjections (SECONDARY) ─────────────────────────────────
// 2026-11-19 rewrite. The old version matched the halt word ANYWHERE minus a list of
// exceptions, so every descriptive sentence fired ("Users must wait 3 days", "the
// session should stop", "hits stop mid-upload", "pause the newsletter"). A halt aimed
// at the assistant has a shape; the new version requires that shape:
//   1. POSITION: the word opens a clause (message start, or after . ! ? ; : , newline,
//      a dash, or "-->"), optionally after up to three discourse words ("yes, but",
//      "no", "ok", "please", "just"...). OR it is addressed: "you need to / you
//      should / can you ... stop".
//   2. WHAT FOLLOWS: end of text, punctuation, or a short whitelist ("here", "now",
//      "for now", "a sec", "what you're doing"; for wait/hold on also a question word
//      or pronoun: "wait why...", "wait r u..."). An object ("stop them", "pause the
//      workflow", "pause for HIGH", "wait time", "stop and move on") does not count.
const MARKERS =
  "(?:yes|yeah|yep|ya|no|nope|nah|ok|okay|oh|hey|hmm+|but|so|and|then|please|pls|plz|just|now|actually|lets|let['’]?s|wait|stop|pause|hold on|hang on)";
const CLAUSE_START = `(?:^|[.!?;:,\\n]|\\s[-–—]+|-->)\\s*(?:${MARKERS}[\\s,.!]+){0,3}`;
const ADDRESSED =
  "(?:\\b(?:you|u)\\s+(?:really\\s+)?(?:need|have|got|must|should|gotta)\\s+(?:to\\s+)?|\\b(?:can|could|would|will)\\s+(?:you|u)\\s+(?:please\\s+|pls\\s+|just\\s+)?)";
const TAIL_COMMON =
  "here|now|right now|right there|there|please|pls|plz|immediately|asap|for now|for a (?:sec|second|moment|minute|min|bit)|a (?:sec|second|moment|minute|min)|everything|all work|what you(?:['’]re| are| r)? doing|and wait|and listen|and let me|and check with me|and ask me";
const TAIL_QUESTION =
  "why|what|how|where|who|when|is|are|r|u|you|did|do|does|was|were|i|we|that|that['’]?s|this|it['’]?s|isn['’]?t|shouldn['’]?t|didn['’]?t|don['’]?t|before|actually|no|hold|stop|so|hmm+|let|up";
const END = '(?=\\s*(?:$|[.,;:!?…)]))';

function haltRe(word, tail) {
  const after = `(?:${END}|\\s+(?:${tail})\\b)`;
  return new RegExp(`(?:${CLAUSE_START}|${ADDRESSED})${word}${after}`);
}
const HALT_STOP = haltRe('(?:just\\s+)?stop', TAIL_COMMON);
const HALT_PAUSE = haltRe('pause', TAIL_COMMON);
const HALT_WAIT = haltRe('wait', `${TAIL_COMMON}|${TAIL_QUESTION}`);
const HALT_HOLD = haltRe('(?:hold|hang)\\s+(?:on|up)', `${TAIL_COMMON}|${TAIL_QUESTION}`);
// UI vocabulary: "play, pause, stop", "play/pause".
const MEDIA_CONTROLS = /\bplay\b[^.?!\n]{0,30}\b(?:pause|stop)\b|\b(?:pause|stop)\b[^.?!\n]{0,30}\bplay\b/;
const NOT_A_HALT = /\bwait\s+(?:is|was)\s+(?:over|worth)\b/;

function hardPause(lower) {
  if (MEDIA_CONTROLS.test(lower) || NOT_A_HALT.test(lower)) return false;
  return [HALT_STOP, HALT_PAUSE, HALT_WAIT, HALT_HOLD].some((r) => r.test(lower));
}

// Returns 'effort' | 'hard' | null
function classify(text, limits) {
  const raw = (text || '').trim();
  if (!raw) return null;
  const t = stripQuoted(raw).trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (NEGATE.some((r) => r.test(lower))) return null; // explicit go-anyway wins
  if (t.length <= limits.effort && effortDecision(lower)) return 'effort';
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
    // Honor the ACTUAL bytes read: allocUnsafe is uninitialized, and if the file
    // shrinks between fstat and readSync (another process truncating the log), a
    // full-length toString() would expose uninitialized heap memory. Decode only
    // what was really read.
    const bytesRead = fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8', 0, bytesRead);
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

module.exports = { classify, hardPause, effortDecision, stripQuoted, latestUserMessage, decide, EFFORT, NEGATE };

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
