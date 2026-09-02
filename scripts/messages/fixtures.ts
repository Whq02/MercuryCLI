
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
  basic: [user('hello world'), assistant('hi there — what can I do?')],

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

  interrupted: [
    user('run something slow'),
    assistant([toolUse(3, 'Bash', { command: 'sleep 999' })]),
    user([{ type: 'text', text: M.INTERRUPT_MESSAGE }] as never, {}, 5),
  ],

  attachments: [
    user('with attachments'),
    attachment(10, { type: 'new_diagnostics', files: [] }),
    assistant([toolUse(4, 'Bash', { command: 'ls' })]),
    progress(11, 'toolu_0004', { type: 'bash_progress', output: 'partial' }),
    user([toolResult(4, 'done')] as never, { toolUseResult: { ok: true } }, 12),
    attachment(13, { type: 'todo', itemCount: 2, context: 'post-tool' }),
    assistant('finished with attachments.'),
  ],

  thinking: [
    user('think hard'),
    assistant([
      { type: 'thinking', thinking: 'deep thought', signature: 'sig-abc' },
      { type: 'text', text: 'the answer' },
    ]),
    assistant([{ type: 'thinking', thinking: 'orphan tail thought', signature: 'sig-def' }]),
  ],

  whitespace: [user('say nothing'), assistant('   \n\t  '), assistant('real reply')],

  boundaries: [
    M.createCompactBoundaryMessage(
      { preCompactTokenCount: 120_000, trigger: 'auto' } as never,
      uuid(20),
      ts(20),
    ) as never,
    user('after compact'),
    assistant('resumed after boundary.'),
  ],

  virtual: [
    user('visible'),
    { ...M.createAssistantMessage({ content: 'display-only', isVirtual: true }) } as never,
    assistant('api-visible reply'),
  ],

  multiBlock: [
    user([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aWs=' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' } },
    ] as never),
    assistant('I see it.'),
  ],

  synthetic: [
    user(M.NO_RESPONSE_REQUESTED),
    { ...M.createAssistantMessage({ content: '' }) } as never,
    user('follow-up'),
  ],

  system: [
    M.createSystemMessage({ content: 'plain system note', level: 'info' } as never) as never,
    user('after system'),
  ],
};

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
