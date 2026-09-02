// prove-thinking-disclosure — finalized thinking rows are visible + honestly
// expandable in place.
//
// The bug class (two defects stacked):
//   a. Message.tsx nulled finalized thinking rows whenever !isTranscriptMode &&
//      !verbose — the reasoning was silently unreachable in the default view
//      (no cue, no row), and AssistantThinkingMessage's collapsed
//      `∴ Thinking ⌄` branch was DEAD CODE.
//   b. Even if it had rendered, Messages.tsx never classified thinking rows
//      clickable, so the ⌄ disclosure cue would have lied (the dead-toggle
//      class from the click-expand pass).
//
// Contract proven here:
//   1. Message.tsx's thinking case no longer returns null pre-dispatch (the
//      collapsed row renders); redacted_thinking keeps its null (nothing to
//      reveal — a cue there would be a dead toggle).
//   2. Messages.tsx classifies first-block thinking rows clickable, gated on
//      !verbose (global verbose already reveals all — no dead toggle) and on
//      non-empty thinking text (empty renders null).
//   3. The per-row expand path is the existing expandedKeys verbose merge.
//   4. AssistantThinkingMessage subscribes the session accent (live re-tint).
import { readFileSync } from 'node:fs';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const message = readFileSync('src/components/Message.tsx', 'utf8');
const messages = readFileSync('src/components/Messages.tsx', 'utf8');
const thinkingCmp = readFileSync('src/components/messages/AssistantThinkingMessage.tsx', 'utf8');

// ── 1. dispatch renders the row (no silent drop) ────────────────────────────
const thinkingCase = message.slice(
  message.indexOf('case "thinking":'),
  message.indexOf('case "server_tool_use":'),
);
check(
  'Message.tsx thinking case exists',
  thinkingCase.length > 0 && thinkingCase.includes('<AssistantThinkingMessage'),
);
// The ONE null-return in the case is the provider-uniform ruling: a GPT
// turn's reasoning summaries never paint the in-chat expander outside the
// reveal modes (LiveStreamingTail owns the quiet-stream line). A Claude
// thinking row is never nulled out of the default view.
const thinkingNulls = thinkingCase.match(/return null/g) ?? [];
check(
  'thinking rows are never nulled out of the default view (the only null-return is the OpenAI-route ruling)',
  thinkingNulls.length === 1 &&
    /declaredRouteOf\(servedModel\) === 'openai' &&\s*!isTranscriptMode &&\s*!verbose\s*\) \{[\s\S]{0,400}return null/.test(thinkingCase),
  `null-returns=${thinkingNulls.length} — a bare !isTranscriptMode && !verbose null-return makes Claude reasoning unreachable`,
);
const redactedCase = message.slice(
  message.indexOf('case "redacted_thinking":'),
  message.indexOf('case "thinking":'),
);
check(
  'redacted_thinking keeps its null (no dead disclosure cue)',
  redactedCase.includes('return null'),
);

// ── 2. clickable classification ─────────────────────────────────────────────
const clickableStart = messages.indexOf('const isItemClickable = useCallback');
const clickableBody = messages.slice(clickableStart, messages.indexOf('const canAnimate', clickableStart));
check('isItemClickable found', clickableStart >= 0);
check(
  'first-block thinking rows classified clickable',
  clickableBody.includes("first?.type === 'thinking'"),
);
check(
  'gated on !verbose (no dead toggle under global verbose)',
  /!verbose && typeof first\.thinking === 'string'/.test(clickableBody),
);
check(
  'gated on non-empty thinking text',
  clickableBody.includes('first.thinking.trim().length > 0'),
);
check(
  'isItemClickable deps include verbose (classification tracks the live flag)',
  // The law is VERBOSE-IN-THE-DEPS, not a frozen array literal — the agent
  // fold legitimately added agentFoldHidden alongside it.
  /\}, \[tools, verbose(, [A-Za-z]+)*\]\);/.test(messages.slice(messages.indexOf('const isItemClickable'))),
);

// ── 3. per-row expand path unchanged ────────────────────────────────────────
check(
  'row verbose merges the per-message expandedKeys toggle',
  messages.includes('verbose={verbose || isItemExpanded(msg_8)'),
);
check(
  'expandKey falls back to uuid (per-row identity for thinking)',
  messages.includes('?? msg.uuid'),
);

// ── 4. collapsed cue + live accent in the component ─────────────────────────
check(
  'collapsed branch renders the disclosure cue',
  thinkingCmp.includes('<CtrlOToExpand />'),
);
check(
  'AssistantThinkingMessage subscribes the accent (useSessionAccent)',
  thinkingCmp.includes('useSessionAccent().accent') && !thinkingCmp.includes('getSessionAccent'),
);

process.exit(fail);
