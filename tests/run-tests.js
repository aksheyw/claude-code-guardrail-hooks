#!/usr/bin/env node
'use strict';

// Zero-dependency tests for the four hooks. Run with: node tests/run-tests.js
// Two styles: (1) unit tests against exported functions (pause-guard,
// config-protection), (2) integration tests that spawn the script with piped
// stdin (capture-subagent-output, secret-scan-postwrite.sh), which have no
// meaningful exports. Many tests below are regression locks for defects found in
// the pre-publish adversarial review (see README + the audit findings doc).

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ── pause-guard.js — classify() ─────────────────────────────────────────────
console.log('pause-guard.js — classify()');
{
  const { classify } = require(path.join(HOOKS_DIR, 'pause-guard.js'));
  const limits = { effort: 1000, hard: 280 };
  const c = (m) => classify(m, limits);

  test('fires on an explicit effort-adequacy question', () => {
    assert.strictEqual(c('is medium good enough for this?'), 'effort');
  });
  test('fires on "bump you to high"', () => {
    assert.strictEqual(c('can you bump you to high for this one'), 'effort');
  });
  test('fires on "change your effort to high"', () => {
    assert.strictEqual(c('change your effort to high'), 'effort');
  });
  test('does NOT fire on work-sense "effort" (effort tracker)', () => {
    assert.strictEqual(c('update the effort tracker for this sprint'), null);
  });
  test('does NOT fire on "too much effort to maintain"', () => {
    assert.strictEqual(c('this abstraction is too much effort to maintain'), null);
  });

  // Regression (finding G): common dev "fast/high/low ... enough" questions must
  // NOT be read as effort decisions.
  test('G: does NOT fire on "is this fast enough?"', () => {
    assert.strictEqual(c('is this fast enough?'), null);
  });
  test('G: does NOT fire on "low latency is good enough for now"', () => {
    assert.strictEqual(c('low latency is good enough for now'), null);
  });
  test('G: does NOT fire on "is the high quality setting good enough"', () => {
    assert.strictEqual(c('is the high quality setting good enough'), null);
  });
  test('G: still fires on "is max overkill here"', () => {
    assert.strictEqual(c('is max overkill here'), 'effort');
  });

  test('fires on a bare "stop"', () => assert.strictEqual(c('stop.'), 'hard'));
  test('does NOT fire on "stop the server"', () => {
    assert.strictEqual(c('please stop the server first'), null);
  });
  test('fires on "wait"', () => assert.strictEqual(c('wait'), 'hard'));
  test('does NOT fire on "wait for the build"', () => {
    assert.strictEqual(c('wait for the build to finish'), null);
  });
  test('negation override wins ("keep going")', () => {
    assert.strictEqual(c('stop overthinking this, keep going'), null);
  });
  test('does NOT fire on the pause-guard feature name itself', () => {
    assert.strictEqual(c('can you explain how the pause-guard hook works'), null);
  });

  // Regression (finding H): a NEGATED go-word must not cancel an explicit halt.
  test('H: "stop; do not continue" stays a hard pause', () => {
    assert.strictEqual(c('stop; do not continue'), 'hard');
  });
  test('H: "wait. do not proceed" stays a hard pause', () => {
    assert.strictEqual(c('wait. do not proceed'), 'hard');
  });
  test('H: plain "keep going" is still a go-anyway override', () => {
    assert.strictEqual(c('keep going'), null);
  });

  // Regression (finding: hard-pause prose false positives)
  test('does NOT fire on "I cannot stop thinking about this bug"', () => {
    assert.strictEqual(c('I cannot stop thinking about this bug'), null);
  });
  test('does NOT fire on "stop guessing and read the code"', () => {
    assert.strictEqual(c('stop guessing and read the code'), null);
  });
  test('does NOT fire on "the wait is over"', () => {
    assert.strictEqual(c('the wait is over'), null);
  });
  test('still fires on a real "please stop"', () => {
    assert.strictEqual(c('please stop'), 'hard');
  });
}

// ── pause-guard.js — decide() over a transcript (previously untested layer) ──
console.log('pause-guard.js — decide() transcript layer');
{
  const { decide } = require(path.join(HOOKS_DIR, 'pause-guard.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-transcript-'));
  const writeTx = (lines) => {
    const p = path.join(tmp, `tx-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(p, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
    return p;
  };

  test('blocks when the latest real user message is an effort question', () => {
    const p = writeTx([
      { type: 'user', message: { content: 'do the thing' } },
      { type: 'user', message: { content: 'is medium good enough?' } },
    ]);
    assert.strictEqual(decide({ transcript_path: p }).exitCode, 2);
  });
  test('allows when the latest user message is ordinary work', () => {
    const p = writeTx([{ type: 'user', message: { content: 'add a login page' } }]);
    assert.strictEqual(decide({ transcript_path: p }).exitCode, 0);
  });
  test('skips an isMeta (slash-command) entry to find the real message', () => {
    const p = writeTx([
      { type: 'user', message: { content: 'is medium good enough?' } },
      { type: 'user', isMeta: true, message: { content: '/some-command expansion' } },
    ]);
    assert.strictEqual(decide({ transcript_path: p }).exitCode, 2);
  });
  test('skips a tool_result echo to find the real typed message', () => {
    const p = writeTx([
      { type: 'user', message: { content: 'is medium good enough?' } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    ]);
    assert.strictEqual(decide({ transcript_path: p }).exitCode, 2);
  });
  test('fails OPEN (allow) when no transcript path is given', () => {
    assert.strictEqual(decide({}).exitCode, 0);
  });
  test('fails OPEN (allow) on a missing transcript file', () => {
    assert.strictEqual(decide({ transcript_path: path.join(tmp, 'nope.jsonl') }).exitCode, 0);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── config-protection.js ────────────────────────────────────────────────────
console.log('config-protection.js');
{
  const { run } = require(path.join(HOOKS_DIR, 'config-protection.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-protect-'));
  const call = (fp) => run(JSON.stringify({ tool_input: { file_path: fp } }));

  test('blocks editing an EXISTING .eslintrc.js', () => {
    const target = path.join(tmp, '.eslintrc.js');
    fs.writeFileSync(target, 'module.exports = {}');
    assert.strictEqual(call(target).exitCode, 2);
  });
  test('allows creating a NEW .eslintrc.js (no existing file)', () => {
    assert.strictEqual(call(path.join(tmp, 'fresh', '.eslintrc.js')).exitCode, 0);
  });
  test('allows editing an unrelated source file', () => {
    assert.strictEqual(call(path.join(tmp, 'index.js')).exitCode, 0);
  });
  test('fails closed on a truncated payload (unit: run() truncated flag)', () => {
    assert.strictEqual(run('{"tool_input"', { truncated: true }).exitCode, 2);
  });

  // Regression (agy #6): the unit test above only exercises the run() flag; this
  // spawns the real process with a >1MB stdin so the stdin data-event truncation
  // detection that SETS that flag is actually covered.
  test('fails closed on a real oversized stdin (>1MB blocks, exit 2)', () => {
    const big = JSON.stringify({ tool_input: { file_path: 'x.js', content: 'a'.repeat(1024 * 1024 + 100) } });
    let code = 0;
    try {
      execFileSync('node', [path.join(HOOKS_DIR, 'config-protection.js')], { input: big, encoding: 'utf8' });
    } catch (err) {
      code = err.status;
    }
    assert.strictEqual(code, 2);
  });

  // Regression (finding B): a case-variant name must resolve to the same file on a
  // case-insensitive FS and still be blocked. On a case-SENSITIVE FS the variant is
  // a different, non-existent file, so this assertion only holds where the temp FS
  // is case-insensitive (macOS/Windows default). Guard it so it doesn't false-fail
  // on Linux CI.
  test('B: case-variant .ESLintRC.js blocked on case-insensitive FS', () => {
    const real = path.join(tmp, '.eslintrc.js'); // already created above
    const variant = path.join(tmp, '.ESLintRC.js');
    let sameFs = false;
    try {
      sameFs = fs.statSync(variant).ino === fs.statSync(real).ino;
    } catch {
      sameFs = false; // case-sensitive FS: variant doesn't exist
    }
    if (sameFs) {
      assert.strictEqual(call(variant).exitCode, 2);
    } else {
      // case-sensitive FS: a genuinely different file, correctly allowed
      assert.strictEqual(call(variant).exitCode, 0);
    }
  });

  // Regression (finding E): a non-string file_path must not crash to exit 1 (allow).
  test('E: object file_path does not crash, returns allow', () => {
    const result = run(JSON.stringify({ tool_input: { file_path: { x: 1 } } }));
    assert.strictEqual(result.exitCode, 0);
  });

  // Regression (finding I): real Prettier module/TS config variants are protected.
  test('I: existing .prettierrc.mjs is blocked', () => {
    const target = path.join(tmp, '.prettierrc.mjs');
    fs.writeFileSync(target, 'export default {}');
    assert.strictEqual(call(target).exitCode, 2);
  });
  test('I: existing prettier.config.ts is blocked', () => {
    const target = path.join(tmp, 'prettier.config.ts');
    fs.writeFileSync(target, 'export default {}');
    assert.strictEqual(call(target).exitCode, 2);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── capture-subagent-output.js (integration) ───────────────────────────────
console.log('capture-subagent-output.js');
{
  const runCapture = (payload, homeDir, env = {}) =>
    execFileSync('node', [path.join(HOOKS_DIR, 'capture-subagent-output.js')], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: homeDir, CAPTURE_HOOK_DISABLED: '', ...env },
      encoding: 'utf8',
    });
  const allFiles = (home) => {
    const dir = path.join(home, '.claude', 'agent-outputs');
    const out = [];
    const walk = (d) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk(dir);
    return out;
  };

  test('captures a substantial Task output to a file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    const longText = 'x'.repeat(900);
    runCapture(
      { tool_name: 'Task', tool_input: { subagent_type: 'test-agent' }, tool_response: longText, cwd: '/tmp/some-project' },
      home
    );
    const files = allFiles(home);
    assert.strictEqual(files.length, 1);
    assert.ok(fs.readFileSync(files[0], 'utf8').includes(longText));
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Regression: the additionalContext reminder must actually be emitted on stdout.
  // (A scope bug once let the file write succeed but crash before emitting this,
  // which a file-exists-only assertion missed.)
  test('emits the capture-discipline reminder on stdout', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    const out = runCapture({ tool_name: 'Task', tool_input: { subagent_type: 'x' }, tool_response: 'q'.repeat(900) }, home);
    assert.ok(out.includes('capture-discipline'), 'stdout should carry the additionalContext reminder');
    assert.ok(out.includes('auto-saved to'), 'reminder should name the saved file');
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('does NOT capture a short output (below MIN_CHARS)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ tool_name: 'Task', tool_response: 'too short' }, home);
    assert.strictEqual(allFiles(home).length, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('does NOT capture a non-subagent tool', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ tool_name: 'Bash', tool_response: 'x'.repeat(900) }, home);
    assert.strictEqual(allFiles(home).length, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('kill switch CAPTURE_HOOK_DISABLED=1 skips capture', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ tool_name: 'Task', tool_response: 'x'.repeat(900) }, home, { CAPTURE_HOOK_DISABLED: '1' });
    assert.strictEqual(allFiles(home).length, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Regression (finding: extractText) — the array/content shape the function exists
  // to handle must be captured, not just a plain string.
  test('extracts text from a {content:[{type:text,text}]} shape', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    const body = 'y'.repeat(900);
    runCapture({ tool_name: 'Task', tool_response: { content: [{ type: 'text', text: body }] } }, home);
    const files = allFiles(home);
    assert.strictEqual(files.length, 1);
    assert.ok(fs.readFileSync(files[0], 'utf8').includes(body));
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Regression (finding K): two same-label captures must not clobber each other.
  test('K: two captures with the same label do not overwrite (no data loss)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    const a = 'A'.repeat(900);
    const b = 'B'.repeat(900);
    runCapture({ tool_name: 'Task', tool_input: { subagent_type: 'dup' }, tool_response: a }, home);
    runCapture({ tool_name: 'Task', tool_input: { subagent_type: 'dup' }, tool_response: b }, home);
    const bodies = allFiles(home).map((f) => fs.readFileSync(f, 'utf8'));
    assert.ok(bodies.some((t) => t.includes(a)), 'first capture must survive');
    assert.ok(bodies.some((t) => t.includes(b)), 'second capture must survive');
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Regression (finding J): output is size-capped.
  test('J: an oversized output is truncated with a note', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    const huge = 'z'.repeat(3 * 1024 * 1024); // > 2MB cap
    runCapture({ tool_name: 'Task', tool_response: huge }, home);
    const files = allFiles(home);
    assert.strictEqual(files.length, 1);
    const content = fs.readFileSync(files[0], 'utf8');
    assert.ok(content.includes('truncated by capture hook'), 'expected a truncation note');
    assert.ok(content.length < huge.length, 'expected the file to be smaller than the raw output');
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Background and auto-mode subagents. Payload shapes below were logged from a live
  // Claude Code 2.1.296 run: a background Agent call returns only a launch notice; the
  // report arrives in SubagentHandback's tool_input.message (auto mode) or in
  // SubagentStop's last_assistant_message (other modes).
  const REPORT = 'R'.repeat(900);
  test('BG: captures a SubagentHandback report', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', agent_id: 'a1', agent_type: 'general-purpose', tool_input: { message: REPORT }, tool_response: { success: true, message: 'Report delivered to your caller.' } }, home);
    const files = allFiles(home);
    assert.strictEqual(files.length, 1);
    assert.ok(fs.readFileSync(files[0], 'utf8').includes(REPORT));
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: captures a SubagentStop last_assistant_message', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'Explore', last_assistant_message: REPORT }, home);
    const files = allFiles(home);
    assert.strictEqual(files.length, 1);
    assert.ok(fs.readFileSync(files[0], 'utf8').includes(REPORT));
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: ignores a SubagentStop with no last_assistant_message (it handed back instead)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ hook_event_name: 'SubagentStop', agent_id: 'a3', agent_type: 'general-purpose' }, home);
    assert.strictEqual(allFiles(home).length, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: ignores SubagentStop from an internal agent (empty agent_type)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ hook_event_name: 'SubagentStop', agent_id: 'a4', agent_type: '', last_assistant_message: REPORT }, home);
    assert.strictEqual(allFiles(home).length, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: ignores a background launch notice (status async_launched)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'x' }, tool_response: { isAsync: true, status: 'async_launched', agentId: 'a5', prompt: 'p'.repeat(900), content: [{ type: 'text', text: 'n'.repeat(900) }] } }, home);
    assert.strictEqual(allFiles(home).length, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: the same agent seen by Agent and by SubagentStop is saved once', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ hook_event_name: 'SubagentStop', agent_id: 'a6', agent_type: 'Explore', last_assistant_message: REPORT }, home);
    runCapture({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'Explore' }, tool_response: { status: 'completed', agentId: 'a6', content: [{ type: 'text', text: REPORT }] } }, home);
    const reports = allFiles(home).filter((f) => f.endsWith('.md'));
    assert.strictEqual(reports.length, 1, 'expected exactly one saved report');
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: the Agent path still reminds the main session when SubagentStop saved it first', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ hook_event_name: 'SubagentStop', agent_id: 'a9', agent_type: 'Explore', last_assistant_message: REPORT }, home);
    const out = runCapture({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'Explore' }, tool_response: { status: 'completed', agentId: 'a9', content: [{ type: 'text', text: REPORT }] } }, home);
    assert.ok(out.includes('capture-discipline'), 'the main session should still get the reminder');
    assert.strictEqual(allFiles(home).filter((f) => f.endsWith('.md')).length, 1, 'still saved once');
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: reads an auto-mode foreground report from handbackReport.text', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'x' }, tool_response: { status: 'completed', agentId: 'b1', handback: 'send', handbackReport: { text: REPORT }, content: [{ type: 'text', text: 'Report delivered.' }] } }, home);
    const files = allFiles(home);
    assert.strictEqual(files.length, 1);
    assert.ok(fs.readFileSync(files[0], 'utf8').includes(REPORT));
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: auto-mode foreground, in the logged order (hand-back, stop, Agent result), saves once and reminds', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', agent_id: 'c1', agent_type: 'general-purpose', tool_input: { message: REPORT } }, home);
    runCapture({ hook_event_name: 'SubagentStop', agent_id: 'c1', agent_type: 'general-purpose' }, home);
    const out = runCapture({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' }, tool_response: { status: 'completed', agentId: 'c1', handbackReport: { text: REPORT }, content: [{ type: 'text', text: 'Report delivered.' }] } }, home);
    assert.ok(out.includes('capture-discipline'), 'the main session should still get the reminder');
    assert.strictEqual(allFiles(home).filter((f) => f.endsWith('.md')).length, 1, 'saved once');
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: SubagentStop after a hand-back saves the hand-back message, not the closing text', () => {
    // Logged live on 2.1.296: in auto mode SubagentStop can land before the
    // SubagentHandback hook and claim the agent, and its last_assistant_message is
    // the subagent's closing text, which need not be the delivered report.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    const transcript = path.join(home, 'agent-d1.jsonl');
    const HANDED = 'H'.repeat(900);
    const CLOSING = 'C'.repeat(900);
    fs.writeFileSync(transcript, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: CLOSING }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: HANDED } }] } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    runCapture({ hook_event_name: 'SubagentStop', agent_id: 'd1', agent_type: 'general-purpose', agent_transcript_path: transcript, last_assistant_message: CLOSING }, home);
    runCapture({ hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', agent_id: 'd1', agent_type: 'general-purpose', tool_input: { message: HANDED } }, home);
    const reports = allFiles(home).filter((f) => f.endsWith('.md'));
    assert.strictEqual(reports.length, 1, 'saved once');
    const saved = fs.readFileSync(reports[0], 'utf8');
    assert.ok(saved.includes(HANDED) && !saved.includes(CLOSING), 'expected the hand-back message');
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: SubagentStop with an unreadable transcript falls back to last_assistant_message', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ hook_event_name: 'SubagentStop', agent_id: 'd2', agent_type: 'Explore', agent_transcript_path: path.join(home, 'missing.jsonl'), last_assistant_message: REPORT }, home);
    const files = allFiles(home);
    assert.strictEqual(files.length, 1);
    assert.ok(fs.readFileSync(files[0], 'utf8').includes(REPORT));
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: a failed write releases the agent, so the next event can still save it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const day = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const dayDir = path.join(home, '.claude', 'agent-outputs', 'proj', day);
    fs.mkdirSync(dayDir, { recursive: true });
    fs.chmodSync(dayDir, 0o500); // the report write fails with EACCES
    runCapture({ hook_event_name: 'SubagentStop', agent_id: 'e1', agent_type: 'Explore', cwd: '/x/proj', last_assistant_message: REPORT }, home);
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', '.capture-markers', 'proj', 'e1')), false, 'marker should be released');
    fs.chmodSync(dayDir, 0o700);
    runCapture({ hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', agent_id: 'e1', agent_type: 'Explore', cwd: '/x/proj', tool_input: { message: REPORT } }, home);
    assert.strictEqual(allFiles(home).filter((f) => f.endsWith('.md')).length, 1, 'the second event saves it');
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: prints nothing on SubagentStop (a reminder there would keep the subagent running)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    const out = runCapture({ hook_event_name: 'SubagentStop', agent_id: 'a7', agent_type: 'Explore', last_assistant_message: REPORT }, home);
    assert.strictEqual(out.trim(), '');
    fs.rmSync(home, { recursive: true, force: true });
  });
  test('BG: prints nothing on SubagentHandback (it runs inside the finishing subagent)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    const out = runCapture({ hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', agent_id: 'a8', agent_type: 'x', tool_input: { message: REPORT } }, home);
    assert.strictEqual(out.trim(), '');
    fs.rmSync(home, { recursive: true, force: true });
  });
}

// ── secret-scan-postwrite.sh (integration) ─────────────────────────────────
console.log('secret-scan-postwrite.sh');
{
  const runScan = (filePath) =>
    execFileSync('bash', [path.join(HOOKS_DIR, 'secret-scan-postwrite.sh')], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      encoding: 'utf8',
    });
  const writeScan = (name, content) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
    const target = path.join(tmp, name);
    fs.writeFileSync(target, content);
    const out = runScan(target);
    fs.rmSync(tmp, { recursive: true, force: true });
    return out;
  };
  const KEY = 'sk-' + 'a'.repeat(40);

  test('flags a hardcoded OpenAI-style key', () => {
    assert.ok(writeScan('config.js', `const key = "${KEY}";`).includes('SECRET SCAN'));
  });
  test('stays silent on a clean file', () => {
    assert.strictEqual(writeScan('index.js', 'const greeting = "hello world";\n').trim(), '');
  });

  // Regression (finding A): a real key behind an env fallback on the SAME line must
  // still be flagged — this is the non-vacuous replacement for the old test, and it
  // fails if the env exclusion reverts to line-scoping.
  test('A: flags a hardcoded key hidden behind an env fallback (|| "sk-...")', () => {
    const out = writeScan('config.js', `const key = process.env.OPENAI_API_KEY || "${KEY}";\n`);
    assert.ok(out.includes('SECRET SCAN'), 'the fallback key must be flagged');
  });
  test('A: still silent on a pure env-var reference (no false positive)', () => {
    assert.strictEqual(writeScan('config.js', 'const apiKey = process.env.OPENAI_API_KEY;\n').trim(), '');
  });
  test('A: still silent on a generic env assignment (api_key = process.env.X)', () => {
    assert.strictEqual(writeScan('config.js', 'api_key = process.env.SOMEKEY\n').trim(), '');
  });
  test('A: flags a real generic hardcoded secret', () => {
    assert.ok(writeScan('config.js', 'password = "hunter2hunter2hunter2hunter2"\n').includes('SECRET SCAN'));
  });
  // Regression (Codex re-review #1): a real generic secret sharing a line with an
  // unrelated env reference must NOT be suppressed (the old env filter was line-scoped).
  test('A: flags a generic secret even when an env ref is elsewhere on the line', () => {
    const src = 'const password = "hunter2hunter2hunter2hunter2"; const k = process.env.KEY;\n';
    assert.ok(writeScan('config.js', src).includes('SECRET SCAN'));
  });

  // Regression: the scanner must NEVER echo the matched secret VALUE into output.
  test('never echoes the secret value itself into output', () => {
    const out = writeScan('config.js', `const key = "${KEY}";`);
    assert.ok(out.includes('SECRET SCAN'), 'sanity: it should have flagged');
    assert.ok(!out.includes(KEY), 'the raw secret value must not appear in output');
  });

  // Identity numbers. A secret scanner matches key SHAPES; a tax ID or bank code is
  // not a key, so it needs its own patterns. All values below are made up.
  test('ID: flags an Indian PAN-shaped value', () => {
    assert.ok(writeScan('notes.md', 'Taxpayer PAN: ABCDE1234F\n').includes('[indian-pan]'));
  });
  test('ID: ignores a lowercase PAN-shaped string (identity numbers are upper case)', () => {
    assert.strictEqual(writeScan('notes.md', 'hash abcde1234f\n').trim(), '');
  });
  test('ID: flags an IFSC-shaped bank code', () => {
    assert.ok(writeScan('notes.md', 'Branch IFSC ABCD0123456\n').includes('[ifsc]'));
  });
  test('ID: flags a 12-digit ID next to its keyword, with an "n" between them', () => {
    // "number:" puts the letter n between keyword and digits. A [^0-9\n] class on
    // BSD grep excludes the LETTER n and silently misses this line.
    assert.ok(writeScan('notes.md', 'PRAN number: 1234 5678 9012\n').includes('[id-12-digit]'));
  });
  test('ID: ignores a bare 12-digit number with no identity keyword', () => {
    assert.strictEqual(writeScan('data.csv', 'order,123456789012\n').trim(), '');
  });
  test('ID: never echoes the identity value into output', () => {
    const out = writeScan('notes.md', 'Taxpayer PAN: ABCDE1234F\n');
    assert.ok(out.includes('[indian-pan]'), 'sanity: it should have flagged');
    assert.ok(!out.includes('ABCDE1234F'), 'the raw value must not appear in output');
  });
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
