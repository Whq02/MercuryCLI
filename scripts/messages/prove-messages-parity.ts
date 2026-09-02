// scripts/messages/prove-messages-parity.ts — the R2 golden-replay parity
// oracle for src/utils/messages.ts.
//
// CLAIM: for a fixed synthetic corpus, every covered export produces output
// deeply equal (modulo uuid/timestamp identity-preserving normalization) to
// the committed goldens recorded from the PRE-REWRITE module. The rewrite
// must keep this green — same path, same export names, same behavior.
//
//   bun run scripts/messages/prove-messages-parity.ts --record   # regenerate goldens
//   bun run scripts/messages/prove-messages-parity.ts            # verify (the gate)
//
// Coverage is accounted honestly: exports are COVERED (golden-replayed),
// SKIPPED (stateful/stream/env-coupled — listed with reasons), or TYPE-ONLY.
// A new value export that is neither covered nor skip-listed FAILS the run —
// the harness can never silently under-cover a growing surface.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../../src/utils/messages.ts';
import { CORPUS, COMPOSITE, TOOLS_FIXTURE } from './fixtures.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(HERE, 'goldens.json');
const RECORD = process.argv.includes('--record');

// ── stable serializer ───────────────────────────────────────────────────────
// UUID-shaped strings and ISO timestamps are normalized through first-seen
// maps («u1», «t1», …) so self-generated ids stay stable across runs while
// IDENTITY RELATIONS (same uuid referenced twice) are preserved exactly.
const UUID_SUB_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_SUB_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g;

function makeNormalizer() {
  const uuids = new Map<string, string>();
  const times = new Map<string, string>();
  // Normalize uuid/ISO-timestamp SUBSTRINGS anywhere inside strings (synthetic
  // texts embed generated ids), first-seen numbered so identity relations hold.
  const normScalar = (v: unknown): unknown => {
    // JSON.stringify silently DROPS function/symbol-valued keys — several
    // "constants" are message BUILDERS; snapshot their arity instead.
    if (typeof v === 'function') return `«fn/${(v as { length: number }).length}»`;
    if (typeof v === 'symbol') return `«symbol:${String(v)}»`;
    if (typeof v === 'bigint') return `«bigint:${v}»`;
    if (typeof v !== 'string') return v;
    return v
      .replace(UUID_SUB_RE, m => {
        const k = m.toLowerCase();
        if (!uuids.has(k)) uuids.set(k, `«u${uuids.size + 1}»`);
        return uuids.get(k)!;
      })
      .replace(ISO_SUB_RE, m => {
        // Pinned fixture timestamps (authored 2026-01-01T00:…) keep first-seen
        // numbering (their ordering is meaningful). Self-generated wall-clock
        // timestamps flatten to a constant: same-millisecond collisions would
        // otherwise make the first-seen numbering vary run to run.
        if (!m.startsWith('2026-01-01T00:')) return '«ts»';
        if (!times.has(m)) times.set(m, `«t${times.size + 1}»`);
        return times.get(m)!;
      });
  };
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return normScalar(v);
    if (Array.isArray(v)) return v.map(norm);
    if (v instanceof Map) {
      return {
        '«map»': [...v.entries()]
          .map(([k, val]) => [norm(k), norm(val)])
          .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))),
      };
    }
    if (v instanceof Set) {
      return { '«set»': [...v].map(norm).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined || typeof val === 'function') continue;
      out[k] = norm(val);
    }
    return out;
  };
  return norm;
}

const snap = (fn: () => unknown): unknown => {
  const norm = makeNormalizer();
  try {
    const v = norm(fn());
    // undefined must survive JSON round-tripping or verify-time key accounting
    // silently diverges from the recorded file.
    return v === undefined ? '«undefined»' : v;
  } catch (e) {
    return { '«throws»': e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
};

// deep-clone fixture inputs per case so mutating exports can't cross-pollute.
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ── the case matrix ─────────────────────────────────────────────────────────
const cases: Record<string, () => unknown> = {};
const covered = new Set<string>();
const add = (exportName: string, caseName: string, fn: () => unknown) => {
  covered.add(exportName);
  cases[`${exportName}/${caseName}`] = fn;
};

// Constants — snapshot directly.
for (const c of [
  'INTERRUPT_MESSAGE',
  'INTERRUPT_MESSAGE_FOR_TOOL_USE',
  'CANCEL_MESSAGE',
  'REJECT_MESSAGE',
  'REJECT_MESSAGE_WITH_REASON_PREFIX',
  'SUBAGENT_REJECT_MESSAGE',
  'SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX',
  'PLAN_REJECTION_PREFIX',
  'DENIAL_WORKAROUND_GUIDANCE',
  'AUTO_REJECT_MESSAGE',
  'DONT_ASK_REJECT_MESSAGE',
  'NO_RESPONSE_REQUESTED',
  'SYNTHETIC_TOOL_RESULT_PLACEHOLDER',
  'SYNTHETIC_MODEL',
  'SYNTHETIC_MESSAGES',
  'EMPTY_LOOKUPS',
  'EMPTY_STRING_SET',
  'PLAN_PHASE4_CONTROL',
] as const) {
  add(c, 'value', () => (M as Record<string, unknown>)[c]);
}

// Transforms over every corpus entry + the composite.
const allFixtures: Array<[string, () => unknown[]]> = [
  ...Object.entries(CORPUS).map(
    ([name, msgs]) => [name, () => clone(msgs)] as [string, () => unknown[]],
  ),
  ['composite', () => clone(COMPOSITE)],
];
const perFixture = (exportName: string, run: (msgs: never[]) => unknown) => {
  for (const [fixName, get] of allFixtures) {
    add(exportName, fixName, () => run(get() as never[]));
  }
};

perFixture('normalizeMessages', m => M.normalizeMessages(m));
perFixture('normalizeMessagesForAPI', m => M.normalizeMessagesForAPI(m, TOOLS_FIXTURE as never));
perFixture('reorderMessagesInUI', m =>
  M.reorderMessagesInUI(M.normalizeMessages(m) as never, [] as never),
);
perFixture('reorderAttachmentsForAPI', m => M.reorderAttachmentsForAPI(m));
perFixture('filterUnresolvedToolUses', m => M.filterUnresolvedToolUses(m));
perFixture('filterWhitespaceOnlyAssistantMessages', m => M.filterWhitespaceOnlyAssistantMessages(m));
perFixture('filterOrphanedThinkingOnlyMessages', m => M.filterOrphanedThinkingOnlyMessages(m));
perFixture('stripSignatureBlocks', m => M.stripSignatureBlocks(m));
perFixture('stripAdvisorBlocks', m => M.stripAdvisorBlocks(m as never));
// unsigned (foreign-provider) thinking drops before an
// Anthropic request; behavioural pins live in scripts/model-routing/prove-behaviour-
// contract.ts §5 — this row keeps the golden-parity census total.
perFixture('stripUnsignedThinkingBlocks', m => M.stripUnsignedThinkingBlocks(m as never));
perFixture('ensureToolResultPairing', m =>
  M.ensureToolResultPairing(
    (m as { type: string }[]).filter(x => x.type === 'user' || x.type === 'assistant') as never,
  ),
);
// The wire-side wrapper the non-Anthropic dispatch seams call: filter to
// walkable rows + the pairing repair (the stopped-mid-turn switch class).
perFixture('healWalkableForWire', m => M.healWalkableForWire(m as never));
// Every round replays in the assistant's own tool_use order (the last pass
// of the wire heal and the Anthropic stream core's request assembly);
// behavioural pins live in scripts/messages/prove-wire-heal-truth.ts §O.
perFixture('orderToolResultsByUse', m => M.orderToolResultsByUse(M.healWalkableForWire(m as never)));
// The shared foreign-thinking predicate (planner ≡ codec truth).
add('isUnsignedThinkingBlock', 'unsigned-empty-sig', () =>
  M.isUnsignedThinkingBlock({ type: 'thinking', thinking: 't', signature: '' } as never),
);
add('isUnsignedThinkingBlock', 'unsigned-missing-sig', () =>
  M.isUnsignedThinkingBlock({ type: 'thinking', thinking: 't' } as never),
);
add('isUnsignedThinkingBlock', 'signed', () =>
  M.isUnsignedThinkingBlock({ type: 'thinking', thinking: 't', signature: 'sig-1' } as never),
);
add('isUnsignedThinkingBlock', 'non-thinking', () =>
  M.isUnsignedThinkingBlock({ type: 'text', text: 't' } as never),
);
perFixture('buildMessageLookups', m => M.buildMessageLookups(M.normalizeMessages(m) as never, m));
perFixture('buildSubagentLookups', m =>
  M.buildSubagentLookups(
    (M.normalizeMessages(m) as { type: string }[]).filter(
      x => x.type === 'user' || x.type === 'assistant',
    ) as never,
  ),
);
perFixture('getLastAssistantMessage', m => M.getLastAssistantMessage(m));
perFixture('hasToolCallsInLastAssistantTurn', m => M.hasToolCallsInLastAssistantTurn(m));
perFixture('getToolResultIDs', m => M.getToolResultIDs(m));
perFixture('getToolUseIDs', m => M.getToolUseIDs(m));
perFixture('countToolCalls', m => M.countToolCalls(m));
perFixture('hasSuccessfulToolCall', m => M.hasSuccessfulToolCall(m));
perFixture('findLastCompactBoundaryIndex', m => M.findLastCompactBoundaryIndex(m));
perFixture('getMessagesAfterCompactBoundary', m => M.getMessagesAfterCompactBoundary(m));
perFixture('hasUnresolvedHooks', m =>
  M.hasUnresolvedHooks(M.normalizeMessages(m) as never, 'toolu_0004' as never, 'PostToolUse' as never),
);
perFixture('wrapMessagesInSystemReminder', m =>
  M.wrapMessagesInSystemReminder(
    (m as { type: string }[]).filter(x => x.type === 'user') as never,
  ),
);

// Pairwise mergers — real (a, b) signatures over adjacent same-type pairs.
add('mergeUserMessages', 'pair', () => {
  const [a, b] = [clone(CORPUS.basic![0]), clone(CORPUS.synthetic![2])];
  return M.mergeUserMessages(a as never, b as never);
});
add('mergeAssistantMessages', 'pair', () => {
  const [a, b] = [clone(CORPUS.thinking![1]), clone(CORPUS.thinking![2])];
  return M.mergeAssistantMessages(a as never, b as never);
});
add('mergeUserMessagesAndToolResults', 'pair', () => {
  const text = clone(CORPUS.toolTurn![0]);
  const toolRes = clone(CORPUS.toolTurn![2]);
  return M.mergeUserMessagesAndToolResults(text as never, toolRes as never);
});

// Per-message / per-value exports over the composite's members.
const compositeMsgs = () => clone(COMPOSITE) as never[];
const perMessage = (exportName: string, run: (msg: never, i: number) => unknown) => {
  add(exportName, 'composite-map', () => compositeMsgs().map((m, i) => run(m, i)));
};
perMessage('isToolUseRequestMessage', m => M.isToolUseRequestMessage(m));
perMessage('isToolUseResultMessage', m => M.isToolUseResultMessage(m));
perMessage('isNotEmptyMessage', m => M.isNotEmptyMessage(m));
perMessage('isSyntheticMessage', m => M.isSyntheticMessage(m));
perMessage('isCompactBoundaryMessage', m => M.isCompactBoundaryMessage(m));
perMessage('isThinkingMessage', m => M.isThinkingMessage(m));
perMessage('isSystemLocalCommandMessage', m => M.isSystemLocalCommandMessage(m));
perMessage('shouldShowUserMessage', m => M.shouldShowUserMessage(m));
perMessage('getToolUseID', m => M.getToolUseID(m));
perMessage('deriveUUID', (_m, i) =>
  M.deriveUUID('00000000-0000-4000-8000-000000000099' as never, i),
);
perMessage('deriveShortMessageId', (_m, i) => M.deriveShortMessageId(`stable-input-${i}`));
perMessage('getAssistantMessageText', m => snapSafe(() => M.getAssistantMessageText(m)));
perMessage('getUserMessageText', m => snapSafe(() => M.getUserMessageText(m)));
add('stripToolReferenceBlocksFromUserMessage', 'toolTurn-user', () =>
  M.stripToolReferenceBlocksFromUserMessage(clone(CORPUS.toolTurn![2]) as never),
);
add('stripToolReferenceBlocksFromUserMessage', 'plain-user', () =>
  M.stripToolReferenceBlocksFromUserMessage(clone(CORPUS.basic![0]) as never),
);
add('stripCallerFieldFromAssistantMessage', 'toolTurn-assistant', () =>
  M.stripCallerFieldFromAssistantMessage(clone(CORPUS.toolTurn![1]) as never),
);
function snapSafe(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (e) {
    return { '«throws»': e instanceof Error ? e.message.slice(0, 120) : String(e) };
  }
}

// String/content helpers.
add('extractTag', 'basic', () => M.extractTag('<a>x</a><b>y</b>', 'b'));
add('extractTag', 'missing', () => M.extractTag('<a>x</a>', 'zzz'));
add('stripPromptXMLTags', 'basic', () =>
  M.stripPromptXMLTags('<system-reminder>inner</system-reminder> visible'),
);
// The analysis-scaffolding stripper: the tag block (and its trailing newline)
// goes; the surrounding text keeps its edges verbatim.
add('stripPromptXMLTagsKeepEdges', 'basic', () =>
  M.stripPromptXMLTagsKeepEdges('lead <commit_analysis>\nnotes\n</commit_analysis>\ntail'),
);
add('stripPromptXMLTagsKeepEdges', 'edges', () =>
  M.stripPromptXMLTagsKeepEdges('  <context>x</context>  kept <pr_analysis>y</pr_analysis>\n  '),
);
add('stripPromptXMLTagsKeepEdges', 'untouched', () =>
  M.stripPromptXMLTagsKeepEdges('<system-reminder>inner</system-reminder> visible'),
);
add('wrapInSystemReminder', 'basic', () => M.wrapInSystemReminder('remember this'));
add('wrapCommandText', 'basic', () => M.wrapCommandText('/foo args'));
add('formatCommandInputTags', 'basic', () =>
  M.formatCommandInputTags('/compact', 'focus the summary'),
);
add('isEmptyMessageText', 'empty', () => M.isEmptyMessageText(''));
add('isEmptyMessageText', 'placeholder', () =>
  M.isEmptyMessageText('(no content)'),
);
add('isEmptyMessageText', 'real', () => M.isEmptyMessageText('actual text'));
add('extractTextContent', 'blocks', () =>
  M.extractTextContent([{ type: 'text', text: 'block text' }, { type: 'image' }] as never),
);
add('extractTextContent', 'separator', () =>
  M.extractTextContent(
    [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] as never,
    ' | ',
  ),
);
add('getContentText', 'blocks', () =>
  M.getContentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] as never),
);
add('isClassifierDenial', 'yes', () =>
  M.isClassifierDenial(M.AUTO_REJECT_MESSAGE + ' extra'),
);
add('isClassifierDenial', 'no', () => M.isClassifierDenial('benign words'));
add('buildYoloRejectionMessage', 'basic', () =>
  M.buildYoloRejectionMessage('Bash', 'rm -rf /' as never),
);
add('buildFlowBlockDeclinedMessage', 'basic', () =>
  M.buildFlowBlockDeclinedMessage('rm -rf /'),
);
add('buildClassifierUnavailableMessage', 'basic', () =>
  M.buildClassifierUnavailableMessage('Bash' as never),
);
add('normalizeContentFromAPI', 'blocks', () =>
  M.normalizeContentFromAPI([{ type: 'text', text: 'x' }] as never, TOOLS_FIXTURE as never),
);
add('normalizeContentFromAPI', 'tool-use', () =>
  M.normalizeContentFromAPI(
    [{ type: 'tool_use', id: 'toolu_0031', name: 'Read', input: {} }] as never,
    TOOLS_FIXTURE as never,
  ),
);
add('mergeUserContentBlocks', 'basic', () =>
  M.mergeUserContentBlocks(
    [{ type: 'text', text: 'a' }] as never,
    [{ type: 'text', text: 'b' }] as never,
  ),
);
add('textForResubmit', 'composite', () => compositeMsgs().map(m => snapSafe(() => M.textForResubmit(m as never))));
add('prepareUserContent', 'no-blocks', () =>
  M.prepareUserContent({ inputString: 'hi', precedingInputBlocks: [] }),
);
add('prepareUserContent', 'with-blocks', () =>
  M.prepareUserContent({
    inputString: 'hi',
    precedingInputBlocks: [{ type: 'text', text: 'pre' }] as never,
  }),
);
add('withMemoryCorrectionHint', 'basic', () =>
  snapSafe(() => M.withMemoryCorrectionHint('base text' as never)),
);
add('normalizeAttachmentForAPI', 'todo', () =>
  snapSafe(() => M.normalizeAttachmentForAPI({ type: 'todo', itemCount: 1, context: 'x' } as never)),
);
const normalizedWithLookups = (msgs: unknown[]) => {
  const raw = clone(msgs) as never[];
  const normalized = M.normalizeMessages(raw as never) as never[];
  return { normalized, lookups: M.buildMessageLookups(normalized as never, raw) };
};
add('getSiblingToolUseIDs', 'toolTurn', () => {
  const raw = clone(CORPUS.toolTurn!) as never[];
  const normalized = M.normalizeMessages(raw as never) as never[];
  return (normalized as never[]).map(nm => M.getSiblingToolUseIDs(nm, raw as never));
});
add('getSiblingToolUseIDsFromLookup', 'toolTurn', () => {
  const { normalized, lookups } = normalizedWithLookups(CORPUS.toolTurn!);
  return normalized.map(nm => M.getSiblingToolUseIDsFromLookup(nm, lookups as never));
});
add('getProgressMessagesFromLookup', 'attachments', () => {
  const { normalized, lookups } = normalizedWithLookups(CORPUS.attachments!);
  return normalized.map(nm => M.getProgressMessagesFromLookup(nm, lookups as never));
});
add('hasUnresolvedHooksFromLookup', 'attachments', () => {
  const { lookups } = normalizedWithLookups(CORPUS.attachments!);
  return M.hasUnresolvedHooksFromLookup('toolu_0004', 'PostToolUse' as never, lookups as never);
});

// Factories (self-generated uuid/timestamp normalized by the serializer).
add('createAssistantMessage', 'text', () => M.createAssistantMessage({ content: 'hello' }));
add('createAssistantMessage', 'empty', () => M.createAssistantMessage({ content: '' }));
add('createAssistantAPIErrorMessage', 'basic', () =>
  M.createAssistantAPIErrorMessage({ content: 'boom' }),
);
add('createUserMessage', 'pinned', () =>
  M.createUserMessage({ content: 'hi', uuid: '00000000-0000-4000-8000-000000000042' as never, timestamp: '2026-01-01T00:00:00.000Z' }),
);
add('createUserInterruptionMessage', 'basic', () => M.createUserInterruptionMessage({}));
add('createUserInterruptionMessage', 'tool-use', () =>
  M.createUserInterruptionMessage({ toolUse: true }),
);
add('createSyntheticUserCaveatMessage', 'basic', () =>
  snapSafe(() => M.createSyntheticUserCaveatMessage('caveat body' as never)),
);
add('createModelSwitchBreadcrumbs', 'basic', () =>
  snapSafe(() => M.createModelSwitchBreadcrumbs('opus' as never, 'sonnet' as never)),
);
add('createProgressMessage', 'basic', () =>
  snapSafe(() =>
    M.createProgressMessage(
      { type: 'bash_progress', output: 'x' } as never,
      'toolu_0009' as never,
      'toolu_0009' as never,
    ),
  ),
);
add('createToolResultStopMessage', 'basic', () =>
  snapSafe(() => M.createToolResultStopMessage('toolu_0009' as never)),
);
add('createSystemMessage', 'basic', () =>
  snapSafe(() => M.createSystemMessage({ content: 'note', level: 'info' } as never)),
);
add('createPermissionRetryMessage', 'basic', () =>
  M.createPermissionRetryMessage(['npm test', 'git status']),
);
// the applied-reslot receipt row (own subtype — info-level
// informational rows are quiet below the verbose gate; receipts must be loud).
add('createSeatReceiptMessage', 'basic', () =>
  M.createSeatReceiptMessage('⇄ reslot applied — worker → claude-fable-5 @max', 'info'),
);
add('createSeatReceiptMessage', 'timeout-warning', () =>
  M.createSeatReceiptMessage('▲ reslot pending — worker → claude-fable-5 not observed applied after 10m', 'warning'),
);
// createBridgeStatusMessage RETIRED with its door:
// the remote-control server is gone and systemMessages.ts records the
// retirement in place — the parity row went with the constructor.
add('createScheduledTaskFireMessage', 'basic', () =>
  snapSafe(() => M.createScheduledTaskFireMessage({ name: 'daily' } as never)),
);
add('createStopHookSummaryMessage', 'basic', () =>
  snapSafe(() => M.createStopHookSummaryMessage('summary' as never)),
);
add('createTurnDurationMessage', 'basic', () =>
  snapSafe(() => M.createTurnDurationMessage(1234 as never)),
);
add('createAwaySummaryMessage', 'basic', () =>
  snapSafe(() => M.createAwaySummaryMessage('away note' as never)),
);
add('createModelTransitionMessage', 'basic', () =>
  snapSafe(() =>
    M.createModelTransitionMessage({
      previous: 'claude-opus-5',
      requested: 'claude-sonnet-5',
      applied: 'claude-sonnet-5',
      resolution: 'applied',
      boundary: 'idle',
      crossProvider: false,
      cacheDisposition: 'keyed-sections-recompute-once',
    } as never),
  ),
);
add('createMemorySavedMessage', 'basic', () =>
  snapSafe(() => M.createMemorySavedMessage({ writtenPaths: ['/m.md'] } as never)),
);
add('createAgentsKilledMessage', 'basic', () =>
  snapSafe(() => M.createAgentsKilledMessage(['agent-1'] as never)),
);
add('createApiMetricsMessage', 'basic', () =>
  snapSafe(() => M.createApiMetricsMessage({ durationMs: 10 } as never)),
);
add('createCommandInputMessage', 'basic', () =>
  snapSafe(() => M.createCommandInputMessage('/foo' as never, 'args' as never)),
);
add('createCompactBoundaryMessage', 'basic', () =>
  snapSafe(() =>
    M.createCompactBoundaryMessage(
      { preCompactTokenCount: 1000, trigger: 'manual' } as never,
      '00000000-0000-4000-8000-000000000021' as never,
      '2026-01-01T00:00:21.000Z' as never,
    ),
  ),
);
add('createMicrocompactBoundaryMessage', 'basic', () =>
  M.createMicrocompactBoundaryMessage(
    'auto',
    50_000,
    12_000,
    ['toolu_0001', 'toolu_0002'],
    ['00000000-0000-4000-8000-000000000010'],
  ),
);
add('createSystemAPIErrorMessage', 'basic', () =>
  snapSafe(() => M.createSystemAPIErrorMessage('api down' as never)),
);
add('createToolUseSummaryMessage', 'basic', () =>
  snapSafe(() => M.createToolUseSummaryMessage('toolu_0001' as never, 'summary' as never)),
);

// ── explicit skip list (stateful / stream / env-coupled) ────────────────────
const SKIPPED: Record<string, string> = {
  handleMessageFromStream: 'needs a live SSE stream context — covered by QueryEngine suites',
  isDroppedLateStreamFrame:
    'behaviorally covered by scripts/permissions/prove-permission-abort-total.ts (late-frame gate)',
};

// ── coverage accounting ─────────────────────────────────────────────────────
const runtimeExports = Object.keys(M).filter(
  k => typeof (M as Record<string, unknown>)[k] !== 'undefined',
);
const unaccounted = runtimeExports.filter(k => !covered.has(k) && !(k in SKIPPED));

// ── record / verify ─────────────────────────────────────────────────────────
let failures = 0;
const results: Record<string, unknown> = {};
for (const [name, fn] of Object.entries(cases)) {
  results[name] = snap(fn);
}

if (unaccounted.length) {
  console.log(`  [FAIL] ${unaccounted.length} export(s) neither covered nor skip-listed:`);
  for (const k of unaccounted) console.log(`      - ${k}`);
  failures++;
}

if (RECORD) {
  writeFileSync(GOLDEN_PATH, JSON.stringify(results, null, 1) + '\n');
  console.log(
    `  [RECORDED] ${Object.keys(results).length} golden case(s) → scripts/messages/goldens.json (covered ${covered.size} exports, skipped ${Object.keys(SKIPPED).length})`,
  );
} else {
  if (!existsSync(GOLDEN_PATH)) {
    console.log('  [FAIL] goldens.json missing — run with --record first');
    failures++;
  } else {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8')) as Record<string, unknown>;
    const goldenKeys = Object.keys(golden);
    const currentKeys = Object.keys(results);
    for (const k of goldenKeys) {
      if (!(k in results)) {
        console.log(`  [FAIL] golden case disappeared: ${k}`);
        failures++;
        continue;
      }
      const a = JSON.stringify(golden[k]);
      const b = JSON.stringify(results[k]);
      if (a !== b) {
        failures++;
        console.log(`  [FAIL] parity broke: ${k}`);
        let i = 0;
        while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
        console.log(`      golden:  …${a.slice(Math.max(0, i - 60), i + 90)}…`);
        console.log(`      current: …${b.slice(Math.max(0, i - 60), i + 90)}…`);
      }
    }
    for (const k of currentKeys) {
      if (!(k in golden)) {
        console.log(`  [FAIL] new un-recorded case (re-run --record deliberately): ${k}`);
        failures++;
      }
    }
    if (!failures) {
      console.log(
        `  [PASS] message-pipeline parity: ${goldenKeys.length} golden case(s), ${covered.size}/${runtimeExports.length} exports covered (${Object.keys(SKIPPED).length} skip-listed)`,
      );
    }
  }
}

console.log(failures === 0 ? '✅ MESSAGES PARITY GREEN' : `❌ ${failures} MESSAGES PARITY FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
