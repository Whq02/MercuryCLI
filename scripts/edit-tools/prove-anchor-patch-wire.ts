#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-anchor-patch-wire.ts — the patch dialect on the
//  OpenAI-compatible families' call shapes (the multi-auth point of spec 02:
//  the published win of this class is on weaker models, which reach Mercury
//  through chat-completions function calls, not Anthropic tool_use).
//
//  Drives the REAL provider transport (routedCallModel → lane runtime →
//  decoder → toolCallGate) against ONE loopback fixture speaking both wire
//  dialects, with the REAL ChangeSet tool in the catalog, and asserts for
// EVERY lane:
//    · a multi-line patch riding function-call arguments (JSON-escaped
//      string) mints ONE ChangeSet tool_use whose input.patch is the EXACT
//      patch text — newlines, quotes and backslashes intact;
//    · the same bytes split across SSE fragments MID-ESCAPE reassemble to
//      the identical input (the streaming hazard weaker models hit);
//    · the recovered patch parses clean in the dialect grammar and passes
//      the tool's own validateInput;
//    · nothing is refused, stop_reason is tool_use.
//
//  Lanes: openai (Responses dialect) · zai · moonshot · deepseek · compat
//  (chat-completions dialect). Every endpoint base is pinned to the fixture
//  BEFORE any src import — nothing here can reach a live service.
//
//  Run: ~/.bun/bin/bun run scripts/edit-tools/prove-anchor-patch-wire.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

// ── env hygiene BEFORE any src import ───────────────────────────────────────
delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'anchor-patch-wire-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_ANCHOR_PATCH = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type ScriptedCall = { id?: string; name?: string; args: string; fragments?: string[] }
type Script = { calls: ScriptedCall[] }
let script: Script = { calls: [] }

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
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        path.startsWith('/openai/')
          ? JSON.stringify(OPENAI_MODELS_BODY)
          : JSON.stringify({ object: 'list', data: [{ id: 'fixture-local', object: 'model', owned_by: 'fixture' }] }),
      )
      return
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatCompletionsSse(script))
      return
    }
    if (req.method === 'POST' && path.endsWith('/responses')) {
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
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
})

console.log('============================================================')
console.log(' the patch dialect on every OpenAI-compatible call shape')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { parseAnchorPatch } = await import('../../src/services/changeTransaction/anchorPatch.ts')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

const CATALOG = [ChangeSetTool, FileReadTool] as never

// The patch a model would emit: multi-file, quotes, backslashes, a blank
// body row — the exact classes JSON escaping and SSE fragmentation mangle.
const PATCH = [
  'file /tmp/wire/alpha.ts fa:0123456789ab',
  'replace 2-3',
  '| const s = "a\\nb"   // literal backslash-n inside a string',
  '|',
  '| const re = /\\\\d+/',
  'cut 10-12 into helpers',
  'file /tmp/wire/beta.ts fa:ba9876543210',
  'paste helpers after 1',
].join('\n')

const ARGS = JSON.stringify({ op: 'preview', patch: PATCH })

/** Split a string into pieces of n chars — deliberately slicing through
 *  JSON escape sequences. */
function shard(s: string, n: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
  return out
}

async function drive(model: string, s: Script) {
  script = s
  const assistants: AssistantMessage[] = []
  let threw: unknown
  try {
    const gen = routedCallModel({
      messages: [createUserMessage({ content: 'apply the fixture patch' })] as never,
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
  const toolUses: Array<{ name: string; input: Record<string, unknown> }> = []
  let stop: string | undefined
  for (const a of assistants) {
    const msg = (a as { message?: { content?: unknown; stop_reason?: string } }).message
    if (msg?.stop_reason) stop = msg.stop_reason
    const content = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : []
    for (const blockRaw of content) {
      if (blockRaw.type === 'tool_use') {
        toolUses.push({ name: String(blockRaw.name), input: (blockRaw.input ?? {}) as Record<string, unknown> })
      }
    }
  }
  return { toolUses, stop, threw }
}

const LANES: Array<{ lane: string; model: string }> = [
  { lane: 'openai (Responses dialect)', model: 'gpt-5.6-sol' },
  { lane: 'zai', model: 'glm-5.2' },
  { lane: 'moonshot', model: 'kimi-k3' },
  { lane: 'deepseek', model: 'deepseek-v4-pro' },
  { lane: 'openai-compat slot', model: 'compat/fixture-model' },
]

for (const { lane, model } of LANES) {
  console.log(`\n— ${lane} —`)
  for (const [label, call] of [
    ['one-shot arguments', { id: 'call_patch', name: ChangeSetTool.name, args: ARGS }],
    [
      'arguments sharded mid-escape (7-char SSE fragments)',
      { id: 'call_patch_frag', name: ChangeSetTool.name, args: ARGS, fragments: shard(ARGS, 7) },
    ],
  ] as Array<[string, ScriptedCall]>) {
    const r = await drive(model, { calls: [call] })
    check(`${label}: transport did not throw`, r.threw === undefined, String(r.threw))
    check(`${label}: exactly one ChangeSet tool_use, stop_reason tool_use`, r.toolUses.length === 1 && r.stop === 'tool_use', `uses=${r.toolUses.length} stop=${r.stop}`)
    const input = r.toolUses[0]?.input
    const patchText = typeof input?.patch === 'string' ? (input.patch as string) : undefined
    check(`${label}: input.patch survived the wire byte-exact`, patchText === PATCH, patchText === undefined ? 'no patch field' : `len ${patchText.length} vs ${PATCH.length}`)
    if (patchText === PATCH) {
      const parsed = parseAnchorPatch(patchText)
      check(`${label}: the recovered patch parses in the dialect`, parsed.ok && parsed.sections.length === 2, parsed.ok ? '' : JSON.stringify(parsed))
      const valid = await (ChangeSetTool as { validateInput: Function }).validateInput(input)
      check(`${label}: the tool's own validateInput accepts it`, valid.result === true, JSON.stringify(valid))
    }
  }
}

server.close()
console.log('')
if (failures > 0) {
  console.log(`RED: ${failures} failing check(s)`)
  process.exit(1)
}
console.log('GREEN: the dialect rides every OpenAI-compatible call shape byte-exact — fragments, escapes and all')
