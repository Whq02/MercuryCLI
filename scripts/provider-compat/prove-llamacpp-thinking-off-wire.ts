import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const childHome = process.argv[2] === '--scratch-home' ? process.argv[3] : undefined
const HOME = childHome ?? mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), 'llamacpp-thinking-off-'))
if (childHome === undefined) {
  let status = 1
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scratch-home', HOME], { env: { ...process.env, HOME, USERPROFILE: HOME }, stdio: 'inherit' })
    status = child.status ?? 1
  } finally {
    rmSync(HOME, { recursive: true, force: true })
  }
  process.exit(status)
}
if (realpathSync(homedir()) !== realpathSync(HOME)) throw new Error('The llama.cpp thinking-off proof requires its scratch HOME at process start.')

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_TOOL_DEFER = '0'

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
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the llama.cpp thinking-off proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const MODEL = 'qwen3.5-2b'
const LOCAL = `local/${MODEL}`
const COMPAT = `compat/lab/${MODEL}`
const RACK = `compat/rack/${MODEL}`
type Wire = Record<string, unknown> & { messages?: unknown[] }
const chats: Wire[] = []

function engine(): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = ''
      req.on('data', chunk => {
        raw += String(chunk)
      })
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0]
        const json = (status: number, value: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(value))
        }
        if (req.method === 'GET' && path === '/health') return json(200, { status: 'ok' })
        if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return json(200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'llamacpp', meta: { n_ctx: 65536, n_ctx_train: 262144, n_params: 1881825088, size: 1269873920 } }] })
        if (req.method === 'GET' && path === '/props') return json(200, { default_generation_settings: { n_ctx: 65536 }, total_slots: 2, modalities: { vision: false }, chat_template_caps: { supports_tools: true, supports_tool_calls: true, supports_preserve_reasoning: false, supports_reasoning_effort: false, reasoning_effort_levels: [] }, build_info: 'b12359-b1b770d90' })
        if (req.method === 'GET' && path === '/slots') return json(200, [{ id: 0, n_ctx: 65536, is_processing: false }, { id: 1, n_ctx: 65536, is_processing: false }])
        if (req.method === 'GET' && path === '/metrics') {
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
          res.end('llamacpp:prompt_tokens_seconds 1200\n')
          return
        }
        if (req.method === 'POST' && path === '/v1/chat/completions') {
          const body = JSON.parse(raw) as Wire
          chats.push(body)
          const base = { created: 1_794_000_000, id: 'chatcmpl-fixture', model: MODEL, system_fingerprint: 'b12359-b1b770d90', object: 'chat.completion.chunk' }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const event = (value: Record<string, unknown>): void => void res.write(`data: ${JSON.stringify({ ...value, ...base })}\n\n`)
          event({ choices: [{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }] })
          if (body.reasoning_effort !== 'none') event({ choices: [{ finish_reason: null, index: 0, delta: { reasoning_content: 'The user wants the single word pong.' } }] })
          event({ choices: [{ finish_reason: null, index: 0, delta: { content: 'pong' } }] })
          event({ choices: [{ finish_reason: 'stop', index: 0, delta: {} }] })
          event({ choices: [], usage: { completion_tokens: 12, prompt_tokens: 400, total_tokens: 412, prompt_tokens_details: { cached_tokens: 0 } } })
          res.end('data: [DONE]\n\n')
          return
        }
        json(404, { error: { message: 'File Not Found', type: 'not_found_error', code: 404 } })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}

const llama = await engine()
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ compatProvider: {
  lab: { baseUrl: `${llama.root}/v1`, dialect: 'llamacpp' },
  rack: { baseUrl: `${llama.root}/v1`, dialect: 'vllm', models: [MODEL] },
} }) + '\n')
process.env.MERCURY_LOCAL_PROBE_TARGETS = `llamacpp=${llama.root}`

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
resetSettingsCache()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const wire = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const { resolveEffortTruth } = await import('../../src/utils/effort.ts')
type Message = import('../../src/types/message.ts').Message

await refreshLocalDiscovery({ force: true })
const permissionContext = getEmptyToolPermissionContext()

type Turn = { body: Wire | undefined; sent: number; error: string | undefined; thinking: number; text: string; stamp: { asked?: string; applied?: string; wire?: string } | undefined }
async function turn(model: string, thinking: boolean, effortValue?: string): Promise<Turn> {
  const before = chats.length
  const errors: string[] = []
  let thinkingBlocks = 0
  let text = ''
  let stamp: Turn['stamp']
  try {
    const stream = routedCallModel({
      messages: [createUserMessage({ content: 'Reply with the single word pong.' }) as Message],
      systemPrompt: ['You are a fixture assistant.'] as never,
      thinkingConfig: (thinking ? { type: 'enabled', budgetTokens: 8192 } : { type: 'disabled' }) as never,
      tools: [],
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => permissionContext,
        model,
        ...(effortValue !== undefined ? { effortValue } : {}),
        isNonInteractiveSession: true,
        querySource: 'main_thread' as never,
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        hasPendingMcpServers: false,
      } as never,
    })
    for await (const message of stream) {
      const m = message as { type?: string; isApiErrorMessage?: boolean; effort?: Turn['stamp']; message?: { content?: Array<{ type?: string; text?: string }> } }
      if (m.type !== 'assistant') continue
      if (m.isApiErrorMessage) errors.push(JSON.stringify(m.message?.content).slice(0, 300))
      else {
        for (const block of m.message?.content ?? []) {
          if (block.type === 'thinking') thinkingBlocks++
          if (block.type === 'text') text += block.text ?? ''
        }
        if (m.effort !== undefined) stamp = m.effort
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const sent = chats.slice(before)
  return { body: sent[sent.length - 1], sent: sent.length, error: errors.length > 0 ? errors.join(' | ') : undefined, thinking: thinkingBlocks, text, stamp }
}
const kwargsOf = (body: Wire | undefined): Record<string, unknown> | undefined => body?.chat_template_kwargs as Record<string, unknown> | undefined
const LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

section('§0 the fixture holds what llama-server does with the field: it reasons unless the request says reasoning_effort none')
{
  const post = async (extra: Record<string, unknown>): Promise<string> => (await fetch(`${llama.root}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'u' }], ...extra }) })).text()
  check('no field: the answer carries reasoning', (await post({})).includes('reasoning_content'))
  check('a level: the answer carries reasoning', (await post({ reasoning_effort: 'low' })).includes('reasoning_content'))
  check('reasoning_effort none: no reasoning, the answer alone', !(await post({ reasoning_effort: 'none' })).includes('reasoning_content'))
  chats.length = 0
}

section('§1 the builders — thinking off is the word none on both roads, above any level; the ladder a person picks from is unmoved')
{
  const local = (thinkingEnabled: boolean, effortValue?: string): Record<string, unknown> => wire.buildLocalExtras({ wireModel: MODEL, effortValue, thinkingEnabled, maxOutputTokensOverride: undefined, server: 'llamacpp', acceptsEffort: true, idSlot: 1 })
  const hosted = (thinkingEnabled: boolean, effortValue?: string): Record<string, unknown> => wire.buildHostedExtras({ wireModel: MODEL, effortValue, thinkingEnabled, maxOutputTokensOverride: undefined, dialect: 'llamacpp', vocabulary: wire.LOCAL_SERVER_EFFORTS.llamacpp, idSlot: 1 })
  check('the local road, thinking off: reasoning_effort none, with no level and with any level', [undefined, 'low', 'high', 'max'].every(level => local(false, level).reasoning_effort === 'none'), JSON.stringify([undefined, 'low', 'high', 'max'].map(level => local(false, level).reasoning_effort)))
  check('the local road, thinking on: the level as it was, and no field without one', local(true, 'high').reasoning_effort === 'high' && !('reasoning_effort' in local(true)), JSON.stringify([local(true, 'high'), local(true)]))
  check('the local road keeps its slot and prompt cache beside the word', local(false).id_slot === 1 && local(false).cache_prompt === true, JSON.stringify(local(false)))
  check('the compat road, thinking off: reasoning_effort none at the top, and no level in the template arguments', [undefined, 'low', 'high', 'max'].every(level => hosted(false, level).reasoning_effort === 'none' && hosted(false, level).chat_template_kwargs === undefined), JSON.stringify(hosted(false, 'high')))
  check('the compat road, thinking on: the level in the template arguments as it was, nothing at the top', JSON.stringify(hosted(true, 'high').chat_template_kwargs) === '{"reasoning_effort":"high"}' && !('reasoning_effort' in hosted(true, 'high')) && !('reasoning_effort' in hosted(true)) && hosted(true).chat_template_kwargs === undefined, JSON.stringify([hosted(true, 'high'), hosted(true)]))
  check('the word is stated on its own: the levels a person picks from do not gain none', JSON.stringify(wire.LOCAL_SERVER_EFFORTS.llamacpp) === JSON.stringify(LADDER), JSON.stringify(wire.LOCAL_SERVER_EFFORTS.llamacpp))
  const word = wire.localThinkingOffWireEffort
  check('the off word of every other server kind stands: none on Ollama and TensorFold, no word on LM Studio, vLLM and SGLang', word('ollama') === 'none' && word('tensorfold') === 'none' && word('lmstudio') === undefined && word('vllm') === undefined && word('sglang') === undefined, JSON.stringify(['ollama', 'tensorfold', 'lmstudio', 'vllm', 'sglang'].map(kind => word(kind as never))))
  const rack = wire.buildHostedExtras({ wireModel: MODEL, effortValue: 'high', thinkingEnabled: false, maxOutputTokensOverride: undefined, dialect: 'vllm', vocabulary: wire.LOCAL_SERVER_EFFORTS.vllm })
  check('a vLLM endpoint with thinking off sends what it sent: the level, no off word', rack.reasoning_effort === 'high' && rack.chat_template_kwargs === undefined, JSON.stringify(rack))
}

section('§2 the local road — a turn with reasoning off carries the word, and the server answers without reasoning')
{
  const off = await turn(LOCAL, false)
  check('one request, answered', off.sent === 1 && off.error === undefined && off.text === 'pong', off.error ?? `${off.sent} ${off.text}`)
  check('the request carries reasoning_effort none and no template argument', off.body?.reasoning_effort === 'none' && kwargsOf(off.body) === undefined, JSON.stringify({ reasoning_effort: off.body?.reasoning_effort, chat_template_kwargs: off.body?.chat_template_kwargs }))
  check('the answer has no thinking', off.thinking === 0, String(off.thinking))
  check('the turn is stamped thinking off, with the wire it rode', off.stamp?.applied === 'thinking off' && off.stamp.wire === 'reasoning_effort=none', JSON.stringify(off.stamp))
  const offLow = await turn(LOCAL, false, 'low')
  check('a chosen level does not ride while reasoning is off', offLow.body?.reasoning_effort === 'none' && offLow.thinking === 0 && offLow.stamp?.asked === 'low' && offLow.stamp.applied === 'thinking off', JSON.stringify({ wire: offLow.body?.reasoning_effort, stamp: offLow.stamp }))
  const on = await turn(LOCAL, true)
  check('reasoning on, no level: no field at all, as before, and the server reasons', on.error === undefined && on.body !== undefined && !('reasoning_effort' in on.body) && kwargsOf(on.body) === undefined && on.thinking === 1, JSON.stringify({ keys: Object.keys(on.body ?? {}), thinking: on.thinking }))
  const onLow = await turn(LOCAL, true, 'low')
  check('reasoning on with a level: the level, as before', onLow.body?.reasoning_effort === 'low' && onLow.thinking === 1, JSON.stringify(onLow.body?.reasoning_effort))
}

section('§3 the compat road — the same word at the top of the request')
{
  const off = await turn(COMPAT, false)
  check('one request, answered', off.sent === 1 && off.error === undefined && off.text === 'pong', off.error ?? `${off.sent} ${off.text}`)
  check('the request carries reasoning_effort none, no level in the template arguments, and its prompt cache', off.body?.reasoning_effort === 'none' && kwargsOf(off.body) === undefined && off.body.cache_prompt === true, JSON.stringify({ reasoning_effort: off.body?.reasoning_effort, chat_template_kwargs: off.body?.chat_template_kwargs, cache_prompt: off.body?.cache_prompt }))
  check('the answer has no thinking', off.thinking === 0, String(off.thinking))
  check('the turn is stamped thinking off, with the wire it rode', off.stamp?.applied === 'thinking off' && off.stamp.wire === 'reasoning_effort=none', JSON.stringify(off.stamp))
  const offHigh = await turn(COMPAT, false, 'high')
  check('a chosen level does not ride while reasoning is off', offHigh.body?.reasoning_effort === 'none' && kwargsOf(offHigh.body) === undefined && offHigh.stamp?.asked === 'high' && offHigh.stamp.applied === 'thinking off', JSON.stringify({ wire: offHigh.body?.reasoning_effort, kwargs: offHigh.body?.chat_template_kwargs, stamp: offHigh.stamp }))
  const on = await turn(COMPAT, true)
  check('reasoning on, no level: no field at all, as before', on.error === undefined && on.body !== undefined && !('reasoning_effort' in on.body) && kwargsOf(on.body) === undefined && on.thinking === 1, JSON.stringify({ keys: Object.keys(on.body ?? {}), thinking: on.thinking }))
  const onHigh = await turn(COMPAT, true, 'high')
  check('reasoning on with a level: the level in the template arguments, as before', onHigh.body !== undefined && !('reasoning_effort' in onHigh.body) && kwargsOf(onHigh.body)?.reasoning_effort === 'high', JSON.stringify(onHigh.body?.chat_template_kwargs))
  const rack = await turn(RACK, false, 'high')
  check('a vLLM endpoint with reasoning off sends what it sent', rack.error === undefined && rack.body?.reasoning_effort === 'high' && rack.stamp?.applied !== 'thinking off', JSON.stringify({ wire: rack.body?.reasoning_effort, stamp: rack.stamp }))
}

section('§4 what a person reads — the effort view of a llama.cpp model says the word the wire carries')
for (const model of [LOCAL, COMPAT]) {
  const view = effortVocabularyFor(model) as { kind: string; thinkingGated?: boolean; thinkingOffWire?: string; vocabulary?: readonly string[] }
  check(`${model}: the view is gated by thinking, with none as its off word`, view.kind === 'provider' && view.thinkingGated === true && view.thinkingOffWire === 'none', JSON.stringify({ kind: view.kind, thinkingGated: view.thinkingGated, thinkingOffWire: view.thinkingOffWire }))
  check(`${model}: its levels do not gain none`, view.vocabulary !== undefined && !view.vocabulary.includes('none') && view.vocabulary.length > 0, JSON.stringify(view.vocabulary))
  const off = resolveEffortTruth(model, 'low', { thinkingEnabled: false })
  check(`${model}: with reasoning off the effort reads none, floored by thinking off, the chosen level kept as asked`, off.flooredBy === 'thinking-off' && off.wire === 'none' && off.label === 'none' && off.requested === 'low' && off.suppressedBy === undefined, JSON.stringify({ flooredBy: off.flooredBy, wire: off.wire, label: off.label, requested: off.requested }))
  const on = resolveEffortTruth(model, 'low', { thinkingEnabled: true })
  check(`${model}: with reasoning on the level reads as it did`, on.flooredBy === undefined && on.wire === 'low' && JSON.stringify(on.selectable) === JSON.stringify(off.selectable), JSON.stringify({ flooredBy: on.flooredBy, wire: on.wire, selectable: on.selectable }))
}
{
  const view = effortVocabularyFor(RACK) as { kind: string; thinkingGated?: boolean; thinkingOffWire?: string }
  check('a vLLM endpoint\'s view stands: not gated, no off word', view.kind === 'provider' && view.thinkingGated === false && !('thinkingOffWire' in view), JSON.stringify(view))
}

llama.server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} LLAMA.CPP THINKING-OFF PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL LLAMA.CPP THINKING-OFF PROOFS PASS')
process.exit(0)
