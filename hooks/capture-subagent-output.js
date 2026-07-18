#!/usr/bin/env node
/**
 * capture-subagent-output.js — global PostToolUse hook.
 *
 * Auto-saves every SUBSTANTIAL subagent final output to a file, so subagent
 * research/verdicts are never stranded in chat and lost on compaction.
 * Enforcement backstop for ~/.claude/rules/capture-discipline.md.
 *
 * Writes to: ~/.claude/agent-outputs/<project>/<YYYY-MM-DD>/<HHMMSS>-<label>.md
 * Emits additionalContext reminding the agent to fold key findings into a durable doc.
 * FAILS OPEN (never blocks a tool). Kill switch: CAPTURE_HOOK_DISABLED=1.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const MIN_CHARS = 800; // only capture substantial outputs
const MAX_CAPTURE_CHARS = 2 * 1024 * 1024; // cap written output (~2MB) so a huge
// subagent response can't grow the capture file without bound or stall the write.

// Cap the stdin read (matching pause-guard.js / config-protection.js) so a
// pathological multi-hundred-MB subagent payload can't OOM or stall the hook. A
// payload over the cap is truncated, fails JSON.parse, and we exit 0 (fail open,
// no capture) — acceptable, since capture never blocks a tool.
const MAX_STDIN = 16 * 1024 * 1024;

// pull plain text out of the many shapes a tool_response / message can take
function extractText(v, depth = 0) {
  if (v == null || depth > 6) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => extractText(x, depth + 1)).join('\n');
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (v.type === 'text' && typeof v.text === 'string') return v.text;
    // common containers
    for (const k of ['content', 'output', 'result', 'response', 'message', 'finalText', 'text']) {
      if (v[k] != null) { const t = extractText(v[k], depth + 1); if (t) return t; }
    }
  }
  return '';
}

function slug(s, n = 40) {
  return (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n) || 'agent';
}

function pad(n) { return String(n).padStart(2, '0'); }

function runCapture(raw) {
  try {
    if (!raw) process.exit(0);
    let payload;
    try { payload = JSON.parse(raw); } catch { process.exit(0); }

    const tool = payload.tool_name || payload.toolName || '';
    if (!/^(Task|Agent)$/i.test(tool)) process.exit(0); // only subagent tools

    let text = extractText(payload.tool_response ?? payload.toolResponse ?? payload.response ?? '');
    if (!text || text.length < MIN_CHARS) process.exit(0);
    let truncatedNote = '';
    if (text.length > MAX_CAPTURE_CHARS) {
      truncatedNote =
        `\n\n[... truncated by capture hook: original ${text.length} chars, ` +
        `kept first ${MAX_CAPTURE_CHARS} ...]`;
      text = text.slice(0, MAX_CAPTURE_CHARS);
    }

    const input = payload.tool_input || payload.toolInput || {};
    const label = slug(input.subagent_type || input.description || tool);

    const cwd = payload.cwd || process.cwd() || os.homedir();
    const project = slug(path.basename(cwd), 60);

    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const dir = path.join(os.homedir(), '.claude', 'agent-outputs', project, date);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const header =
      `# Subagent output (auto-captured)\n\n` +
      `- tool: ${tool}\n- label: ${input.subagent_type || input.description || '(none)'}\n` +
      `- project: ${project}\n- captured: ${now.toISOString()}\n- cwd: ${cwd}\n\n` +
      `> Auto-saved by capture-subagent-output.js so this is never lost to chat compaction.\n> Fold the key findings into a durable project doc (tasks/… or the wiki).\n\n---\n\n`;
    const body = header + text + truncatedNote;

    // Collision-safe AND race-safe write: two subagents finishing in the SAME second
    // with the same label resolve to the same base path. An existsSync check would be
    // TOCTOU (both processes see it absent, both write, one clobbers the other), so we
    // use an EXCLUSIVE create (flag 'wx') and bump the suffix on EEXIST until it lands.
    // `file` is declared OUT here so it stays in scope for the additionalContext below.
    // Mode 0600 — these files can contain a secret a subagent quoted, so keep them
    // owner-only rather than umask-default 0644.
    let file;
    for (let n = 1; ; n++) {
      file = n === 1
        ? path.join(dir, `${time}-${label}.md`)
        : path.join(dir, `${time}-${label}-${n}.md`);
      try {
        fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
        break;
      } catch (err) {
        if (err && err.code === 'EEXIST' && n < 10000) continue;
        throw err; // outer catch fails open
      }
    }

    const out = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `📝 capture-discipline: subagent output auto-saved to ${file} ` +
          `(${text.length} chars). Per ~/.claude/rules/capture-discipline.md, fold its key findings ` +
          `into a durable project doc — do not leave them only in chat.`,
      },
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  } catch (e) {
    // fail open — never block a tool because capture had a problem
    process.exit(0);
  }
}

if (process.env.CAPTURE_HOOK_DISABLED === '1') process.exit(0);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
  // Past the cap we simply stop appending; the truncated buffer fails JSON.parse
  // and runCapture exits 0 (fail open). This bounds memory on a pathological payload.
});
process.stdin.on('end', () => runCapture(raw));
process.stdin.on('error', () => process.exit(0));
