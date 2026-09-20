#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

delete process.env.NODE_ENV
for (const ambient of ['ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE']) delete process.env[ambient]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tool-call-gate-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type ScriptedCall = {
  id?: string
  name?: string
  args: string
  fragments?: string[]
}
type Script = {
  calls: ScriptedCall[]
  reasoningFirst?: boolean
}
let script: Script = { calls: [] }
const hits: string[] = []
let lastResponsesBody: Record<string, unknown> | undefined

const sseLine = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

function chatCompletionsSse(s: Script): string {
  const out: string[] = []
  s.calls.forEach((call, index) => {
    const pieces = call.fragments ?? [call.args]
    pieces.forEach((piece, i) => {
      out.push(
        sseLine({
          id: 'chatcmpl-fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fixture',
          choices: [
            {
              index: 0,
              delta: {
                ...(i === 0 ? { role: 'assistant' } : {}),
                tool_calls: [
                  {
                    index,
                    ...(i === 0 && call.id !== undefined ? { id: call.id } : {}),
                    type: 'function',
                    function: {
                      ...(i === 0 && call.name !== undefined ? { name: call.name } : {}),
                      arguments: piece,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      )
    })
  })
  out.push(
    sseLine({
      id: 'chatcmpl-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: s.calls.length > 0 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }),
  )
  out.push('data: [DONE]\n\n')
  return out.join('')
}

function anthropicSse(s: Script): string {
  const evt = (name: string, obj: unknown): string => `event: ${name}\n${sseLine(obj)}`
  const usage = { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }
  const out: string[] = [
    evt('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage } }),
  ]
  s.calls.forEach((call, index) => {
    out.push(evt('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id ?? `toolu_${index}`, name: call.name ?? '', input: {} } }))
    out.push(evt('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.args } }))
    out.push(evt('content_block_stop', { type: 'content_block_stop', index }))
  })
  out.push(evt('message_delta', { type: 'message_delta', delta: { stop_reason: s.calls.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage }))
  out.push(evt('message_stop', { type: 'message_stop' }))
  return out.join('')
}

function responsesSse(s: Script): string {
  const out: string[] = [sseLine({ type: 'response.created', response: { id: 'resp_fixture' } })]
  if (s.reasoningFirst) {
    out.push(
      sseLine({
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'ENC_FIXTURE' },
      }),
    )
  }
  s.calls.forEach((call, index) => {
    const itemId = `fc_${index}`
    const identity = {
      ...(call.id !== undefined ? { call_id: call.id } : {}),
      ...(call.name !== undefined ? { name: call.name } : {}),
    }
    out.push(
      sseLine({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: itemId, ...identity, arguments: '' },
      }),
    )
    for (const piece of call.fragments ?? [call.args]) {
      out.push(sseLine({ type: 'response.function_call_arguments.delta', item_id: itemId, delta: piece }))
    }
    out.push(
      sseLine({
        type: 'response.output_item.done',
        item: { type: 'function_call', id: itemId, ...identity, arguments: call.args },
      }),
    )
  })
  out.push(
    sseLine({
      type: 'response.completed',
      response: { id: 'resp_fixture', usage: { input_tokens: 20, output_tokens: 8 } },
    }),
  )
  return out.join('')
}

const OPENAI_MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [
        { effort: 'low', description: 'low' },
        { effort: 'high', description: 'high' },
      ],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = req.url ?? ''
    const path = url.split('?')[0] ?? ''
    hits.push(`${req.method} ${path}`)
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (path.startsWith('/openai/')) {
        res.end(JSON.stringify(OPENAI_MODELS_BODY))
      } else {
        res.end(JSON.stringify(path.startsWith('/moonshot/') ? { object: 'list', data: [{ id: 'kimi-k3', object: 'model', owned_by: 'moonshot', created: 1 }] } : { object: 'list', data: [{ id: 'fixture-local', object: 'model', owned_by: 'fixture' }] }))
      }
      return
    }
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSse(script))
      return
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatCompletionsSse(script))
      return
    }
    if (req.method === 'POST' && path.endsWith('/responses')) {
      try {
        lastResponsesBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        lastResponsesBody = undefined
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesSse(script))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`

Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_LOCAL_BASE_URL: base,
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_COMPAT_API_KEY: 'fixture-compat-key',
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MOONSHOT_API_KEY: 'fixture-moonshot-key',
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  DEEPSEEK_API_KEY: 'fixture-deepseek-key',
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  OPENROUTER_API_KEY: 'fixture-openrouter-key',
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
  GEMINI_API_KEY: 'fixture-gemini-key',
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
  HF_TOKEN: 'fixture-hf-token',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
})

console.log('============================================================')
console.log(' transport-boundary tool-call gate — every dialect, fuzzed')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext, findToolByName } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { EnterPlanModeTool } = await import('../../src/tools/EnterPlanModeTool/EnterPlanModeTool.ts')
const { gateToolCall } = await import('../../src/services/providers/toolCallGate.ts')
const { replayableItems } = await import('../../src/services/providers/openai/openaiCallModel.ts')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type RefusedToolCall = import('../../src/types/message.ts').RefusedToolCall

const { z } = await import('zod/v4')
const PermissiveFixtureTool = {
  name: 'PermissiveFixture',
  inputSchema: z.object({ text: z.string() }),
  prompt: async () => 'fixture tool with a permissive schema',
  isReadOnly: () => true,
}
const RequiredFixtureTool = {
  name: 'RequiredFixture',
  inputSchema: z.strictObject({
    kind: z.enum(['a', 'b']),
    code: z.string().min(1),
    note: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  prompt: async () => 'fixture tool with required and optional fields',
  isReadOnly: () => true,
}
const CATALOG = [
  BashTool,
  FileReadTool,
  FileEditTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  EnterPlanModeTool,
  PermissiveFixtureTool,
  RequiredFixtureTool,
] as never
const BASH = BashTool.name
const READ = FileReadTool.name
const EDIT = FileEditTool.name
const GREP = GrepTool.name
const PLAN = EnterPlanModeTool.name
const PERMISSIVE = PermissiveFixtureTool.name
const REQUIRED = RequiredFixtureTool.name

const LANES: Array<{ lane: string; model: string; dialect: 'responses' | 'chat' }> = [
  { lane: 'openai', model: 'gpt-5.6-sol', dialect: 'responses' },
  { lane: 'zai', model: 'glm-5.2', dialect: 'chat' },
  { lane: 'moonshot', model: 'kimi-k3', dialect: 'chat' },
  { lane: 'deepseek', model: 'deepseek-v4-pro', dialect: 'chat' },
  { lane: 'openai-compat', model: 'compat/fixture-model', dialect: 'chat' },
  { lane: 'openrouter', model: 'openrouter/fixture/model', dialect: 'chat' },
  { lane: 'gemini', model: 'gemini-3-pro', dialect: 'chat' },
  { lane: 'huggingface', model: 'huggingface/fixture-org/fixture-model', dialect: 'chat' },
  { lane: 'local', model: 'local/fixture-local', dialect: 'chat' },
]

type Expect = { accepted: number; refused: Array<RefusedToolCall['code']>; stop: 'tool_use' | 'end_turn' }
type Case = { label: string; script: Script; expect: Expect; reasonIncludes?: string }
const CASES: Case[] = [
  {
    label: 'valid call (control)',
    script: { calls: [{ id: 'call_ok', name: BASH, args: '{"command":"echo ok"}' }] },
    expect: { accepted: 1, refused: [], stop: 'tool_use' },
  },
  {
    label: 'empty {} on a tool with a required parameter',
    script: { calls: [{ id: 'call_empty', name: BASH, args: '{}' }] },
    expect: { accepted: 0, refused: ['schema'], stop: 'end_turn' },
    reasonIncludes: '`command` is missing',
  },
  {
    label: 'wrong-typed parameter',
    script: { calls: [{ id: 'call_typed', name: BASH, args: '{"command":123}' }] },
    expect: { accepted: 0, refused: ['schema'], stop: 'end_turn' },
    reasonIncludes: '`command`',
  },
  {
    label: 'unknown field on a STRICT tool',
    script: { calls: [{ id: 'call_strict', name: PLAN, args: '{"bogus":1}' }] },
    expect: { accepted: 0, refused: ['schema'], stop: 'end_turn' },
    reasonIncludes: '`bogus` was not expected',
  },
  {
    label: 'unknown field on a STRICT real tool (Bash) is refused — every real schema is strict',
    script: { calls: [{ id: 'call_extra_bash', name: BASH, args: '{"command":"echo ok","bogus":1}' }] },
    expect: { accepted: 0, refused: ['schema'], stop: 'end_turn' },
    reasonIncludes: '`bogus` was not expected',
  },
  {
    label: 'unknown field on a permissive tool is ACCEPTED (the one schema owner permits it)',
    script: { calls: [{ id: 'call_extra', name: PERMISSIVE, args: '{"text":"hi","bogus":1}' }] },
    expect: { accepted: 1, refused: [], stop: 'tool_use' },
  },
  {
    label: 'malformed JSON',
    script: { calls: [{ id: 'call_bad', name: BASH, args: '{"command": "ls"' }] },
    expect: { accepted: 0, refused: ['invalid-json'], stop: 'end_turn' },
  },
  {
    label: 'partial arguments assembled across fragments settle BEFORE validation',
    script: {
      calls: [{ id: 'call_frag', name: BASH, args: '{"command":"echo fragmented"}', fragments: ['{"comm', 'and":"echo frag', 'mented"}'] }],
    },
    expect: { accepted: 1, refused: [], stop: 'tool_use' },
  },
  {
    label: 'unknown tool',
    script: { calls: [{ id: 'call_unknown', name: 'Bsh', args: '{"command":"ls"}' }] },
    expect: { accepted: 0, refused: ['unknown-tool'], stop: 'end_turn' },
    reasonIncludes: 'No such tool available: Bsh',
  },
  {
    label: 'no tool name at all',
    script: { calls: [{ id: 'call_nameless', args: '{"command":"ls"}' }] },
    expect: { accepted: 0, refused: ['unknown-tool'], stop: 'end_turn' },
  },
  {
    label: 'no call id',
    script: { calls: [{ name: BASH, args: '{"command":"ls"}' }] },
    expect: { accepted: 0, refused: ['missing-id'], stop: 'end_turn' },
  },
  {
    label: 'top-level null optionals are stripped and the call is ACCEPTED (the null-optional law)',
    script: { calls: [{ id: 'call_null', name: BASH, args: '{"command":"echo ok","timeout":null,"description":null}' }] },
    expect: { accepted: 1, refused: [], stop: 'tool_use' },
  },
  {
    label: 'non-object arguments',
    script: { calls: [{ id: 'call_array', name: BASH, args: '[1,2]' }] },
    expect: { accepted: 0, refused: ['not-an-object'], stop: 'end_turn' },
  },
  {
    label: 'empty placeholders on optional fields are dropped at the decode and the call is ACCEPTED (the empty-optional law)',
    script: {
      calls: [{ id: 'call_empties', name: BASH, args: '{"command":"echo ok","timeout":"","description":"","run_in_background":"","dangerouslyDisableSandbox":null}' }],
    },
    expect: { accepted: 1, refused: [], stop: 'tool_use' },
  },
  {
    label: 'empty placeholders on every optional field of a real search call are dropped and the call is ACCEPTED',
    script: {
      calls: [{ id: 'call_grep_empties', name: GREP, args: '{"pattern":"needle","path":"","glob":"","type":"","-i":"","head_limit":"","output_mode":""}' }],
    },
    expect: { accepted: 1, refused: [], stop: 'tool_use' },
  },
  {
    label: 'an empty value on a REQUIRED field stays and the schema refusal names the field',
    script: { calls: [{ id: 'call_required_empty', name: REQUIRED, args: '{"kind":"","code":"","note":"","tags":[]}' }] },
    expect: { accepted: 0, refused: ['schema'], stop: 'end_turn' },
    reasonIncludes: '`kind` must be one of',
  },
  {
    label: 'mixed turn: one accepted, one refused',
    script: {
      calls: [
        { id: 'call_mix_ok', name: READ, args: '{"file_path":"/tmp/fixture.txt"}' },
        { id: 'call_mix_bad', name: BASH, args: '{}' },
      ],
    },
    expect: { accepted: 1, refused: ['schema'], stop: 'tool_use' },
  },
  {
    label: 'empty argument string on a no-parameter tool is ACCEPTED as {}',
    script: { calls: [{ id: 'call_noargs', name: PLAN, args: '' }] },
    expect: { accepted: 1, refused: [], stop: 'tool_use' },
  },
]

type Outcome = {
  threw: unknown
  assistants: AssistantMessage[]
  toolUses: Array<{ id: string; name: string; input: unknown }>
  notes: string[]
  refusals: RefusedToolCall[]
  stopReason: string | null | undefined
  apiError: string | undefined
}

async function drive(model: string, s: Script): Promise<Outcome> {
  script = s
  const assistants: AssistantMessage[] = []
  let threw: unknown
  try {
    const gen = routedCallModel({
      messages: [createUserMessage({ content: 'do the fixture thing' })] as never,
      systemPrompt: ['fixture system prompt'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: CATALOG,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model,
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'high',
      } as never,
    })
    for await (const item of gen) {
      if ((item as { type?: string }).type === 'assistant') assistants.push(item as AssistantMessage)
    }
  } catch (error) {
    threw = error
  }
  const toolUses: Outcome['toolUses'] = []
  const notes: string[] = []
  const refusals: RefusedToolCall[] = []
  let apiError: string | undefined
  for (const m of assistants) {
    if (m.isApiErrorMessage) {
      const first = m.message.content[0] as { text?: string } | undefined
      apiError = first?.text
    }
    for (const block of m.message.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        toolUses.push({ id: String(block.id), name: String(block.name), input: block.input })
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('[')) {
        notes.push(block.text)
      }
    }
    if (m.refusedToolCalls) refusals.push(...m.refusedToolCalls)
  }
  const settled = assistants.filter(m => !m.isApiErrorMessage).at(-1)
  return { threw, assistants, toolUses, notes, refusals, stopReason: settled?.message.stop_reason, apiError }
}

function mintedInputsValid(toolUses: Outcome['toolUses']): boolean {
  return toolUses.every(use => {
    const tool = findToolByName(CATALOG, use.name)
    if (!tool) return false
    try {
      return tool.inputSchema.safeParse(use.input).success
    } catch {
      return false
    }
  })
}

let mintedAcrossEverything = 0
for (const { lane, model, dialect } of LANES) {
  section(`${lane} · ${dialect} dialect · ${model}`)
  for (const c of CASES) {
    const o = await drive(model, c.script)
    const codes = o.refusals.map(r => r.code)
    const detail = `threw=${o.threw ? String(o.threw) : 'no'} apiError=${o.apiError ?? 'none'} mints=${o.toolUses.length} refusals=${JSON.stringify(codes)} notes=${o.notes.length} stop=${String(o.stopReason)}`
    const ok =
      o.threw === undefined &&
      o.apiError === undefined &&
      o.toolUses.length === c.expect.accepted &&
      JSON.stringify(codes) === JSON.stringify(c.expect.refused) &&
      o.notes.length === c.expect.refused.length &&
      o.stopReason === c.expect.stop &&
      mintedInputsValid(o.toolUses) &&
      (c.reasonIncludes === undefined || o.refusals.some(r => r.reason.includes(c.reasonIncludes!)))
    check(`${c.label}`, ok, detail + (c.reasonIncludes && !ok ? ` reasons=${JSON.stringify(o.refusals.map(r => r.reason))}` : ''))
    mintedAcrossEverything += o.toolUses.length
  }
}

section('cross-lane facts')
check('every lane minted the control case — the fixture reached all nine runtimes', mintedAcrossEverything >= LANES.length * 5)
check(
  'no request ever left the loopback (every hit is a fixture path)',
  hits.every(h => h.startsWith('GET ') || h.startsWith('POST ')),
  hits.slice(0, 10).join(' | '),
)

section('the null-optional law stripped the nulls (accepted input carries no null keys)')
{
  const o = await drive('glm-5.2', CASES.find(c => c.label.startsWith('top-level null'))!.script)
  const input = (o.toolUses[0]?.input ?? {}) as Record<string, unknown>
  check(
    'no null-valued key survives into the minted input; timeout/description read as omitted',
    o.toolUses.length === 1 &&
      Object.values(input).every(v => v !== null) &&
      input.timeout === undefined &&
      input.description === undefined &&
      input.command === 'echo ok',
    JSON.stringify(input),
  )
}

section('the empty-optional law: an optional field sent empty reads as omitted; a meaningful or required empty stays')
for (const model of ['gpt-5.6-sol', 'deepseek-v4-pro']) {
  const defined = (input: unknown): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries((input ?? {}) as Record<string, unknown>).filter(([key, v]) => v !== undefined && !(key === 'replace_all' && v === false)),
    )
  const bash = await drive(model, CASES.find(c => c.label.startsWith('empty placeholders on optional fields'))!.script)
  check(
    `${model}: Bash carries only the command — timeout, description and the flags sent empty are gone, as the Anthropic wire would carry them`,
    bash.toolUses.length === 1 && JSON.stringify(defined(bash.toolUses[0]!.input)) === JSON.stringify({ command: 'echo ok' }),
    JSON.stringify(bash.toolUses[0]?.input),
  )
  const grep = await drive(model, CASES.find(c => c.label.startsWith('empty placeholders on every optional field'))!.script)
  check(
    `${model}: Grep carries only the pattern`,
    grep.toolUses.length === 1 && JSON.stringify(defined(grep.toolUses[0]!.input)) === JSON.stringify({ pattern: 'needle' }),
    JSON.stringify(grep.toolUses[0]?.input),
  )
  const deletion = await drive(model, {
    calls: [{ id: 'call_edit_delete', name: EDIT, args: '{"file_path":"/tmp/fixture.txt","old_string":"gone","new_string":"","expected_anchor":"","append":"","section":"","hunks":[]}' }],
  })
  check(
    `${model}: an Edit that deletes keeps its empty new_string; the empty anchor, append, section and hunks read as omitted`,
    deletion.toolUses.length === 1 &&
      JSON.stringify(defined(deletion.toolUses[0]!.input)) === JSON.stringify({ file_path: '/tmp/fixture.txt', old_string: 'gone', new_string: '' }),
    JSON.stringify(deletion.toolUses[0]?.input),
  )
  const creation = await drive(model, {
    calls: [{ id: 'call_edit_create', name: EDIT, args: '{"file_path":"/tmp/fixture-new.txt","old_string":"","new_string":"first line"}' }],
  })
  check(
    `${model}: an Edit that creates a file keeps its empty old_string`,
    creation.toolUses.length === 1 &&
      JSON.stringify(defined(creation.toolUses[0]!.input)) === JSON.stringify({ file_path: '/tmp/fixture-new.txt', old_string: '', new_string: 'first line' }),
    JSON.stringify(creation.toolUses[0]?.input),
  )
  const required = await drive(model, {
    calls: [{ id: 'call_required_ok', name: REQUIRED, args: '{"kind":"a","code":"x","note":"","tags":[]}' }],
  })
  check(
    `${model}: the required fields ride and the empty optionals are gone`,
    required.toolUses.length === 1 && JSON.stringify(defined(required.toolUses[0]!.input)) === JSON.stringify({ kind: 'a', code: 'x' }),
    JSON.stringify(required.toolUses[0]?.input),
  )
  const refusedRequired = await drive(model, CASES.find(c => c.label.startsWith('an empty value on a REQUIRED'))!.script)
  const reason = refusedRequired.refusals[0]?.reason ?? ''
  check(
    `${model}: the refusal for required fields sent empty names both of them`,
    refusedRequired.refusals.length === 1 && reason.includes('`kind` must be one of') && reason.includes('`code` must have a minimum of 1 character'),
    reason,
  )
}

section('the straight-quote law: the gpt lane straightens a command, a pattern and a path; content and prose arrive as typed; every other wire carries the bytes as typed')
{
  const LS = '‘'
  const RS = '’'
  const LD = '“'
  const RD = '”'
  const GLOB = GlobTool.name
  const WRITE = FileWriteTool.name
  const curled: Record<string, Script> = {
    bash: { calls: [{ id: 'call_curl_bash', name: BASH, args: JSON.stringify({ command: `echo ${LS}hi${RS} ${LD}there${RD}`, description: `say ${LS}hi${RS} ${LD}there${RD}` }) }] },
    grep: { calls: [{ id: 'call_curl_grep', name: GREP, args: JSON.stringify({ pattern: `don${RS}t`, path: `/tmp/${LS}x${RS}`, glob: `${LD}*.md${RD}`, output_mode: 'content' }) }] },
    glob: { calls: [{ id: 'call_curl_glob', name: GLOB, args: JSON.stringify({ pattern: `**/${LS}x${RS}*.md` }) }] },
    write: { calls: [{ id: 'call_curl_write', name: WRITE, args: JSON.stringify({ file_path: `/tmp/${LS}f${RS}.md`, content: `it${RS}s ${LD}fine${RD}` }) }] },
    edit: { calls: [{ id: 'call_curl_edit', name: EDIT, args: JSON.stringify({ file_path: `/tmp/${LS}f${RS}.md`, old_string: `it${RS}s`, new_string: `it${RS}s ${LD}fine${RD}` }) }] },
  }
  const minted = async (model: string, s: Script): Promise<{ input: Record<string, unknown>; detail: string }> => {
    const o = await drive(model, s)
    return {
      input: (o.toolUses[0]?.input ?? {}) as Record<string, unknown>,
      detail: `threw=${o.threw ? String(o.threw) : 'no'} apiError=${o.apiError ?? 'none'} mints=${o.toolUses.length} input=${JSON.stringify(o.toolUses[0]?.input)}`,
    }
  }
  const lanes: Array<{ model: string; straight: boolean; wire: string }> = [
    { model: 'gpt-5.6-sol', straight: true, wire: 'the Responses wire' },
    { model: 'deepseek-v4-pro', straight: false, wire: 'a chat-completions wire' },
    { model: 'claude-opus-4-8', straight: false, wire: 'the Anthropic wire' },
  ]
  for (const { model, straight, wire } of lanes) {
    const word = straight ? 'arrives straight' : 'arrives as typed'
    const bash = await minted(model, curled.bash!)
    check(
      `${model} (${wire}): the Bash command ${word}; the description arrives as typed`,
      bash.input.command === (straight ? `echo 'hi' "there"` : `echo ${LS}hi${RS} ${LD}there${RD}`) && bash.input.description === `say ${LS}hi${RS} ${LD}there${RD}`,
      bash.detail,
    )
    const grep = await minted(model, curled.grep!)
    check(
      `${model}: the Grep pattern, path and glob ${straight ? 'arrive straight' : 'arrive as typed'}`,
      grep.input.pattern === (straight ? "don't" : `don${RS}t`) && grep.input.path === (straight ? "/tmp/'x'" : `/tmp/${LS}x${RS}`) && grep.input.glob === (straight ? '"*.md"' : `${LD}*.md${RD}`),
      grep.detail,
    )
    const glob = await minted(model, curled.glob!)
    check(`${model}: the Glob pattern ${word}`, glob.input.pattern === (straight ? "**/'x'*.md" : `**/${LS}x${RS}*.md`), glob.detail)
    const write = await minted(model, curled.write!)
    check(
      `${model}: the Write file path ${word}; the content arrives as typed`,
      write.input.file_path === (straight ? "/tmp/'f'.md" : `/tmp/${LS}f${RS}.md`) && write.input.content === `it${RS}s ${LD}fine${RD}`,
      write.detail,
    )
    const edit = await minted(model, curled.edit!)
    check(
      `${model}: the Edit file path ${word}; old_string and new_string arrive as typed`,
      edit.input.file_path === (straight ? "/tmp/'f'.md" : `/tmp/${LS}f${RS}.md`) && edit.input.old_string === `it${RS}s` && edit.input.new_string === `it${RS}s ${LD}fine${RD}`,
      edit.detail,
    )
  }
  check('the Anthropic drive rode the messages wire of the fixture', hits.some(h => h === 'POST /v1/messages'), hits.filter(h => h.includes('messages')).join(' | '))
}

section('the permissive-tool extra field rides the minted input verbatim (validated, never rewritten)')
{
  const o = await drive('kimi-k3', CASES.find(c => c.label.startsWith('unknown field on a permissive'))!.script)
  const input = (o.toolUses[0]?.input ?? {}) as Record<string, unknown>
  check('the raw object the model sent is what the harness holds', input.bogus === 1 && input.text === 'hi', JSON.stringify(input))
}

section('Responses lane — the stateless-replay record never carries a refused call')
{
  const o = await drive('gpt-5.6-sol', {
    reasoningFirst: true,
    calls: [{ id: 'call_replay_bad', name: BASH, args: '{}' }],
  })
  const record = o.assistants.at(-1)?.apexProviderTurn
  check('the refused call is REFUSED here too', o.refusals.length === 1 && o.toolUses.length === 0, JSON.stringify(o.refusals))
  check(
    'no replay record survives: the refused call is gone and its reasoning item is not left stranded',
    record === undefined,
    JSON.stringify(record)?.slice(0, 200),
  )
  const mixed = await drive('gpt-5.6-sol', {
    reasoningFirst: true,
    calls: [
      { id: 'call_replay_ok', name: READ, args: '{"file_path":"/tmp/fixture.txt"}' },
      { id: 'call_replay_bad2', name: BASH, args: '{}' },
    ],
  })
  const items = (mixed.assistants.at(-1)?.apexProviderTurn?.items ?? []) as Array<Record<string, unknown>>
  check(
    'mixed turn: the record keeps reasoning + the accepted call and drops the refused one',
    items.map(i => `${i.type}:${i.call_id ?? ''}`).join(',') === 'reasoning:,function_call:call_replay_ok',
    items.map(i => `${i.type}:${i.call_id ?? ''}`).join(','),
  )
  const pure = replayableItems(
    [
      { type: 'reasoning', id: 'r1', summary: [] },
      { type: 'function_call', call_id: 'a', name: 'X', arguments: '{}' },
      { type: 'reasoning', id: 'r2', summary: [] },
      { type: 'function_call', call_id: 'b', name: 'Y', arguments: '{}' },
      { type: 'reasoning', id: 'r3', summary: [] },
    ],
    [{ id: 'b' }],
  )
  check(
    'replayableItems: drops the refused call, its stranded reasoning, and a trailing reasoning item',
    pure.map(i => (i.type === 'function_call' ? `call:${i.call_id}` : i.type === 'reasoning' ? `reasoning:${i.id}` : i.type)).join(',') ===
      'reasoning:r1,call:a',
    JSON.stringify(pure),
  )
}

section('the gate as a pure function (the exact contract the adapters call)')
{
  const g = (name: string, args: string, malformed = false, id = 'call_x') =>
    gateToolCall(CATALOG, { id, name, argumentsRaw: args, malformed })
  check('valid → ok with the raw object', (() => { const v = g(BASH, '{"command":"ls"}'); return v.ok && (v.input as { command: string }).command === 'ls' })())
  check('a schema throw is a refusal, never an escape', (() => {
    const throwing = [{ name: 'Boom', inputSchema: { safeParse: () => { throw new Error('schema exploded') } }, prompt: async () => '' }] as never
    const v = gateToolCall(throwing, { id: 'c', name: 'Boom', argumentsRaw: '{}', malformed: false })
    return !v.ok && v.refusal.code === 'schema' && v.refusal.reason.includes('schema exploded')
  })())
  check("alias names resolve through the catalog's own matcher", (() => {
    const aliased = [{ name: 'Real', aliases: ['Old'], inputSchema: BashTool.inputSchema, prompt: async () => '' }] as never
    const v = gateToolCall(aliased, { id: 'c', name: 'Old', argumentsRaw: '{"command":"ls"}', malformed: false })
    return v.ok
  })())
  check('the refusal record preserves the raw bytes verbatim', (() => {
    const v = g(BASH, '{"command": "ls"')
    return !v.ok && v.refusal.argumentsRaw === '{"command": "ls"' && v.refusal.id === 'call_x'
  })())
  const { gateToolCalls, toolCallRefusalNote, toolCallRefusalCorrection } = await import('../../src/services/providers/toolCallGate.ts')
  check('a turn judged together: a second call under an id already used is refused duplicate-id, the first runs', (() => {
    const verdicts = gateToolCalls(CATALOG, [
      { id: 'call_same', name: BASH, argumentsRaw: '{"command":"ls"}', malformed: false },
      { id: 'call_same', name: BASH, argumentsRaw: '{"command":"pwd"}', malformed: false },
      { id: 'call_other', name: BASH, argumentsRaw: '{"command":"id"}', malformed: false },
    ])
    return verdicts.length === 3 && verdicts[0]!.ok && !verdicts[1]!.ok && verdicts[1]!.refusal.code === 'duplicate-id' && verdicts[2]!.ok
  })())
  check('a refused first call does not reserve its id (the gate refuses on its own merits first)', (() => {
    const verdicts = gateToolCalls(CATALOG, [
      { id: 'call_re', name: BASH, argumentsRaw: '{}', malformed: false },
      { id: 'call_re', name: BASH, argumentsRaw: '{"command":"ls"}', malformed: false },
    ])
    return !verdicts[0]!.ok && verdicts[0]!.refusal.code === 'schema' && verdicts[1]!.ok
  })())
  check('the duplicate-id note and correction name the reused id', (() => {
    const refusal = { id: 'call_same', name: BASH, argumentsRaw: '{"command":"pwd"}', code: 'duplicate-id' as const, reason: 'the provider reused call id call_same for a second call in the same turn; only the first call carrying that id ran' }
    return toolCallRefusalNote('fixture', refusal).includes('call_same') && toolCallRefusalCorrection([refusal]).includes('duplicate call id for Bash')
  })())
  const { dropEmptyOptionalArgs } = await import('../../src/services/providers/toolCallGate.ts')
  check('dropEmptyOptionalArgs: a union schema keeps an empty field one option requires', (() => {
    const union = { inputSchema: z.union([z.strictObject({ k: z.literal('x'), t: z.string().optional() }), z.strictObject({ k: z.literal('y'), t: z.string() })]) }
    return JSON.stringify(dropEmptyOptionalArgs({ k: 'x', t: '' }, union)) === JSON.stringify({ k: 'x', t: '' })
  })())
  check('dropEmptyOptionalArgs: a union schema drops an empty field every option marks optional', (() => {
    const union = { inputSchema: z.union([z.strictObject({ k: z.literal('x'), t: z.string().optional() }), z.strictObject({ k: z.literal('y'), t: z.string().optional() })]) }
    return JSON.stringify(dropEmptyOptionalArgs({ k: 'y', t: '', u: [] }, union)) === JSON.stringify({ k: 'y', u: [] })
  })())
  check('dropEmptyOptionalArgs: a schema with no declared fields (the MCP shape) is left exactly as sent', (() => {
    const loose = { inputSchema: z.looseObject({}) }
    return JSON.stringify(dropEmptyOptionalArgs({ a: '', b: [] }, loose)) === JSON.stringify({ a: '', b: [] })
  })())
  check('dropEmptyOptionalArgs: keepEmptyInputs holds a field the tool reads as meaningful when empty', (() => {
    const keeper = { inputSchema: z.strictObject({ a: z.string().optional(), b: z.string().optional() }), keepEmptyInputs: ['a'] as const }
    return JSON.stringify(dropEmptyOptionalArgs({ a: '', b: '' }, keeper)) === JSON.stringify({ a: '' })
  })())
  check('dropEmptyOptionalArgs: a preprocess-wrapped and a lazy object schema are read through to their fields', (() => {
    const inner = z.strictObject({ a: z.string().optional(), b: z.string() })
    const wrapped = { inputSchema: z.preprocess(value => value, inner) }
    const lazy = { inputSchema: z.lazy(() => inner) }
    return (
      JSON.stringify(dropEmptyOptionalArgs({ a: '', b: '' }, wrapped)) === JSON.stringify({ b: '' }) &&
      JSON.stringify(dropEmptyOptionalArgs({ a: '', b: '' }, lazy)) === JSON.stringify({ b: '' })
    )
  })())
  check('dropEmptyOptionalArgs: nested empties are payload and stay', (() => {
    const tool = { inputSchema: z.strictObject({ a: z.object({ x: z.string().optional() }).optional(), b: z.array(z.string()).optional() }) }
    return JSON.stringify(dropEmptyOptionalArgs({ a: { x: '' }, b: [''] }, tool)) === JSON.stringify({ a: { x: '' }, b: [''] })
  })())
  check('the real Edit declares old_string and new_string as meaningful when empty; the real Grep keeps its required pattern', (() => {
    const edit = dropEmptyOptionalArgs({ file_path: '/tmp/x', old_string: '', new_string: '', expected_anchor: '', hunks: [] }, FileEditTool as never)
    const grep = dropEmptyOptionalArgs({ pattern: '', glob: '' }, GrepTool as never)
    return JSON.stringify(edit) === JSON.stringify({ file_path: '/tmp/x', old_string: '', new_string: '' }) && JSON.stringify(grep) === JSON.stringify({ pattern: '' })
  })())
  const gateModule = (await import('../../src/services/providers/toolCallGate.ts')) as unknown as {
    straightenQuoteArgs?: (input: Record<string, unknown>, tool: { straightQuoteInputs?: readonly string[] }) => Record<string, unknown>
  }
  check('straightenQuoteArgs is exported by the gate', typeof gateModule.straightenQuoteArgs === 'function')
  const straighten = (input: Record<string, unknown>, tool: { straightQuoteInputs?: readonly string[] }): Record<string, unknown> =>
    typeof gateModule.straightenQuoteArgs === 'function' ? gateModule.straightenQuoteArgs(input, tool) : input
  const LS = '‘'
  const RS = '’'
  const LD = '“'
  const RD = '”'
  const listed = { straightQuoteInputs: ['command', 'paths', 'shape'] as const }
  check('straightenQuoteArgs: a declared string field is straightened; an undeclared one stays as typed', (() => {
    const out = straighten({ command: `echo ${LS}a${RS} ${LD}b${RD}`, description: `say ${LS}a${RS}` }, listed)
    return out.command === `echo 'a' "b"` && out.description === `say ${LS}a${RS}`
  })())
  check('straightenQuoteArgs: a declared array field is straightened element by element; a non-string element rides', (() => {
    const out = straighten({ paths: [`/tmp/${LS}x${RS}`, 3, `${LD}y${RD}`] }, listed)
    return JSON.stringify(out.paths) === JSON.stringify(["/tmp/'x'", 3, '"y"'])
  })())
  check('straightenQuoteArgs: a nested value is never touched, even under a declared field', (() => {
    const shape = { text: `${LS}nested${RS}` }
    const out = straighten({ shape }, listed)
    return out.shape === shape && (out.shape as { text: string }).text === `${LS}nested${RS}`
  })())
  check('straightenQuoteArgs: a call with nothing to straighten keeps the very object the model sent', (() => {
    const input = { command: "echo 'plain'", paths: ['/tmp/x'] }
    return straighten(input, listed) === input && straighten(input, {}) === input
  })())
  check('gateToolCall: the straightening hint straightens the real Bash command; without the hint the same bytes ride as typed (every lane but gpt)', (() => {
    const raw = JSON.stringify({ command: `echo ${LS}hi${RS}` })
    const hinted = gateToolCall(CATALOG, { id: 'c1', name: BASH, argumentsRaw: raw, malformed: false }, { straightenQuotes: true } as never)
    const plain = gateToolCall(CATALOG, { id: 'c2', name: BASH, argumentsRaw: raw, malformed: false })
    return hinted.ok && hinted.input.command === "echo 'hi'" && plain.ok && plain.input.command === `echo ${LS}hi${RS}`
  })())
  const declared = (tool: unknown): string => JSON.stringify((tool as { straightQuoteInputs?: readonly string[] }).straightQuoteInputs ?? null)
  check('the shell, search and file tools declare their straightened fields: Bash command · Grep pattern, path, glob · Glob pattern, path · Read, Write and Edit file_path', (() => {
    return (
      declared(BashTool) === JSON.stringify(['command']) &&
      declared(GrepTool) === JSON.stringify(['pattern', 'path', 'glob']) &&
      declared(GlobTool) === JSON.stringify(['pattern', 'path']) &&
      declared(FileReadTool) === JSON.stringify(['file_path']) &&
      declared(FileWriteTool) === JSON.stringify(['file_path']) &&
      declared(FileEditTool) === JSON.stringify(['file_path'])
    )
  })(), [BashTool, GrepTool, GlobTool, FileReadTool, FileWriteTool, FileEditTool].map(declared).join(' '))
  {
    const { LSPTool } = await import('../../src/tools/LSPTool/LSPTool.ts')
    const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
    const { NotebookEditTool } = await import('../../src/tools/NotebookEditTool/NotebookEditTool.ts')
    const { AstSearchTool } = await import('../../src/tools/AstSearchTool/AstSearchTool.ts')
    const { AstEditTool } = await import('../../src/tools/AstEditTool/AstEditTool.ts')
    const { StructureTool } = await import('../../src/tools/StructureTool/StructureTool.ts')
    const { PowerShellTool } = await import('../../src/tools/PowerShellTool/PowerShellTool.tsx')
    const { GitTool } = await import('../../src/tools/GitTool/GitTool.ts')
    const { SendUserFileTool } = await import('../../src/tools/SendUserFileTool/SendUserFileTool.ts')
    const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
    const { LaunchTool } = await import('../../src/tools/LaunchTool/LaunchTool.ts')
    const { ServiceTool } = await import('../../src/tools/ServiceTool/ServiceTool.ts')
    const { MonitorTool } = await import('../../src/tools/MonitorTool/MonitorTool.ts')
    const { AsepriteTool } = await import('../../src/tools/AsepriteTool/AsepriteTool.ts')
    const { WorkshopTool } = await import('../../src/tools/WorkshopTool/WorkshopTool.ts')
    check('the language-server tool straightens its file, symbol and path fields: filePath, query, newName, newPath, targetPath, paths', declared(LSPTool) === JSON.stringify(['filePath', 'query', 'newName', 'newPath', 'targetPath', 'paths']), declared(LSPTool))
    check('the debugger straightens its paths, expressions and symbols: program, file, expression, name, value, text, functions', declared(DebugTool) === JSON.stringify(['program', 'file', 'expression', 'name', 'value', 'text', 'functions']), declared(DebugTool))
    check('the notebook editor straightens notebook_path and keeps new_source as typed', declared(NotebookEditTool) === JSON.stringify(['notebook_path']), declared(NotebookEditTool))
    check('the structural search and rewrite tools straighten pattern, path and glob; the rewrite text stays as typed', declared(AstSearchTool) === JSON.stringify(['pattern', 'path', 'glob']) && declared(AstEditTool) === JSON.stringify(['pattern', 'path', 'glob']), `${declared(AstSearchTool)} ${declared(AstEditTool)}`)
    check('the Structure tool straightens its pattern, symbol, glob and path fields: pattern, name, callee, module, within, files, to, newModule', declared(StructureTool) === JSON.stringify(['pattern', 'name', 'callee', 'module', 'within', 'files', 'to', 'newModule']), declared(StructureTool))
    check('the PowerShell tool straightens its command', declared(PowerShellTool) === JSON.stringify(['command']), declared(PowerShellTool))
    check('the git tool straightens its path fields: paths, files, path, file, cwd', declared(GitTool) === JSON.stringify(['paths', 'files', 'path', 'file', 'cwd']), declared(GitTool))
    check('the file-delivery, test, launch, service and monitor tools straighten their paths and commands', declared(SendUserFileTool) === JSON.stringify(['files']) && declared(TestTool) === JSON.stringify(['path', 'file']) && declared(LaunchTool) === JSON.stringify(['file']) && declared(ServiceTool) === JSON.stringify(['command', 'cwd']) && declared(MonitorTool) === JSON.stringify(['command']), [SendUserFileTool, TestTool, LaunchTool, ServiceTool, MonitorTool].map(declared).join(' '))
    check('the Aseprite tool straightens its sprite, output and data-output paths; the Lua source stays as typed', declared(AsepriteTool) === JSON.stringify(['file', 'output', 'dataOutput']), declared(AsepriteTool))
    check('the Workshop tool declares nothing: a cell is content and arrives as typed', declared(WorkshopTool) === 'null', declared(WorkshopTool))
  }
  check('replayableItems keeps the first function_call of a duplicated id and drops the rest', (() => {
    const pure = replayableItems(
      [
        { type: 'function_call', call_id: 'a', name: 'X', arguments: '{}' },
        { type: 'function_call', call_id: 'a', name: 'X', arguments: '{"n":2}' },
        { type: 'function_call', call_id: 'b', name: 'Y', arguments: '{}' },
      ],
      [{ id: 'a', code: 'duplicate-id' }],
    )
    return pure.map(i => (i.type === 'function_call' ? `${i.call_id}:${i.arguments}` : i.type)).join(',') === 'a:{},b:{}'
  })())
}

server.close()
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
