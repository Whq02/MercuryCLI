#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-tool-call-gate.ts — schema enforcement at
//  the transport boundary, fuzzed through EVERY dialect Mercury speaks.
//
//  The Anthropic wire hands Mercury tool_use blocks whose inputs the API
//  already checked against the tool's schema. Every other family streams
//  function-call arguments as raw text Mercury parses itself, so the gate in
//  src/services/providers/toolCallGate.ts is the only thing standing between
//  a model's `Bash {}` and a harness holding an input it cannot execute.
//
//  This prover drives the REAL provider-routed transport (routedCallModel →
//  each lane's runtime → its decoder → the gate) against ONE loopback
//  fixture server that speaks both wire dialects, with the REAL tool catalog
//  (Bash · Read · Edit · Write · Glob · Grep · EnterPlanMode), and streams
//  the malformed-call class through every lane:
//
//    Responses dialect ........ openai (gpt-*)
//    chat-completions dialect . zai · moonshot · deepseek · compat slot ·
//                               openrouter · gemini · huggingface · local
//
//  Cases per lane: valid · empty `{}` on a tool with required params ·
//  wrong-typed · unknown field on a STRICT tool · unknown field on a
//  permissive tool (accepted — the one schema owner says so) · malformed
//  JSON · partial arguments assembled across fragments (settles before
//  validation) · unknown tool · no tool name · no call id · top-level null
//  optional (stripped, accepted) · non-object arguments · a mixed turn (one
//  accepted + one refused) · empty argument string on a no-parameter tool.
//
// The invariant asserted over EVERY lane and EVERY case: the generator
//  never throws; no tool_use block is ever minted whose input fails its
//  tool's own schema; every refused call settles as ONE visible note that
//  carries the typed refusal record with the expected code; stop_reason is
//  'tool_use' iff a block was minted. The Responses lane additionally
//  proves its stateless-replay record never carries a refused call nor a
//  reasoning item stranded by one.
//
//  Endpoint bases: EVERY provider base (and the OAuth hosts) pinned to the
//  loopback fixture BEFORE any src import; the VCR inert; local discovery
//  sees only the fixture. Nothing here can reach a live service.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-tool-call-gate.ts
// ============================================================================
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

// ── env hygiene BEFORE any src import ───────────────────────────────────────
delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tool-call-gate-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── the loopback fixture: both dialects, one server ─────────────────────────
type ScriptedCall = {
  id?: string
  name?: string
  /** Raw argument bytes; `fragments` overrides how they stream. */
  args: string
  fragments?: string[]
}
type Script = {
  calls: ScriptedCall[]
  /** A reasoning item ahead of the first call (Responses dialect only). */
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

// The OpenAI lane qualifies its model against the LIVE catalogue — the
// fixture serves the live-shaped body the callmodel prover banked.
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
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-local', object: 'model', owned_by: 'fixture' }] }))
      }
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

// Every provider base — dispatch AND auth hosts — pinned to the fixture.
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

// Every real tool's zod schema is strict (unrecognized keys refuse) — the
// permissive law is pinned on ONE synthetic non-strict tool beside them, so
// both sides of "the schema owner decides" are proven.
const { z } = await import('zod/v4')
const PermissiveFixtureTool = {
  name: 'PermissiveFixture',
  inputSchema: z.object({ text: z.string() }),
  prompt: async () => 'fixture tool with a permissive schema',
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
] as never
const BASH = BashTool.name
const READ = FileReadTool.name
const PLAN = EnterPlanModeTool.name
const PERMISSIVE = PermissiveFixtureTool.name

// ── the lanes (model id → dialect) ──────────────────────────────────────────
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

// ── the case table ──────────────────────────────────────────────────────────
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

// ── the driver ──────────────────────────────────────────────────────────────
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

/** The invariant every minted block must satisfy: its tool's own schema
 *  accepts its input. */
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
  // (Bash's own input normalization may add undefined-valued keys; the law
  // is that no NULL survives and the optionals read as omitted.)
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
  // The pure filter, pinned on its edge shapes.
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
