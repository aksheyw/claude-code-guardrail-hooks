# Changelog

## 2026-11-25: pause-guard blocks a halt, not a word

**The problem.** `pause-guard` blocked tool calls whenever a message contained "stop", "wait" or "pause" in most positions. Ordinary sentences tripped it, such as "Users must wait 3 days before a refund" or "pause the weekly email". In 30 days of the author's own use it fired 28 times. 16 of those were wrong, 10 were real halts, and 2 were arguable.

**The fix, in four parts.**

1. **Halt shape, not halt word.** The word must open a clause, or be addressed to the assistant ("you need to stop", "can you pause"). Then it must be followed by nothing, punctuation, or a short list ("now", "here", "for now"). For "wait" and "hold on", a question word also counts, so "wait, why did you delete that?" still blocks. "stop them" or "pause the job" do not.
2. **Quoted text is ignored.** Blockquote lines, HTML comments and quoted spans are removed before matching. Pasted text that mentions a pause no longer blocks.
3. **Work-sense effort is skipped.** "Set effort to high for the API story in Jira" and "Is medium priority enough?" are about work, not the model. Direct phrasing ("your effort", "reasoning effort", "bump you to high") always counts.
4. **"I've set effort to high" is a go-ahead**, not an open question.

The kill switch, fail-open behaviour and subagent skip are unchanged. The length limits (280 characters for a halt, 1,000 for an effort question) now count only the text left after quoted text is removed. So a halt typed under a long pasted quote still blocks.

Comments (`<!-- -->`) are removed in linear time. A regex did this at first, and a review found it could take about 24 seconds on a 1 MB message full of unclosed `<!--`. The replacement gives the same result on 300,000 random test strings and takes a few milliseconds.

**Tests.** New `tests/pause-guard.test.js`: 95 scored cases (91 phrases plus 4 kill-switch and fail-open checks) and 4 arguable ones. The fixed hook passes 95 of 95. The previous hook passes 65, with 30 false blocks and no misses. The 28 replay cases are paraphrases that keep the shape of each real message, not its wording. The existing `tests/run-tests.js` still passes 73 of 73.

On the 30 days of real messages, the fixed hook keeps all 10 real halts and drops all 16 false blocks. It makes no new blocks the old hook did not make.

**Caveat.** The fix was tuned on the same 30 days of messages it was scored on, so that result is in-sample. The extra cases were also written by the author. A fresh month of use is the honest test. Recall beyond the old hook is unmeasured.

**Known limits, found in review and left for the fresh-month test.** Each case below changed from the old hook. Tuning them on made-up cases risks bringing the false blocks back.

- A halt followed by words not on the list now passes: "Hold on until I check.", "Please pause while I verify the diff."
- "Stop, I need to play back the recording." passes, because "play" next to "stop" reads as media controls.
- A "Stop." can be hidden when an inch mark or a possessive apostrophe looks like a quote: `The monitor is 27". Stop. The button says "Delete".`
- Work words can hide an effort question: "Is medium good enough for this Jira ticket?"
- "I've set effort to high" hides a second, separate effort question in the same message.
- One new false block: "If you need to pause, record the reason in the log."
