#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const key of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'ANTHROPIC_BASE_URL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_LOCAL_PROMPT_PROFILE', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_EFFORT_LEVEL', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_MODELS', 'MERCURY_CEREBRAS_API_BASE', 'MERCURY_GROQ_API_BASE', 'MERCURY_OPENROUTER_API_BASE']) delete process.env[key]

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the TensorFold pod wire proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

type Body = Record<string, any>
type Reply = 'text' | 'markup' | 'mixed'
const TASK_STOP_MARKUP = '<tool_call>\n<function=TaskStop>\n<parameter=task_id>\nb4avyo465\n</parameter>\n</function>\n</tool_call>'
const READ_MARKUP = '<tool_call>\n<function=Read>\n<parameter=file_path>\n/tmp/notes.txt\n</parameter>\n</function>\n</tool_call>'
const RUNTIME = { enable_thinking: true, reasoning_effort: 'high', engine: 'lanes', tokens_per_second: 357.25, seconds: 1.4, prefill_seconds: 0.21, time_to_first_token: 0.23 }
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
let reply: Reply = 'text'

function engine(served: string, window: number, owner: string): { root: string; bodies: Body[]; stop(): void } {
  const bodies: Body[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
    const path = new URL(request.url).pathname
    const headers: Record<string, string> = owner === 'tensorfold' ? { server: 'TensorFold' } : {}
    if (path === '/health') return Response.json({ status: 'ok', version: '1.2.2', model: served }, { headers })
    if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: served, object: 'model', created: 1, owned_by: owner, context_length: window, max_model_len: window, reasoning: { default_enabled: true, default_effort: 'medium', supported_efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] } }] }, { headers })
    if (request.method !== 'POST' || path !== '/v1/chat/completions') return new Response('not found', { status: 404 })
    const body = (await request.json()) as Body
    bodies.push(body)
    const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}): string => sse({ id: 'tf-fixture', object: 'chat.completion.chunk', created: 1, model: served, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
    const frames = [chunk({ role: 'assistant' }), chunk({ reasoning_content: 'Stopping the old server first.' })]
    if (reply === 'mixed') frames.push(chunk({ tool_calls: [{ index: 0, id: 'call_read_1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: '/tmp/notes.txt' }) } }] }))
    frames.push(chunk({ content: reply === 'text' ? 'TF-DONE' : TASK_STOP_MARKUP }))
    frames.push(chunk({}, reply === 'mixed' ? 'tool_calls' : 'stop', owner === 'tensorfold' ? { tensorfold: RUNTIME } : {}))
    frames.push(sse({ id: 'tf-fixture', object: 'chat.completion.chunk', created: 1, model: served, choices: [], usage: { prompt_tokens: 640, completion_tokens: 24, total_tokens: 664, prompt_tokens_details: { cached_tokens: 512 }, completion_tokens_details: { reasoning_tokens: 8 } } }))
    frames.push('data: [DONE]\n\n')
    return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream', ...headers } })
  } })
  return { root: `http://127.0.0.1:${server.port}`, bodies, stop: () => server.stop(true) }
}

const upstreamBodies: Body[] = []
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request: Request) {
  const path = new URL(request.url).pathname
  if (request.method !== 'POST' || !path.endsWith('/chat/completions')) return Response.json({ error: { message: 'not found' } }, { status: 404 })
  const body = (await request.json()) as Body
  upstreamBodies.push(body)
  const chunk = (delta: unknown, finish: string | null = null): string => sse({ id: 'upstream-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
  const frames = [chunk({ role: 'assistant', content: '' }), chunk({ content: READ_MARKUP }), chunk({}, 'stop'), sse({ id: 'upstream-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } }), 'data: [DONE]\n\n']
  return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } })
} })
const upstreamRoot = `http://127.0.0.1:${upstream.port}`

const big = engine('qwen3.8-27b', 262144, 'tensorfold')
const small = engine('qwen3.5-2b', 32768, 'tensorfold')
const vllm = engine('qwen3.8-27b', 262144, 'vllm')
const POD = 'compat/pod-tfpod/qwen3.8-27b'
const SMALL_POD = 'compat/pod-tfsmall/qwen3.5-2b'
const VLLM_POD = 'compat/pod-vllmpod/qwen3.8-27b'
const LOCAL = 'local/qwen3.8-27b'
const SMALL_LOCAL = 'local/qwen3.5-2b'
const OTHER_ROADS = ['cerebras/qwen-3.8-27b', 'groq/qwen/qwen3.8-27b', 'openrouter/qwen/qwen3.8-27b']
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max']
writeFileSync(join(proofHome, 'settings.json'), JSON.stringify({
  compatProvider: {
    'pod-tfpod': { baseUrl: `${big.root}/v1`, hostPodId: 'tfpod', dialect: 'chat-completions', models: ['qwen3.8-27b'] },
    'pod-tfsmall': { baseUrl: `${small.root}/v1`, hostPodId: 'tfsmall', dialect: 'chat-completions', models: ['qwen3.5-2b'] },
    'pod-vllmpod': { baseUrl: `${vllm.root}/v1`, hostPodId: 'vllmpod', dialect: 'vllm', models: ['qwen3.8-27b'] },
  },
  models: {
    [POD]: { contextWindow: 262144, efforts: LADDER },
    [SMALL_POD]: { contextWindow: 32768, efforts: LADDER },
    [VLLM_POD]: { contextWindow: 262144, efforts: LADDER },
  },
}))
process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=${big.root},tensorfold=${small.root}`
process.env.CEREBRAS_API_KEY = 'proof-key-tensorfold-pod-wire-not-a-real-key'
process.env.MERCURY_CEREBRAS_API_BASE = `${upstreamRoot}/v1`
process.env.GROQ_API_KEY = 'proof-key-tensorfold-pod-wire-not-a-real-key'
process.env.MERCURY_GROQ_API_BASE = `${upstreamRoot}/openai/v1`
process.env.OPENROUTER_API_KEY = 'proof-key-tensorfold-pod-wire-not-a-real-key'
process.env.MERCURY_OPENROUTER_API_BASE = `${upstreamRoot}/api/v1`

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool } = await import('../../src/tools.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localServerKind } = await import('../../src/constants/localPromptProfile.ts')
const { toolCallShapedAnswer } = await import('../../src/services/providers/local/toolCallMarkup.ts')
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { registerTensorFoldPod } = await import('../../src/services/host/tensorfoldPod.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const { writeHostRecord } = await import('../../src/services/host/store.ts')
const { tensorFoldHostAddress } = await import('../../src/services/providers/local/tensorfoldHosts.ts')
const ledger = await import('../../src/services/providers/local/tensorfoldUsage.ts')
type Message = import('../../src/types/message.ts').Message
type Tools = import('../../src/Tool.ts').Tools
type Block = { type: string; name?: string; input?: Record<string, unknown>; text?: string }
type Assistant = { type: 'assistant'; isApiErrorMessage?: boolean; outputLimit?: number; message: { content: Block[]; stop_reason?: string } }

const recipe = HOST_RECIPES.find(row => row.id === 'tensorfold-qwen38-27b-rtx-5090')!
const vllmRecipe = HOST_RECIPES.find(row => row.engine === 'vllm')!
const startedAt = new Date().toISOString()
const target = { host: '127.0.0.1', port: 22, user: 'root', key: join(proofHome, 'id_ed25519') }
for (const [id, root, served, window] of [['tfpod', big.root, 'qwen3.8-27b', 262144], ['tfsmall', small.root, 'qwen3.5-2b', 32768]] as const) {
  writeHostRecord({ vendor: 'runpod', id, name: `tf-proof-${id}`, recipe: recipe.id, recipeRow: recipe, price: 1.19, startedAt, status: 'RUNNING', jobKind: 'setup', jobState: 'ready', step: 'ready', provider: `pod-${id}`, localPort: Number(new URL(root).port), target })
  await registerTensorFoldPod({ id, vendor: 'runpod', recipe, baseUrl: `${root}/v1`, key: 'proof-pod-key-not-real', served, window, target })
}
writeHostRecord({ vendor: 'runpod', id: 'vllmpod', name: 'vllm-proof', recipe: vllmRecipe.id, recipeRow: vllmRecipe, price: 1.19, startedAt, status: 'RUNNING', jobKind: 'setup', jobState: 'ready', step: 'ready', provider: 'pod-vllmpod', localPort: Number(new URL(vllm.root).port), target })
await refreshLocalDiscovery({ force: true })

const permissionContext = getEmptyToolPermissionContext()
const pool: Tools = assembleToolPool(permissionContext, [])
const readOnly: Tools = pool.filter(tool => tool.name === 'Read')

let serial = 0
async function drive(model: string, history: Message[] | undefined, opts: { effortValue?: string; thinking?: boolean; tools?: Tools; bodies: Body[] }): Promise<{ body: Body | undefined; assistants: Assistant[]; errors: string[] }> {
  const tag = `case-${++serial}`
  const messages = history ?? [createUserMessage({ content: `Say hello (${tag}).` }) as Message]
  const before = opts.bodies.length
  const assistants: Assistant[] = []
  const errors: string[] = []
  clearToolRosterLatches()
  try {
    for await (const item of routedCallModel({
      messages,
      systemPrompt: ['You are a fixture assistant.'] as never,
      thinkingConfig: (opts.thinking === false ? { type: 'disabled' } : { type: 'enabled', budget_tokens: 1024 }) as never,
      tools: opts.tools ?? [],
      signal: AbortSignal.timeout(60_000),
      options: {
        getToolPermissionContext: async () => permissionContext,
        model,
        isNonInteractiveSession: true,
        querySource: 'main_thread',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        hasPendingMcpServers: false,
        ownerKey: `pod-wire-${tag}`,
        ...(opts.effortValue !== undefined ? { effortValue: opts.effortValue } : {}),
      } as never,
    })) {
      const row = item as unknown as Assistant
      if (row.type !== 'assistant') continue
      if (row.isApiErrorMessage === true) errors.push(JSON.stringify(row.message.content).slice(0, 300))
      else assistants.push(row)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const sent = opts.bodies.slice(before)
  const body = history === undefined ? sent.find(entry => JSON.stringify(entry.messages ?? []).includes(tag)) : sent.at(-1)
  return { body, assistants, errors }
}
const blocks = (run: { assistants: Assistant[] }): Block[] => run.assistants.flatMap(message => message.message.content)
const toolUses = (run: { assistants: Assistant[] }): Block[] => blocks(run).filter(block => block.type === 'tool_use')
const answerText = (run: { assistants: Assistant[] }): string => blocks(run).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
const knobs = (body: Body | undefined): string => JSON.stringify({ max_tokens: body?.max_tokens, reasoning_effort: body?.reasoning_effort, thinking_budget: body?.thinking_budget })
const declarationRows = (body: Body | undefined): Array<Record<string, unknown>> => (Array.isArray(body?.messages) ? (body!.messages as Array<Record<string, unknown>>) : []).slice(1)

section('§0 the gate: served by TensorFold is the fact the pod registration records (the pod box, engine tensorfold) — the same fact the local prompt profile reads')
check('a rented TensorFold pod reads as TensorFold-served on the compat road', localServerKind(POD) === 'tensorfold' && localServerKind(SMALL_POD) === 'tensorfold', `${localServerKind(POD)} · ${localServerKind(SMALL_POD)}`)
check('the local lane\'s TensorFold record reads the same', localServerKind(LOCAL) === 'tensorfold' && localServerKind(SMALL_LOCAL) === 'tensorfold')
check('a vLLM pod (no TensorFold box) is not TensorFold-served', localServerKind(VLLM_POD) === undefined, String(localServerKind(VLLM_POD)))
check('the same Qwen 3.8 27B on Cerebras, Groq and OpenRouter is not TensorFold-served', OTHER_ROADS.every(model => localServerKind(model) === undefined))
check('both fixture engines are discovered by the local lane with their served windows', localRecordFor(LOCAL)?.contextWindow?.tokens === 262144 && localRecordFor(SMALL_LOCAL)?.contextWindow?.tokens === 32768, JSON.stringify([localRecordFor(LOCAL)?.contextWindow, localRecordFor(SMALL_LOCAL)?.contextWindow]))

section('§1 max_tokens and the thinking budget: the pod road sends what the local lane sends for the same window and effort')
reply = 'text'
for (const [label, pod, local, bodies, ceiling] of [['256k window', POD, LOCAL, big.bodies, 32768], ['32k window', SMALL_POD, SMALL_LOCAL, small.bodies, 16384]] as const) {
  for (const [effortValue, thinking] of [['high', true], ['high', false], ['low', true], ['medium', true], ['max', true]] as const) {
    const onPod = await drive(pod, undefined, { effortValue, thinking, bodies })
    const onLocal = await drive(local, undefined, { effortValue, thinking, bodies })
    const name = `${label}, effort ${effortValue}${thinking ? '' : ' with thinking off'}`
    check(`${name}: RED ON THE BASE — the pod request carries max_tokens, and it is the local lane's (${onLocal.body?.max_tokens})`, onPod.errors.length === 0 && typeof onPod.body?.max_tokens === 'number' && onPod.body.max_tokens === onLocal.body?.max_tokens, `pod ${knobs(onPod.body)} · local ${knobs(onLocal.body)} ${onPod.errors.join(' | ')}`)
    check(`${name}: reasoning_effort and thinking_budget match the local lane (${knobs(onLocal.body)})`, onPod.body?.reasoning_effort === onLocal.body?.reasoning_effort && onPod.body?.thinking_budget === onLocal.body?.thinking_budget, `pod ${knobs(onPod.body)} · local ${knobs(onLocal.body)}`)
    if (effortValue === 'high' && thinking) {
      check(`${label}: the law, not a literal — max_tokens is min(32768, window/2) = ${ceiling}, the thinking budget leaves the 2048-token answer reserve`, onLocal.body?.max_tokens === ceiling && onPod.body?.max_tokens === ceiling && onPod.body?.thinking_budget === Math.min(16384, ceiling - 2048), knobs(onPod.body))
      check(`${label}: the reply carries the limit its request sent (outputLimit ${ceiling}) on both TensorFold roads`, onPod.assistants.at(-1)?.outputLimit === ceiling && onLocal.assistants.at(-1)?.outputLimit === ceiling, `${onPod.assistants.at(-1)?.outputLimit} · ${onLocal.assistants.at(-1)?.outputLimit}`)
    }
  }
}

section('§2 a deferred tool loaded through ToolSearch and called as Qwen markup runs on the pod road')
const context = { options: { tools: pool }, getAppState: () => ({ toolPermissionContext: { ...permissionContext, mode: 'default' }, mcp: { clients: [] } }) }
const searched = await ToolSearchTool.call({ query: 'select:TaskStop', max_results: 5 }, context as never)
const admission = ToolSearchTool.mapToolResultToToolResultBlockParam((searched as { data: unknown }).data as never, 'toolu_ts_1')
const history: Message[] = [
  createUserMessage({ content: 'Stop the old server, then restart it with the fix.' }) as Message,
  createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_ts_1', name: 'ToolSearch', input: { query: 'select:TaskStop' } }] as never }) as Message,
  createUserMessage({ content: [admission] as never }) as Message,
]
reply = 'markup'
const markup = await drive(POD, history, { effortValue: 'high', tools: pool, bodies: big.bodies })
check('the request rode the pod road without a refusal', markup.errors.length === 0 && markup.body !== undefined, markup.errors.join(' | '))
check('TaskStop stays out of the tools term (the text-append form keeps it frozen) and its definition rides as text', !(markup.body?.tools ?? []).some((tool: Body) => tool.function?.name === 'TaskStop') && declarationRows(markup.body).some(row => String(row.content ?? '').includes('"name":"TaskStop"')), (markup.body?.tools ?? []).map((tool: Body) => tool.function?.name).join(','))
check('RED ON THE BASE: the markup becomes a TaskStop tool_use with its task_id, and the stop reason is tool_use', toolUses(markup).length === 1 && toolUses(markup)[0]!.name === 'TaskStop' && toolUses(markup)[0]!.input?.task_id === 'b4avyo465' && markup.assistants.at(-1)?.message.stop_reason === 'tool_use', JSON.stringify(blocks(markup)).slice(0, 400))
check('RED ON THE BASE: no answer text is left for the rows to report as "a tool call (TaskStop) that was not executed"', toolCallShapedAnswer(answerText(markup)) === undefined, JSON.stringify(toolCallShapedAnswer(answerText(markup))))
check('RED ON THE BASE: the definition rides inside the ToolSearch result, as on the local lane — no mid-conversation system row (TensorFold renders one as a user turn)', declarationRows(markup.body).every(row => row.role !== 'system') && String(declarationRows(markup.body).find(row => row.role === 'tool' && row.tool_call_id === 'toolu_ts_1')?.content ?? '').includes('"name":"TaskStop"'), declarationRows(markup.body).map(row => String(row.role)).join(','))
reply = 'mixed'
const mixed = await drive(POD, history, { effortValue: 'high', tools: pool, bodies: big.bodies })
check('RED ON THE BASE: TaskStop markup left beside a call the engine parsed runs too, after it (Read, then TaskStop)', toolUses(mixed).map(block => block.name).join(',') === 'Read,TaskStop' && toolUses(mixed)[1]!.input?.task_id === 'b4avyo465' && !answerText(mixed).includes('<tool_call>'), JSON.stringify(blocks(mixed)).slice(0, 400))
const localMixed = await drive(LOCAL, history, { effortValue: 'high', tools: pool, bodies: big.bodies })
check('the local TensorFold lane reads the markup beside a parsed call the same way', toolUses(localMixed).map(block => block.name).join(',') === 'Read,TaskStop', JSON.stringify(blocks(localMixed)).slice(0, 300))
reply = 'markup'
const localMarkup = await drive(LOCAL, history, { effortValue: 'high', tools: pool, bodies: big.bodies })
check('the local lane still reads a whole-reply markup call (unchanged)', toolUses(localMarkup).map(block => block.name).join(',') === 'TaskStop', JSON.stringify(blocks(localMarkup)).slice(0, 300))

section('§3 the engine\'s runtime block is recorded for a pod turn, as for a local TensorFold turn')
reply = 'text'
ledger.__resetTensorFoldUsageForTest()
const recorded = await drive(POD, undefined, { effortValue: 'high', bodies: big.bodies })
const turn = ledger.lastTensorFoldTurn()
check('the turn completed', recorded.errors.length === 0 && answerText(recorded).includes('TF-DONE'), recorded.errors.join(' | '))
check('RED ON THE BASE: the /usage ledger holds the pod turn: tok/s, first token, prefill, prompt and cached tokens, at the tunnel address', ledger.tensorFoldTurnReadings().length === 1 && turn?.model === 'qwen3.8-27b' && turn.address === tensorFoldHostAddress(big.root) && turn.tokensPerSecond === 357.25 && turn.timeToFirstTokenS === 0.23 && turn.prefillSeconds === 0.21 && turn.promptTokens === 640 && turn.cachedTokens === 512 && turn.reasoningTokens === 8, JSON.stringify(turn))
check('the ledger line reads the pod turn', ledger.tensorFoldUsageLines()[0]?.startsWith('last turn · qwen3.8-27b · ~357 tok/s · first token in 230 ms · prefill 210 ms · 640 in (512 cached) · 24 out (8 thinking)') === true, JSON.stringify(ledger.tensorFoldUsageLines()))

section('§4 every other road is unchanged: a vLLM pod, Cerebras, Groq and OpenRouter')
reply = 'markup'
const ledgerRows = ledger.tensorFoldTurnReadings().length
const onVllm = await drive(VLLM_POD, history, { effortValue: 'high', tools: pool, bodies: vllm.bodies })
check('the vLLM pod: the markup stays text, nothing is minted from it', onVllm.errors.length === 0 && toolUses(onVllm).length === 0 && answerText(onVllm).includes('<function=TaskStop>'), JSON.stringify(blocks(onVllm)).slice(0, 300))
check('the vLLM pod: no max_tokens and no thinking_budget join its request', onVllm.body !== undefined && !('max_tokens' in onVllm.body) && !('thinking_budget' in onVllm.body), knobs(onVllm.body))
check('the vLLM pod: the admitted definition keeps its own row after the result', declarationRows(onVllm.body).some(row => row.role === 'system' && String(row.content).includes('"name":"TaskStop"')), declarationRows(onVllm.body).map(row => String(row.role)).join(','))
check('the vLLM pod: no outputLimit stamp and no ledger row', onVllm.assistants.every(message => message.outputLimit === undefined) && ledger.tensorFoldTurnReadings().length === ledgerRows, `${ledgerRows} → ${ledger.tensorFoldTurnReadings().length}`)
for (const model of OTHER_ROADS) {
  const before = upstreamBodies.length
  const run = await drive(model, [createUserMessage({ content: `Read the notes (${model}).` }) as Message], { effortValue: 'high', tools: readOnly, bodies: upstreamBodies })
  const body = upstreamBodies.slice(before).at(-1)
  check(`${model}: the request went out and the markup stays text`, run.errors.length === 0 && body !== undefined && toolUses(run).length === 0 && answerText(run).includes('<function=Read>'), `${run.errors.join(' | ')} ${JSON.stringify(blocks(run)).slice(0, 200)}`)
  check(`${model}: no max_tokens, no thinking_budget, no outputLimit stamp`, body !== undefined && !('max_tokens' in body) && !('thinking_budget' in body) && run.assistants.every(message => message.outputLimit === undefined), knobs(body))
}

big.stop()
small.stop()
vllm.stop()
upstream.stop(true)
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} TENSORFOLD POD WIRE CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ TENSORFOLD POD WIRE PROOF PASSES')
process.exit(0)
