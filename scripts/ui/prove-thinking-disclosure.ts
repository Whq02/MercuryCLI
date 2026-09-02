import { readFileSync } from 'node:fs';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const message = readFileSync('src/components/Message.tsx', 'utf8');
const messages = readFileSync('src/components/Messages.tsx', 'utf8');
const thinkingCmp = readFileSync('src/components/messages/AssistantThinkingMessage.tsx', 'utf8');

const thinkingCase = message.slice(
  message.indexOf('case "thinking":'),
  message.indexOf('case "server_tool_use":'),
);
check(
  'Message.tsx thinking case exists',
  thinkingCase.length > 0 && thinkingCase.includes('<AssistantThinkingMessage'),
);
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
  /\}, \[tools, verbose(, [A-Za-z]+)*\]\);/.test(messages.slice(messages.indexOf('const isItemClickable'))),
);

check(
  'row verbose merges the per-message expandedKeys toggle',
  messages.includes('verbose={verbose || isItemExpanded(msg_8)'),
);
check(
  'expandKey falls back to uuid (per-row identity for thinking)',
  messages.includes('?? msg.uuid'),
);

check(
  'collapsed branch renders the disclosure cue',
  thinkingCmp.includes('<CtrlOToExpand />'),
);
check(
  'AssistantThinkingMessage subscribes the accent (useSessionAccent)',
  thinkingCmp.includes('useSessionAccent().accent') && !thinkingCmp.includes('getSessionAccent'),
);

process.exit(fail);
