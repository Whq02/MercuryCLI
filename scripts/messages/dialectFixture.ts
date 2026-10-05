
import type { Message, UserMessage, AssistantMessage } from '../../src/types/message.ts'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as never
const ts = (n: number) => `2026-01-01T00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`

const PNG_BYTE = 'aWF0dG9rZW4='

export const FIXTURE_TOOLS = [
  { name: 'Read', description: 'Read a file', inputJSONSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'Bash', description: 'Run a command', inputJSONSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
] as never[]

const user = (content: unknown, n: number, extra: Record<string, unknown> = {}): UserMessage =>
  ({
    type: 'user',
    uuid: uuid(n),
    timestamp: ts(n),
    message: { role: 'user', content },
    ...extra,
  }) as UserMessage

const USAGE = {
  input_tokens: 40,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: null,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: null,
  iterations: null,
  speed: null,
} as never

const assistant = (model: string, id: string, content: unknown[], n: number, stopReason = 'end_turn' as const): AssistantMessage =>
  ({
    type: 'assistant',
    uuid: uuid(n),
    timestamp: ts(n),
    requestId: `req_${id}`,
    message: {
      id: `msg_${id}`,
      container: null,
      model,
      role: 'assistant',
      stop_reason: stopReason,
      stop_sequence: null,
      type: 'message',
      usage: USAGE,
      content,
      context_management: null,
    },
  }) as AssistantMessage

export const SIGNED_THINKING = { type: 'thinking' as const, thinking: 'considering the count request carefully', signature: 'sig-fixture-sonnet-1' }
export const OTHER_MODEL_THINKING = { type: 'thinking' as const, thinking: 'opus weighed this differently', signature: 'sig-fixture-opus-1' }
export const IMAGE_BLOCK = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: PNG_BYTE } }

export const TOOL_USE_A = { type: 'tool_use' as const, id: 'toolu_A', name: 'Read', input: { file_path: '/proj/notes.txt' } }
export const TOOL_USE_B = { type: 'tool_use' as const, id: 'toolu_B', name: 'Bash', input: { command: 'wc -w /proj/notes.txt' } }
export const TOOL_RESULT_A = { type: 'tool_result' as const, tool_use_id: 'toolu_A', content: [{ type: 'text' as const, text: 'the quick brown fox jumps over the lazy dog' }] }
export const TOOL_RESULT_B = { type: 'tool_result' as const, tool_use_id: 'toolu_B', content: [{ type: 'text' as const, text: '9 words' }], is_error: false }

export const DIALECT_CONVERSATION: Message[] = [
  user('Count the words in my notes file.', 1),
  assistant('claude-sonnet-5', 's1', [SIGNED_THINKING, { type: 'text' as const, text: 'I will read the file first.' }], 2),
  user([{ type: 'text' as const, text: 'here is the screenshot of the file too' }, IMAGE_BLOCK], 3),
  assistant('claude-sonnet-5', 's2', [SIGNED_THINKING, { type: 'text' as const, text: 'Reading and counting now.' }, TOOL_USE_A, TOOL_USE_B], 4, 'tool_use'),
  user([TOOL_RESULT_A, TOOL_RESULT_B], 5, { toolUseResult: { ok: true } }),
  assistant('claude-opus-5', 'o1', [OTHER_MODEL_THINKING, { type: 'text' as const, text: 'The file holds nine words.' }], 6),
  user('Summarise what you found in one sentence.', 7),
]

export const TWO_MODEL_COMPACTION: Message[] = [
  user('Start a word-count tool project.', 11),
  assistant('claude-sonnet-5', 'c1', [{ type: 'text' as const, text: 'Laying out the plan.' }], 12),
  assistant('claude-opus-5', 'c2', [
    OTHER_MODEL_THINKING,
    { type: 'thinking' as const, thinking: 'a second opus thought', signature: 'sig-fixture-opus-2' },
    { type: 'text' as const, text: 'Here is the tool sketch.' },
  ], 13),
  assistant('claude-sonnet-5', 'c3', [SIGNED_THINKING, { type: 'text' as const, text: 'Continuing with the sketch.' }], 14),
  user('Make the counter handle UTF-8.', 15),
]

export const VIRTUAL_ROW = (() => ({
  type: 'assistant',
  uuid: uuid(90),
  timestamp: ts(90),
  requestId: undefined,
  isVirtual: true as const,
  message: {
    id: 'msg_virtual',
    container: null,
    model: 'claude-sonnet-5',
    role: 'assistant',
    stop_reason: null,
    stop_sequence: null,
    type: 'message',
    usage: USAGE,
    content: [{ type: 'text' as const, text: 'a display-only row' }],
    context_management: null,
  },
}))()

export const STRUCTURED_OUTPUT_ASK: Record<string, unknown> = {
  type: 'json_schema',
  name: 'word_count',
  schema: { type: 'object', properties: { words: { type: 'number' }, note: { type: 'string' } }, required: ['words'] },
}

export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return JSON.stringify(sort(value))
}

export const eq = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)
