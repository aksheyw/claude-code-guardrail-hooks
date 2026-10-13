#!/usr/bin/env node
/**
 * capture-subagent-output.js: global hook that saves subagent reports to files.
 *
 * Auto-saves a SUBSTANTIAL subagent report to a file, so its research/verdicts are
 * not stranded in chat and lost on compaction. A report can arrive three ways, so
 * wire this script to all three (see examples/settings-snippet.json):
 *   - PostToolUse on Task/Agent: a foreground subagent's result (tool_response).
 *     A background launch returns only a notice here (status async_launched); skipped.
 *   - PostToolUse on SubagentHandback: in auto mode a subagent delivers its report
 *     through this tool (tool_input.message), foreground or background.
 *   - SubagentStop: outside auto mode, the report is last_assistant_message. After
 *     a hand-back that field holds only closing text, so if the subagent's
 *     transcript shows a SubagentHandback call, its message is saved instead.
 * The same agent can reach two of these paths, so each agent id is saved once.
 * Enforcement backstop for ~/.claude/rules/capture-discipline.md.
 *
 * Writes to: ~/.claude/agent-outputs/<project>/<YYYY-MM-DD>/<HHMMSS>-<label>.md
 * On the Task/Agent path only, emits additionalContext reminding the main session to
 * fold key findings into a durable doc. It prints NOTHING on the other two paths:
 * there the hook runs as the subagent finishes, and on SubagentStop any
 * additionalContext would keep the subagent running.
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
const MAX_TRANSCRIPT = 32 * 1024 * 1024; // skip reading a subagent transcript past this

// The last SubagentHandback message in a subagent's transcript (JSONL), or ''.
// SubagentStop and PostToolUse(SubagentHandback) can land in either order, and
// whichever lands first claims the agent. Reading the hand-back here means
// SubagentStop saves the delivered report even when it lands first. If the
// transcript cannot be read, SubagentStop falls back to last_assistant_message.
function handbackFromTranscript(p) {
  if (typeof p !== 'string' || !p) return '';
  try {
    if (fs.statSync(p).size > MAX_TRANSCRIPT) return '';
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('SubagentHandback')) continue;
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      const blocks = entry && entry.message && entry.message.content;
      if (!Array.isArray(blocks)) continue;
      const calls = blocks.filter((b) => b && b.type === 'tool_use' && b.name === 'SubagentHandback'
        && b.input && typeof b.input.message === 'string');
      if (calls.length) return calls[calls.length - 1].input.message;
    }
  } catch { /* unreadable transcript: fall back to last_assistant_message */ }
  return '';
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

// The reminder goes to the main session, so only the Task/Agent path sends it.
function remindAndExit(where, chars) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `📝 capture-discipline: subagent output auto-saved ${where} ` +
        `(${chars} chars). Per ~/.claude/rules/capture-discipline.md, fold its key findings ` +
        `into a durable project doc — do not leave them only in chat.`,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function runCapture(raw) {
  try {
    if (!raw) process.exit(0);
    let payload;
    try { payload = JSON.parse(raw); } catch { process.exit(0); }

    const event = payload.hook_event_name || 'PostToolUse';
    const tool = payload.tool_name || payload.toolName || '';
    const input = payload.tool_input || payload.toolInput || {};
    let text = '';
    let labelSource = '';
    let agentId = '';
    let remind = false;

    if (event === 'SubagentStop') {
      // An empty agent_type is one of Claude Code's own internal agents; skip it.
      if (!payload.agent_type) process.exit(0);
      text = handbackFromTranscript(payload.agent_transcript_path)
        || (typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '');
      labelSource = payload.agent_type;
      agentId = payload.agent_id || '';
    } else if (/^SubagentHandback$/i.test(tool)) {
      text = typeof input.message === 'string' ? input.message : '';
      labelSource = payload.agent_type || 'subagent';
      agentId = payload.agent_id || '';
    } else if (/^(Task|Agent)$/i.test(tool)) {
      const resp = payload.tool_response ?? payload.toolResponse ?? payload.response ?? '';
      if (resp && typeof resp === 'object' && (resp.status === 'async_launched' || resp.isAsync === true)) {
        process.exit(0); // a background launch notice, not a report
      }
      // In auto mode a foreground result carries the report in handbackReport.text
      // (observed on Claude Code 2.1.296) and only a short note in content.
      const hb = resp && typeof resp === 'object' && resp.handbackReport;
      text = (hb && typeof hb.text === 'string' && hb.text) || extractText(resp);
      labelSource = input.subagent_type || input.description || tool;
      agentId = (resp && typeof resp === 'object' && resp.agentId) || '';
      remind = true;
    } else {
      process.exit(0); // not a subagent event
    }
    if (!text || text.length < MIN_CHARS) process.exit(0);
    let truncatedNote = '';
    if (text.length > MAX_CAPTURE_CHARS) {
      truncatedNote =
        `\n\n[... truncated by capture hook: original ${text.length} chars, ` +
        `kept first ${MAX_CAPTURE_CHARS} ...]`;
      text = text.slice(0, MAX_CAPTURE_CHARS);
    }

    const label = slug(labelSource);

    const cwd = payload.cwd || process.cwd() || os.homedir();
    const project = slug(path.basename(cwd), 60);

    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const dir = path.join(os.homedir(), '.claude', 'agent-outputs', project, date);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Save each agent once. A foreground subagent reaches the Task/Agent path and also
    // SubagentStop (outside auto mode) or SubagentHandback (in auto mode). An exclusive
    // create of a per-agent marker is race-safe: whichever event lands first wins, the
    // other sees EEXIST and exits.
    // ponytail: one empty marker file per subagent, never pruned. Prune markers older
    // than a day if a project's marker directory passes ~100k files.
    let marker = '';
    if (agentId) {
      const markerDir = path.join(os.homedir(), '.claude', '.capture-markers', project);
      fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
      try {
        fs.writeFileSync(path.join(markerDir, slug(agentId, 80)), '', { flag: 'wx', mode: 0o600 });
        marker = path.join(markerDir, slug(agentId, 80));
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          // Another event already saved this agent. The Task/Agent path still owes the
          // main session its reminder, because the other two paths print nothing.
          if (remind) remindAndExit(`under ${dir}`, text.length);
          process.exit(0);
        }
        throw err;
      }
    }

    const header =
      `# Subagent output (auto-captured)\n\n` +
      `- source: ${event === 'SubagentStop' ? 'SubagentStop' : tool}\n- label: ${labelSource || '(none)'}\n` +
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
        // Nothing was saved, so release the agent: the other event may still save it,
        // and the Task/Agent path must not claim a save that did not happen.
        if (marker) { try { fs.unlinkSync(marker); } catch { /* fail open */ } }
        throw err; // outer catch fails open
      }
    }

    if (!remind) process.exit(0); // print nothing on SubagentStop / SubagentHandback
    remindAndExit(`to ${file}`, text.length);
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
