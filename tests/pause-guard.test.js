#!/usr/bin/env node
'use strict';
/**
 * Case suite for hooks/pause-guard.js (the 2026-11-19 halt-shape fix).
 *
 * Three groups:
 *   - TRIAL: 25 labelled cases from the trial that found the false blocks.
 *   - REPLAY: one case per message the old hook fired on in 30 days of real use
 *     (28 fires). Every one is a PARAPHRASE: it keeps the shape that made the hook
 *     fire (word order, halt word, punctuation, quote markers) and none of the
 *     original wording, names or projects. Replay index in the name, e.g. R4.
 *   - EXTRA: cases added with the fix, so it does not overfit the trial.
 *
 * expect: 'fire' = must block, 'silent' = must pass, 'either' = arguable,
 * reported but not scored.
 *
 * Run: node tests/pause-guard.test.js [path-to-hook]
 * Exit 0 only when every scored case passes.
 */
const path = require('path');
const hookPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'hooks', 'pause-guard.js'));
const { classify } = require(hookPath);
const LIM = { effort: 1000, hard: 280 };

const cases = [
  // ── TRIAL: must fire ──
  ['TRIAL', 'is medium good enough for this?', 'fire'],
  ['TRIAL', 'should I bump you to high?', 'fire'],
  ['TRIAL', 'raise your effort', 'fire'],
  ['TRIAL', 'is this too low effort for this task?', 'fire'],
  ['TRIAL', 'stop', 'fire'],
  ['TRIAL', 'wait', 'fire'],
  ['TRIAL', 'hold on', 'fire'],
  ['TRIAL', 'pause', 'fire'],
  ['TRIAL', "Stop. That's wrong.", 'fire'],
  ['TRIAL', "wait, don't send that", 'fire'],
  // ── TRIAL: must pass ──
  ['TRIAL', 'stop the server', 'silent'],
  ['TRIAL', 'wait for the build to finish then check', 'silent'],
  ['TRIAL', 'the effort tracker is broken', 'silent'],
  ['TRIAL', "don't pause, keep going", 'silent'],
  ['TRIAL', 'stay on medium', 'silent'],
  ['TRIAL', 'Users must wait 3 days before a refund is issued.', 'silent'],
  ['TRIAL', 'The Stop button on the player should be red.', 'silent'],
  ['TRIAL', 'When the timer ends, the session should stop.', 'silent'],
  ['TRIAL', 'Set effort to high for the API story in Jira.', 'silent'],
  ['TRIAL', 'Is medium priority enough for this bug?', 'silent'],
  ['TRIAL', 'Should we raise the effort on onboarding next quarter?', 'silent'],
  ['TRIAL', 'What happens if the user hits stop mid-upload?', 'silent'],
  ['TRIAL', 'Wait time on the support queue is 4 minutes; add it to the spec.', 'silent'],
  ['TRIAL', 'wait, also add the refund flow to the spec', 'either'],
  ['TRIAL', 'Can you stop and think about edge cases first?', 'either'],

  // ── REPLAY (paraphrased real fires) ──
  ['R0 pause a real-world thing', 'pause the weekly digest email right now since the launch moved', 'silent'],
  ['R1 pasted blockquote', '<!-- reply 1 -->\n> Quota is back. So I lifted the pause, and the jobs are running again.\n\nthat is wrong', 'silent'],
  ['R2 effort already set', "Yes, add the DNS record. I've set effort to high.", 'silent'],
  ['R3 quoted question', 'Indexing is next. It needs one config change first, so I’ll pause for HIGH effort and your go-ahead first.--> do this now?', 'either'],
  ['R4 wait for someone', 'Plan approved, but wait; do step one with the flag after the reviewer replies.', 'fire'],
  ['R5 pause a workflow', '1. Now: pause the sync job. Nothing uses it, and one click turns it back on. yes pause it then\n Later: add the check across the endpoints. do it now', 'silent'],
  ['R6 stop and move on', 'Yes, stop and move on', 'silent'],
  ['R7 wait + question', 'wait why is this charging me twice?', 'fire'],
  ['R8 halt', 'No, stop here', 'fire'],
  ['R9 wait + question', 'wait r u uploading the big file or not?', 'fire'],
  ['R10 halt', 'wait', 'fire'],
  ['R11 halt', 'pause', 'fire'],
  ['R12 effort already raised', "Yes to option B as proposed. I've raised effort to high. Draft it by tomorrow.", 'silent'],
  ['R13 halt', 'Yes, wait', 'fire'],
  ['R14 topic: waiting to buy', 'between the two vendors its fine to wait a few days right', 'silent'],
  ['R15 i will wait, keep going', "ok i'll wait, keep the stock alert running in case it runs out", 'silent'],
  ['R16 topic', 'Open for you: a yes on item 3, so it goes in the next release.\nwhy drop it right now we have to stop how to get the filter option back somehow', 'silent'],
  ['R17 wants wrap-up work', 'lets pause and wrap up tonight and start fresh tomorrow', 'silent'],
  ['R18 halt addressed to me', 'no you need to stop for now, i want to save quota what about running it on the other account instead?', 'fire'],
  ['R19 send a stop', 'send the stop', 'silent'],
  ['R20 quoted effort request', '<!-- reply 1 -->\n> Please drop me to MEDIUM for now. Raise me to HIGH again before the deploy.\n\nyou are on medium', 'silent'],
  ['R21 finish tasks first', 'sure this session is about half used so we finish current tasks and then u pause me to go to low and start wrapping up', 'silent'],
  ['R22 effort decision pending', '. Effort: switch me to HIGH now to deploy the fix, then back to MEDIUM for\n     the smaller fixes. Or I do those first and deploy this\n     afterwards.go u r on high now\n\n  2. The three headings already written: shall I correct them?', 'fire'],
  ['R23 quoted effort request', "Nav bar: may I fix it? I'd add a short menu. It's a live change, so\n     please switch me to high effort first.--> u r on high effort, but show me the options first and explain each step", 'either'],
  ['R24 fix, pause before applying', 'Yes. Fix the 6 page headings as listed. Pause for HIGH before applying.', 'silent'],
  ['R25 stop processes', 'Stop them', 'silent'],
  ['R26 halt', 'pause', 'fire'],
  ['R27 topic: personal decision', 'shud i wait till monday to reply? they might ask? or shud we rephrase', 'silent'],

  // ── EXTRA: true halts and effort questions that must still fire ──
  ['EXTRA', 'Stop!', 'fire'],
  ['EXTRA', 'STOP', 'fire'],
  ['EXTRA', 'stop now', 'fire'],
  ['EXTRA', 'please stop', 'fire'],
  ['EXTRA', 'just stop', 'fire'],
  ['EXTRA', "stop, that's the wrong file", 'fire'],
  ['EXTRA', "stop what you're doing", 'fire'],
  ['EXTRA', 'ok pause here', 'fire'],
  ['EXTRA', 'pause for now', 'fire'],
  ['EXTRA', 'wait!', 'fire'],
  ['EXTRA', 'wait what?', 'fire'],
  ['EXTRA', 'wait, why did you delete that?', 'fire'],
  ['EXTRA', 'hmm wait', 'fire'],
  ['EXTRA', 'hold on, let me check something', 'fire'],
  ['EXTRA', 'hold up', 'fire'],
  ['EXTRA', 'you should stop here', 'fire'],
  ['EXTRA', 'do you want me to change your effort?', 'fire'],
  ['EXTRA', 'is max overkill here?', 'fire'],
  ['EXTRA', 'should we switch you to high for this?', 'fire'],
  ['EXTRA', 'what reasoning effort do you need for this?', 'fire'],
  ['EXTRA', 'is medium enough or should I go to max?', 'fire'],
  ['EXTRA', 'is medium good enough for this bug?', 'fire'],
  // ── EXTRA: ordinary PM / product lines that must pass ──
  ['EXTRA', 'Users should be able to stop a recording at any time.', 'silent'],
  ['EXTRA', 'Add a pause button to the player.', 'silent'],
  ['EXTRA', 'The checkout should wait for payment confirmation.', 'silent'],
  ['EXTRA', 'Customers wait an average of 4 minutes.', 'silent'],
  ['EXTRA', 'If the API times out, stop retrying after 3 attempts.', 'silent'],
  ['EXTRA', 'Stop words should be removed from the search index.', 'silent'],
  ['EXTRA', 'Wait times above 5 minutes trigger an alert.', 'silent'],
  ['EXTRA', 'Pause/resume should keep the cart.', 'silent'],
  ['EXTRA', 'Controls: play, pause, stop.', 'silent'],
  ['EXTRA', 'When should the job pause?', 'silent'],
  ['EXTRA', 'Rename the "Stop" label to "End".', 'silent'],
  ["EXTRA", "Add a 'hold on' message to the phone menu.", 'silent'],
  ['EXTRA', 'Story points measure effort, not time.', 'silent'],
  ["EXTRA", "What's the effort estimate for the login story?", 'silent'],
  ['EXTRA', 'Is high priority enough for this incident?', 'silent'],
  ['EXTRA', 'Is medium severity right for this ticket?', 'silent'],
  ['EXTRA', 'Should the team put more effort into retention?', 'silent'],
  ['EXTRA', 'The session should pause when the app goes to the background.', 'silent'],
  ['EXTRA', 'Put the order on hold until payment clears.', 'silent'],
  ['EXTRA', 'non-stop retries are a bug', 'silent'],
];

let pass = 0, fail = 0, either = 0;
for (const [src, text, expect] of cases) {
  const got = classify(text, LIM);
  const fired = got != null;
  const label = `${src}: ${JSON.stringify(text.length > 70 ? text.slice(0, 70) + '…' : text)}`;
  if (expect === 'either') {
    either++;
    console.log(`  ARGUABLE ${fired ? 'fire  ' : 'silent'} ${label}`);
    continue;
  }
  const ok = (expect === 'fire') === fired;
  if (ok) pass++; else fail++;
  const verdict = ok ? 'PASS' : expect === 'fire' ? 'MISS' : 'FALSE-BLOCK';
  console.log(`  ${verdict.padEnd(11)} expect=${expect.padEnd(6)} ${label}${fired ? ` [${got}]` : ''}`);
}

// Kill switch and fail-open, through decide().
const { decide } = require(hookPath);
const fs = require('fs');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-'));
const tf = path.join(tmp, 't.jsonl');
fs.writeFileSync(tf, JSON.stringify({ type: 'user', message: { role: 'user', content: 'stop' } }) + '\n');
const mech = [
  ['decide blocks a bare stop', () => decide({ transcript_path: tf }).exitCode === 2],
  ['kill switch allows', () => {
    process.env.PAUSE_GUARD_DISABLED = '1';
    try { return decide({ transcript_path: tf }).exitCode === 0; } finally { delete process.env.PAUSE_GUARD_DISABLED; }
  }],
  ['missing transcript fails open', () => decide({ transcript_path: path.join(tmp, 'nope.jsonl') }).exitCode === 0],
  ['no transcript path fails open', () => decide({}).exitCode === 0],
];
for (const [name, fn] of mech) {
  let ok = false;
  try { ok = fn(); } catch { ok = false; }
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}        ${name}`);
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed (${either} arguable, not scored) — ${hookPath}`);
process.exit(fail ? 1 : 0);
