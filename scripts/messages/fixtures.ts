// scripts/messages/fixtures.ts — deterministic synthetic message corpus for the
// R2 message-pipeline parity harness.
//
// Fixtures are built THROUGH the module's own factories wherever one exists
// (shape-valid by construction) with PINNED uuids/timestamps where the factory
// accepts them; internally-generated uuids/timestamps are normalized by the
// harness's stable serializer, preserving identity relations (first-seen
// numbering), so goldens are stable across runs.
//
// NEVER derive fixtures from live operator data (standing rule).

import * as M from '../../src/utils/messages.ts';
import type { Message } from '../../src/types/message.ts';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as never;
const ts = (n: number) =>
  `2026-01-01T00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`;

const user = (
  content: Parameters<typeof M.createUserMessage>[0]['content'],
  extra: Partial<Parameters<typeof M.createUserMessage>[0]> = {},
  n = 1,
) => M.createUserMessage({ content, uuid: uuid(n), timestamp: ts(n), ...extra });

// createAssistantMessage self-generates uuid/timestamp — the serializer
// normalizes them. Content may be a string or BetaContentBlock[].
const assistant = (content: string | object[], extra: object = {}) =>
  ({ ...M.createAssistantMessage({ content: content as never }), ...extra }) as Message;

const toolUse = (id: number, name: string, input: object) => ({
  type: 'tool_use',
  id: `toolu_${String(id).padStart(4, '0')}`,
  name,
  input,
});
const toolResult = (id: number, text: string, isError = false) => ({
  type: 'tool_result',
  tool_use_id: `toolu_${String(id).padStart(4, '0')}`,
  content: [{ type: 'text', text }],
  is_error: isError,
});

const attachment = (n: number, att: object): Message =>
  ({ type: 'attachment', uuid: uuid(n), timestamp: ts(n), attachment: att }) as Message;

const progress = (n: number, toolUseID: string, data: object): Message =>
  ({
    type: 'progress',
    uuid: uuid(n),
    timestamp: ts(n),
    data,
    toolUseID,
    parentToolUseID: toolUseID,
  }) as Message;

export const CORPUS: Record<string, Message[]> = {
  // Plain two-turn conversation.
  basic: [user('hello world'), assistant('hi there — what can I do?')],

  // Parallel tool uses answered by separate tool_result user messages
  // (exercises merge, pairing, sibling/lookup machinery).
  toolTurn: [
    user('read two files'),
    assistant([
      toolUse(1, 'Read', { file_path: '/a.ts' }),
      toolUse(2, 'Read', { file_path: '/b.ts' }),
    ]),
    user([toolResult(1, 'contents of a')] as never, { toolUseResult: { ok: true } }, 3),
    user([toolResult(2, 'contents of b')] as never, { toolUseResult: { ok: true } }, 4),
    assistant('both files read.'),
  ],

  // Interrupted tool use — unresolved tool_use with the canonical interrupt text.
  interrupted: [
    user('run something slow'),
    assistant([toolUse(3, 'Bash', { command: 'sleep 999' })]),
    user([{ type: 'text', text: M.INTERRUPT_MESSAGE }] as never, {}, 5),
  ],

  // Attachment + progress messages woven between tool messages
  // (reorderAttachmentsForAPI ordering rules).
  attachments: [
    user('with attachments'),
    attachment(10, { type: 'new_diagnostics', files: [] }),
    assistant([toolUse(4, 'Bash', { command: 'ls' })]),
    progress(11, 'toolu_0004', { type: 'bash_progress', output: 'partial' }),
    user([toolResult(4, 'done')] as never, { toolUseResult: { ok: true } }, 12),
    attachment(13, { type: 'todo', itemCount: 2, context: 'post-tool' }),
    assistant('finished with attachments.'),
  ],

  // Thinking blocks + signatures + an orphaned thinking-only assistant message.
  thinking: [
    user('think hard'),
    assistant([
      { type: 'thinking', thinking: 'deep thought', signature: 'sig-abc' },
      { type: 'text', text: 'the answer' },
    ]),
    assistant([{ type: 'thinking', thinking: 'orphan tail thought', signature: 'sig-def' }]),
  ],

  // Whitespace-only assistant text (filterWhitespaceOnlyAssistantMessages).
  whitespace: [user('say nothing'), assistant('   \n\t  '), assistant('real reply')],

  // Compact + microcompact boundaries.
  boundaries: [
    M.createCompactBoundaryMessage(
      { preCompactTokenCount: 120_000, trigger: 'auto' } as never,
      uuid(20),
      ts(20),
    ) as never,
    user('after compact'),
    assistant('resumed after boundary.'),
  ],

  // Virtual messages must be stripped from the API view.
  virtual: [
    user('visible'),
    { ...M.createAssistantMessage({ content: 'display-only', isVirtual: true }) } as never,
    assistant('api-visible reply'),
  ],

  // Multi-block user content: text + image + document (strip/merge paths).
  multiBlock: [
    user([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aWs=' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' } },
    ] as never),
    assistant('I see it.'),
  ],

  // Synthetic model/messages + NO_RESPONSE_REQUESTED + empty content.
  synthetic: [
    user(M.NO_RESPONSE_REQUESTED),
    { ...M.createAssistantMessage({ content: '' }) } as never,
    user('follow-up'),
  ],

  // System-message family (discriminated on subtype).
  system: [
    M.createSystemMessage({ content: 'plain system note', level: 'info' } as never) as never,
    user('after system'),
  ],
};

// A composite conversation covering interleavings (concatenation is
// deliberate — cross-fixture adjacency exercises merge/reorder edges).
export const COMPOSITE: Message[] = [
  ...CORPUS.basic!,
  ...CORPUS.toolTurn!,
  ...CORPUS.attachments!,
  ...CORPUS.thinking!,
  ...CORPUS.whitespace!,
  ...CORPUS.boundaries!,
  ...CORPUS.virtual!,
];

export const TOOLS_FIXTURE = [{ name: 'Read' }, { name: 'Bash' }] as never[];
