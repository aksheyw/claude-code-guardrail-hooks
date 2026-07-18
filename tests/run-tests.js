#!/usr/bin/env node
'use strict';

// Zero-dependency smoke tests for the four hooks. Run with: node tests/run-tests.js
// Two styles: (1) unit tests against the exported functions (pause-guard, config-protection),
// (2) integration tests that spawn the script with piped stdin (capture-subagent-output,
// secret-scan-postwrite.sh), since those have no meaningful exports to unit-test.

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

// ── pause-guard.js ──────────────────────────────────────────────────────────
console.log('pause-guard.js');
{
  const { classify } = require(path.join(HOOKS_DIR, 'pause-guard.js'));
  const limits = { effort: 1000, hard: 280 };

  test('fires on an explicit effort-adequacy question', () => {
    assert.strictEqual(classify('is medium good enough for this?', limits), 'effort');
  });

  test('fires on "bump you to high"', () => {
    assert.strictEqual(classify('can you bump you to high for this one', limits), 'effort');
  });

  test('does NOT fire on work-sense "effort" (effort tracker)', () => {
    assert.strictEqual(classify('update the effort tracker for this sprint', limits), null);
  });

  test('does NOT fire on "too much effort to maintain"', () => {
    assert.strictEqual(classify('this abstraction is too much effort to maintain', limits), null);
  });

  test('fires on a bare "stop"', () => {
    assert.strictEqual(classify('stop.', limits), 'hard');
  });

  test('does NOT fire on "stop the server"', () => {
    assert.strictEqual(classify('please stop the server first', limits), null);
  });

  test('fires on "wait"', () => {
    assert.strictEqual(classify('wait', limits), 'hard');
  });

  test('does NOT fire on "wait for the build"', () => {
    assert.strictEqual(classify('wait for the build to finish', limits), null);
  });

  test('negation override wins ("keep going")', () => {
    assert.strictEqual(classify('stop overthinking this, keep going', limits), null);
  });

  test('does NOT fire on the pause-guard feature name itself', () => {
    assert.strictEqual(classify('can you explain how the pause-guard hook works', limits), null);
  });
}

// ── config-protection.js ────────────────────────────────────────────────────
console.log('config-protection.js');
{
  const { run } = require(path.join(HOOKS_DIR, 'config-protection.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-protect-'));

  test('blocks editing an EXISTING .eslintrc.js', () => {
    const target = path.join(tmp, '.eslintrc.js');
    fs.writeFileSync(target, 'module.exports = {}');
    const result = run(JSON.stringify({ tool_input: { file_path: target } }));
    assert.strictEqual(result.exitCode, 2);
  });

  test('allows creating a NEW .eslintrc.js (no existing file)', () => {
    const target = path.join(tmp, 'fresh', '.eslintrc.js');
    const result = run(JSON.stringify({ tool_input: { file_path: target } }));
    assert.strictEqual(result.exitCode, 0);
  });

  test('allows editing an unrelated source file', () => {
    const target = path.join(tmp, 'index.js');
    const result = run(JSON.stringify({ tool_input: { file_path: target } }));
    assert.strictEqual(result.exitCode, 0);
  });

  test('fails closed on a truncated payload', () => {
    const result = run('{"tool_input"', { truncated: true });
    assert.strictEqual(result.exitCode, 2);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── capture-subagent-output.js (integration) ───────────────────────────────
console.log('capture-subagent-output.js');
{
  function runCapture(payload, homeDir) {
    return execFileSync('node', [path.join(HOOKS_DIR, 'capture-subagent-output.js')], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: homeDir, CAPTURE_HOOK_DISABLED: '' },
      encoding: 'utf8',
    });
  }

  test('captures a substantial Task output to a file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    const longText = 'x'.repeat(900);
    runCapture(
      {
        tool_name: 'Task',
        tool_input: { subagent_type: 'test-agent', description: 'a test run' },
        tool_response: longText,
        cwd: '/tmp/some-project',
      },
      home
    );
    const dir = path.join(home, '.claude', 'agent-outputs');
    assert.ok(fs.existsSync(dir), 'agent-outputs dir should be created');
    const project = fs.readdirSync(dir)[0];
    const date = fs.readdirSync(path.join(dir, project))[0];
    const files = fs.readdirSync(path.join(dir, project, date));
    assert.ok(files.length === 1, 'exactly one capture file expected');
    const content = fs.readFileSync(path.join(dir, project, date, files[0]), 'utf8');
    assert.ok(content.includes(longText), 'captured file should contain the output text');
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('does NOT capture a short output (below MIN_CHARS)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ tool_name: 'Task', tool_response: 'too short' }, home);
    const dir = path.join(home, '.claude', 'agent-outputs');
    assert.ok(!fs.existsSync(dir), 'no capture dir should exist for short output');
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('does NOT capture a non-subagent tool', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    runCapture({ tool_name: 'Bash', tool_response: 'x'.repeat(900) }, home);
    const dir = path.join(home, '.claude', 'agent-outputs');
    assert.ok(!fs.existsSync(dir), 'no capture dir should exist for a non-subagent tool');
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('kill switch CAPTURE_HOOK_DISABLED=1 skips capture', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-home-'));
    execFileSync('node', [path.join(HOOKS_DIR, 'capture-subagent-output.js')], {
      input: JSON.stringify({ tool_name: 'Task', tool_response: 'x'.repeat(900) }),
      env: { ...process.env, HOME: home, CAPTURE_HOOK_DISABLED: '1' },
      encoding: 'utf8',
    });
    const dir = path.join(home, '.claude', 'agent-outputs');
    assert.ok(!fs.existsSync(dir), 'kill switch should prevent capture');
    fs.rmSync(home, { recursive: true, force: true });
  });
}

// ── secret-scan-postwrite.sh (integration) ─────────────────────────────────
console.log('secret-scan-postwrite.sh');
{
  function runScan(filePath) {
    return execFileSync('bash', [path.join(HOOKS_DIR, 'secret-scan-postwrite.sh')], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      encoding: 'utf8',
    });
  }

  test('flags a hardcoded OpenAI-style key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
    const target = path.join(tmp, 'config.js');
    fs.writeFileSync(target, `const key = "sk-${'a'.repeat(40)}";`);
    const out = runScan(target);
    assert.ok(out.includes('SECRET SCAN'), 'expected a secret-scan warning');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('stays silent on a clean file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
    const target = path.join(tmp, 'index.js');
    fs.writeFileSync(target, 'const greeting = "hello world";\n');
    const out = runScan(target);
    assert.strictEqual(out.trim(), '', 'expected no output for a clean file');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('does NOT flag a proper env-var reference', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
    const target = path.join(tmp, 'config.js');
    fs.writeFileSync(target, 'const apiKey = process.env.OPENAI_API_KEY;\n');
    const out = runScan(target);
    assert.strictEqual(out.trim(), '', 'expected no output for an env-var reference');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
