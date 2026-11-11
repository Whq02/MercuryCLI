#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-qwen-template-efforts-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''

const QWEN_REPO = 'Qwen/Qwen3.8-27B'
const QWEN_GGUF = 'Qwen3.8-27B-Q4_K_M.gguf'
const QWEN_SERVED_NAME = 'qwen-3.8-27b'
const QWEN_RENAMED_GGUF = 'qwen3_8-27b-q4_k_m.gguf'
const QWEN3_8B_GGUF = 'Qwen3-8B-Q4_K_M.gguf'
const OLDER_QWEN = 'Qwen/Qwen3.6-27B'
const OTHER = 'google/gemma-4-26b-a4b'
const TEMPLATE_WORDS = ['xhigh', 'medium', 'low']
const ASKED = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const SIX = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

type Hit = { server: string; body: Record<string, unknown> }
const hits: Hit[] = []
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
function templateRaise(body: Record<string, unknown>): string | undefined {
  if (!/qwen3\.8/i.test(String(body.model)) && body.model !== QWEN_SERVED_NAME && body.model !== QWEN_RENAMED_GGUF) return undefined
  const kwargs = (body.chat_template_kwargs ?? {}) as Record<string, unknown>
  if (kwargs.enable_thinking === false) return undefined
  const word = body.reasoning_effort ?? kwargs.reasoning_effort
  return word === undefined || TEMPLATE_WORDS.includes(String(word)) ? undefined : `Unexpected reasoning effort ${String(word)}. Supported types are xhigh (default), medium, and low.`
}
function serve(kind: 'vllm' | 'llamacpp'): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = ''
      req.on('data', chunk => {
        raw += String(chunk)
      })
      req.on('end', () => {
        const url = req.url ?? ''
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        if (kind === 'vllm' && url === '/v1/models') return json(res, 200, { object: 'list', data: [QWEN_REPO, QWEN_SERVED_NAME, OLDER_QWEN, OTHER].map(id => ({ id, object: 'model', owned_by: 'vllm', max_model_len: 262144 })) })
        if (kind === 'llamacpp' && url === '/v1/models') return json(res, 200, { object: 'list', data: [QWEN_GGUF, QWEN_RENAMED_GGUF, QWEN3_8B_GGUF].map(id => ({ id, object: 'model', owned_by: 'llamacpp', meta: { n_ctx_train: 262144, n_params: 27320697856, size: 17741872134 } })) })
        if (kind === 'llamacpp' && url === '/props') return json(res, 200, { default_generation_settings: { n_ctx: 65536 }, build_info: 'b7000', total_slots: 1 })
        if (url === '/v1/chat/completions' && req.method === 'POST') {
          hits.push({ server: kind, body })
          const raised = templateRaise(body)
          if (raised !== undefined) return json(res, kind === 'vllm' ? 400 : 500, { error: { message: raised, type: kind === 'vllm' ? 'BadRequestError' : 'server_error', code: kind === 'vllm' ? 400 : 500 } })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        json(res, 404, { error: 'not found' })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, root: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}` })
    })
  })
}

const vllm = await serve('vllm')
const llamacpp = await serve('llamacpp')
process.env.MERCURY_LOCAL_PROBE_TARGETS = `vllm=${vllm.root},llamacpp=${llamacpp.root}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const template = await import('../../src/services/providers/qwen/qwenTemplate.ts')
const { effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const { resolveEffortTruth } = await import('../../src/utils/effort.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const local = await import('../../src/services/providers/local/localCallModel.ts')
const { LOCAL_SERVER_EFFORTS } = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
await refreshLocalDiscovery({ force: true })

async function ask(id: string, effortValue: string | undefined): Promise<{ sent: unknown; chats: number; error: string | undefined; text: string }> {
  const before = hits.length
  let error: string | undefined
  let text = ''
  for await (const item of local.localCallModel({
    messages: [{ type: 'user', message: { role: 'user', content: 'ping' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
    systemPrompt: ['You are a proof seat.'] as never,
    thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model: `local/${id}`, querySource: 'main_thread', ...(effortValue !== undefined ? { effortValue } : {}), getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
  })) {
    const row = item as { type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ text?: string }> } }
    const words = (row.message?.content ?? []).map(block => block.text ?? '').join('')
    if (row.type === 'assistant' && row.isApiErrorMessage === true) error = words
    else if (row.type === 'assistant') text += words
  }
  const sent = hits.slice(before)
  return { sent: sent.at(-1)?.body.reasoning_effort, chats: sent.length, error, text }
}

section("1 · the rule: which ids name a model whose template reads reasoning_effort and refuses every word but xhigh, medium and low (Qwen 3.8 onward; read from the vendor's chat_template.jinja)")
{
  const reads = ['Qwen/Qwen3.8-27B', 'Qwen3.8-27B-Q4_K_M.gguf', 'qwen3.8:27b', 'Qwen/Qwen3.8-Flash-Next', 'Qwen/Qwen3.8-2.4T-A95B-FP8', '/models/Qwen3.8-27B', 'qwen4-27b', 'Qwen/Qwen4-27B', 'qwen4.gguf']
  const spelled = ['qwen-3.8-27b', 'Qwen-3.8-27B', 'qwen_3.8_27b', 'qwen 3.8 27b.gguf', 'qwen3_8-27b-q4_k_m.gguf', 'Qwen_Qwen3.8-27B-Q4_K_M.gguf', 'qwen-4-27b']
  const sized = ['Qwen3-8B-Q4_K_M.gguf', 'qwen3_8b.gguf', 'qwen-3-8b.gguf', 'qwen3-8-27b.gguf', 'qwen-2.5-coder-7b.gguf', 'qwen3_6-27b.gguf', 'qwen-72b-chat', 'qwen-max', 'qwen-vl-max-2025-08-13']
  const others = ['qwen40', 'qwen45-turbo', 'Qwen/Qwen3.6-27B', 'Qwen/Qwen3.5-9B', 'qwen2.5-coder:3b', 'Qwen/Qwen3-Coder-Next', 'Qwen/Qwen-AgentWorld-35B-A3B', OTHER, 'kimi-k3']
  check('Qwen 3.8 and Qwen 4 ids read it, by repo id, GGUF name, tag or path', reads.every(id => template.qwenTemplateReadsEffort(id)), j(reads.filter(id => !template.qwenTemplateReadsEffort(id))))
  check('the same generation spelled with a mark after the family word or an underscore for the point (qwen-3.8-27b, qwen_3.8_27b, qwen3_8-27b…) reads it too', spelled.every(id => template.qwenTemplateReadsEffort(id)), j(spelled.filter(id => !template.qwenTemplateReadsEffort(id))))
  check('a parameter count is not a generation (Qwen3-8B, qwen3_8b, qwen-3-8b), nor an older generation in either spelling, nor a hosted name with no generation', sized.every(id => !template.qwenTemplateReadsEffort(id)), j(sized.filter(id => template.qwenTemplateReadsEffort(id))))
  check('a generation glued to more digits (qwen40, qwen45-turbo), the older open weights (3.5, 3.6: no reasoning_effort in their template) and other families do not', others.every(id => !template.qwenTemplateReadsEffort(id)), j(others.filter(id => template.qwenTemplateReadsEffort(id))))
  check("the words and the map: low · medium · xhigh; none and minimal step to low, high and max to xhigh; a word outside Mercury's ladder maps to nothing", j(template.QWEN_TEMPLATE_EFFORTS) === j(['low', 'medium', 'xhigh']) && j(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(word => template.qwenTemplateEffort(word))) === j(['low', 'low', 'low', 'medium', 'xhigh', 'xhigh', 'xhigh', undefined]), j(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(word => template.qwenTemplateEffort(word))))
  const qwenRecipes = HOST_RECIPES.filter(row => row.model.startsWith('Qwen/Qwen3.8') && row.efforts !== undefined)
  check("the hosting recipes' verified Qwen 3.8 rows state the same three words", qwenRecipes.length >= 3 && qwenRecipes.every(row => j([...row.efforts!.levels].sort()) === j([...template.QWEN_TEMPLATE_EFFORTS].sort())), j(qwenRecipes.map(row => [row.id, row.efforts?.levels])))
}

section('2 · the view: a vLLM or llama.cpp row serving Qwen 3.8 offers low · medium · xhigh (red on the base: the six server words); every other row keeps what it had')
{
  const expected = { kind: 'provider', source: 'local', vocabulary: ['low', 'medium', 'xhigh'], thinkingGated: false, steps: template.QWEN_TEMPLATE_EFFORT_STEPS }
  check('discovery: the two Qwen 3.8 rows, an older Qwen and another family on vLLM and llama.cpp', localRecordFor(`local/${QWEN_REPO}`)?.server === 'vllm' && localRecordFor(`local/${QWEN_GGUF}`)?.server === 'llamacpp' && localRecordFor(`local/${OLDER_QWEN}`)?.server === 'vllm' && localRecordFor(`local/${OTHER}`)?.server === 'vllm')
  check('the vLLM row: low · medium · xhigh with the word map', j(effortVocabularyFor(`local/${QWEN_REPO}`)) === j(expected), j(effortVocabularyFor(`local/${QWEN_REPO}`)))
  check('the llama.cpp row: the same', j(effortVocabularyFor(`local/${QWEN_GGUF}`)) === j(expected), j(effortVocabularyFor(`local/${QWEN_GGUF}`)))
  for (const id of [OLDER_QWEN, OTHER]) {
    check(`${id} keeps the six server words and no map`, j(effortVocabularyFor(`local/${id}`)) === j({ kind: 'provider', source: 'local', vocabulary: SIX, thinkingGated: false }), j(effortVocabularyFor(`local/${id}`)))
  }
  const servedEfforts = (local as Partial<typeof local>).localServedEfforts
  check('an Ollama row is not this rule\'s: its words come from the server\'s own statement', servedEfforts !== undefined && j(servedEfforts({ id: 'qwen3.8:27b', server: 'ollama', baseUrl: 'x' })) === j({ vocabulary: LOCAL_SERVER_EFFORTS.ollama }), servedEfforts === undefined ? 'localServedEfforts is not exported by this tree' : '')
  const high = resolveEffortTruth(`local/${QWEN_REPO}`, 'high', { thinkingEnabled: true })
  check('the truth for a saved high: wire and label xhigh, adjusted from high; the selectable rungs are the three', high.wire === 'xhigh' && high.label === 'xhigh' && high.adjustedFrom === 'high' && j(high.selectable) === j(['low', 'medium', 'xhigh']), j({ wire: high.wire, label: high.label, adjustedFrom: high.adjustedFrom, selectable: high.selectable }))
}

section("3 · the wire: whatever word is asked, the request carries one the template accepts and the turn settles (red on the base: minimal, high and max ride as they stand and the template's refusal ends the turn)")
{
  for (const id of [QWEN_REPO, QWEN_GGUF, QWEN_SERVED_NAME, QWEN_RENAMED_GGUF]) {
    const server = `${localRecordFor(`local/${id}`)!.server} ${id}`
    const outcomes: Array<{ word: string; sent: unknown; chats: number; error: string | undefined; text: string }> = []
    for (const word of ASKED) outcomes.push({ word, ...(await ask(id, word)) })
    check(`${server}: every one of the six asked words settles in one request with no refusal`, outcomes.every(row => row.error === undefined && row.text === 'pong' && row.chats === 1), j(outcomes.filter(row => row.error !== undefined || row.chats !== 1).map(row => [row.word, row.sent, row.chats, row.error?.slice(0, 160)])))
    check(`${server}: minimal → low · low → low · medium → medium · high → xhigh · xhigh → xhigh · max → xhigh`, j(outcomes.map(row => row.sent)) === j(['low', 'low', 'medium', 'xhigh', 'xhigh', 'xhigh']), j(outcomes.map(row => [row.word, row.sent])))
    const bare = await ask(id, undefined)
    check(`${server}: with no word asked no reasoning_effort rides (the template's own default stands)`, bare.sent === undefined && bare.error === undefined && bare.chats === 1, j(bare))
  }
  const other = await ask(OTHER, 'high')
  check('another family on the same vLLM still carries the asked word unchanged (high)', other.sent === 'high' && other.error === undefined, j(other))
  const eightB = await ask(QWEN3_8B_GGUF, 'high')
  check('a Qwen3 of eight billion parameters on the same llama.cpp carries the asked word unchanged (high)', eightB.sent === 'high' && eightB.error === undefined, j(eightB))
  const older = await ask(OLDER_QWEN, 'max')
  check('an older Qwen whose template does not read the word still carries it unchanged (max)', older.sent === 'max' && older.error === undefined, j(older))
}

vllm.server.close()
llamacpp.server.close()
rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
