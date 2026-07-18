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

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

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

try {
  if (process.env.CAPTURE_HOOK_DISABLED === '1') process.exit(0);
  const raw = readStdin();
  if (!raw) process.exit(0);
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const tool = payload.tool_name || payload.toolName || '';
  if (!/^(Task|Agent)$/i.test(tool)) process.exit(0); // only subagent tools

  const text = extractText(payload.tool_response ?? payload.toolResponse ?? payload.response ?? '');
  if (!text || text.length < MIN_CHARS) process.exit(0);

  const input = payload.tool_input || payload.toolInput || {};
  const label = slug(input.subagent_type || input.description || tool);

  const cwd = payload.cwd || process.cwd() || os.homedir();
  const project = slug(path.basename(cwd), 60);

  const now = new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const dir = path.join(os.homedir(), '.claude', 'agent-outputs', project, date);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${time}-${label}.md`);

  const header =
    `# Subagent output (auto-captured)\n\n` +
    `- tool: ${tool}\n- label: ${input.subagent_type || input.description || '(none)'}\n` +
    `- project: ${project}\n- captured: ${now.toISOString()}\n- cwd: ${cwd}\n\n` +
    `> Auto-saved by capture-subagent-output.js so this is never lost to chat compaction.\n> Fold the key findings into a durable project doc (tasks/… or the wiki).\n\n---\n\n`;
  fs.writeFileSync(file, header + text);

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
