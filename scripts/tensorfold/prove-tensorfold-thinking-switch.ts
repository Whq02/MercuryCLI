#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

const REFUSAL = 'thinking off is not supported by this chat template: it has no thinking switch or closable generation prefix'
const CAPABILITY_NAMES = ['text_generation', 'context_fitted', 'call_gates', 'loop_guard', 'thinking_budget', 'reasoning', 'answer_limit', 'structures', 'logprobs', 'penalties', 'prompt_logprobs', 'prompt_cache', 'warm_turns', 'plain_only', 'decides', 'pictures', 'greedy_only', 'slide_conversations', 'vision', 'speech', 'embeddings', 'readouts', 'rerank', 'thinking_switch', 'thinking_applicable']
const LOADED = ['text_generation', 'thinking_budget', 'reasoning', 'prompt_cache', 'thinking_applicable']
type Stated = boolean | 'unstated'
const capabilitiesOf = (thinkingSwitch: boolean): Record<string, boolean> => Object.fromEntries(CAPABILITY_NAMES.map(name => [name, name === 'thinking_switch' ? thinkingSwitch : LOADED.includes(name)]))

function switchOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  const type = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined
  return type === 'enabled' ? true : type === 'disabled' ? false : undefined
}

function explicitOff(body: Record<string, unknown>): boolean {
  const kwargs = typeof body.chat_template_kwargs === 'object' && body.chat_template_kwargs !== null ? (body.chat_template_kwargs as Record<string, unknown>) : undefined
  let enable: boolean | undefined
  if (typeof body.reasoning_effort === 'string') enable = body.reasoning_effort !== 'none'
  else if (typeof kwargs?.reasoning_effort === 'string') enable = kwargs.reasoning_effort !== 'none'
  if (kwargs !== undefined && 'enable_thinking' in kwargs) enable = Boolean(kwargs.enable_thinking)
  else if (kwargs !== undefined && switchOf(kwargs.thinking) !== undefined) enable = switchOf(kwargs.thinking)
  else if (switchOf(body.thinking) !== undefined) enable = switchOf(body.thinking)
  return enable === false
}

type Engine = { name: string; root: string; bodies: Record<string, unknown>[]; close: () => void }
function engine(name: string, stated: Stated): Promise<Engine> {
  const bodies: Record<string, unknown>[] = []
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let text = ''
      req.on('data', chunk => {
        text += String(chunk)
      })
      req.on('end', () => {
        const send = (status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json', server: 'TensorFold' })
          res.end(JSON.stringify(body))
        }
        const url = req.url ?? ''
        if (req.method === 'GET' && url === '/health') return send(200, { status: 'ok', model: name, model_ids: [name], max_batch_size: 8, warming: false, memory: { active: 3_015_330_576, cache: 0, peak: 3_015_330_576 }, live: { connections: 0, waiting: 0, decode_tokens_per_second: 0, prefill_tokens_per_second: 0 }, version: stated === 'unstated' ? '1.2.2' : '1.2.5', backend: 'metal', device: 'Apple M5 Pro' })
        if (req.method === 'GET' && /\/models$/.test(url)) return send(200, { object: 'list', data: [{ id: name, object: 'model', created: 1_794_000_000, owned_by: 'tensorfold', ...(stated === 'unstated' ? {} : { capabilities: capabilitiesOf(stated) }), context_length: 32768, max_model_len: 32768, reasoning: { default_enabled: true } }] })
        if (req.method === 'POST' && url === '/v1/chat/completions') {
          const body = JSON.parse(text || '{}') as Record<string, unknown>
          bodies.push(body)
          if (stated === false && explicitOff(body)) return send(400, { error: { message: REFUSAL, type: 'invalid_request_error' } })
          res.writeHead(200, { 'content-type': 'text/event-stream', server: 'TensorFold' })
          const chunk = (delta: Record<string, unknown>, finish: string | null): string => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: name, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
          res.write(chunk({ role: 'assistant' }, null))
          res.write(chunk({ content: 'ready' }, null))
          res.write(chunk({}, 'stop'))
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: name, choices: [], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\n`)
          res.write('data: [DONE]\n\n')
          return res.end()
        }
        send(404, { error: { message: 'not found' } })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ name, root: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`, bodies, close: () => server.close() })
    })
  })
}

const refuses = await engine('no-switch', false)
const honours = await engine('with-switch', true)
const unstated = await engine('unstated', 'unstated')
const engines = [refuses, honours, unstated]
process.env.MERCURY_LOCAL_PROBE_TARGETS = engines.map(one => `tensorfold=${one.root}`).join(',')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { pickAndProve } = await import('../../src/services/localSetup/setupProve.ts')
const { effortStampLine } = await import('../../src/utils/effortStamp.ts')
type Record_ = NonNullable<ReturnType<typeof localRecordFor>>

await refreshLocalDiscovery({ force: true })
const recordOf = (one: Engine): Record_ | undefined => localRecordFor(`local/${one.name}`)

type Turn = { body: Record<string, unknown> | undefined; said: string; error: string; stamp: string }
async function turn(one: Engine, thinking: boolean, effortValue: string): Promise<Turn> {
  const record = recordOf(one)
  if (record === undefined) return { body: undefined, said: '', error: 'not discovered', stamp: '' }
  const before = one.bodies.length
  let said = ''
  let error = ''
  let stamp = ''
  for await (const item of compatChatCallModel(localLaneProfileFor(record), {
    messages: [{ type: 'user', message: { role: 'user', content: 'hi' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
    systemPrompt: ['sys'] as never,
    thinkingConfig: (thinking ? { type: 'enabled', budget_tokens: 1024 } : { type: 'disabled' }) as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model: `local/${one.name}`, querySource: 'user', effortValue, getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
  })) {
    const row = item as { type?: string; isApiErrorMessage?: boolean; effort?: Parameters<typeof effortStampLine>[0]; message?: { content?: Array<{ type: string; text?: string }> } }
    if (row.type !== 'assistant') continue
    const text = (row.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    if (row.isApiErrorMessage) error = text
    else said += text
    if (row.effort !== undefined) stamp = effortStampLine(row.effort)
  }
  return { body: one.bodies.length > before ? one.bodies.at(-1) : undefined, said, error, stamp }
}

async function verify(one: Engine): Promise<{ ok: boolean; words: string; body: Record<string, unknown> | undefined }> {
  const before = one.bodies.length
  const proved = await pickAndProve(one.name, { root: one.root, thinkingOff: true, pickAfterReply: true, focusedConnector: () => { throw new Error('no session in this proof') }, persist: () => ({ sentence: '' }) } as never)
  return { ok: proved.ok, words: proved.words, body: one.bodies.length > before ? one.bodies.at(-1) : undefined }
}

const withoutModel = (body: Record<string, unknown> | undefined): string => JSON.stringify({ ...body, model: 'm' })

section("§1 /v1/models as 1.2.5 writes it: the engine's own statement of its thinking switch rides the record; 1.2.2 states none")
{
  check('a model whose template cannot honour thinking off (capabilities.thinking_switch false, thinking_applicable true) is read as such', recordOf(refuses)?.server === 'tensorfold' && recordOf(refuses)?.thinkingDeclared === true && recordOf(refuses)?.thinkingSwitch === false, JSON.stringify(recordOf(refuses)))
  check('a model whose template has the switch is read as such', recordOf(honours)?.thinkingDeclared === true && recordOf(honours)?.thinkingSwitch === true, JSON.stringify(recordOf(honours)))
  check('an engine that states no capabilities (1.2.2) leaves the field absent', recordOf(unstated)?.thinkingDeclared === true && recordOf(unstated) !== undefined && !('thinkingSwitch' in recordOf(unstated)!), JSON.stringify(recordOf(unstated)))
}

section('§2 a turn with thinking off: the off word rides only where the engine has not ruled it out')
{
  const refused = await turn(refuses, false, 'high')
  check('no switch: the body carries no reasoning_effort and no thinking budget, and the reply arrives (1.2.5 answers the off word with HTTP 400)', refused.body !== undefined && !('reasoning_effort' in refused.body) && !('thinking_budget' in refused.body) && !('chat_template_kwargs' in refused.body) && refused.said === 'ready' && refused.error === '', JSON.stringify({ body: refused.body, said: refused.said, error: refused.error }))
  check('no switch: the stamp is the one an omitted effort already gets', refused.stamp === 'effort asked high · applied none · wire none', refused.stamp)
  const low = await turn(refuses, true, 'low')
  check('no switch: the dial at low (an off level on TensorFold) sends no off word either', low.body !== undefined && !('reasoning_effort' in low.body) && low.said === 'ready' && low.error === '', JSON.stringify({ body: low.body, error: low.error }))
  const high = await turn(refuses, true, 'high')
  check('no switch: thinking on at high still sends high with its budget', high.body?.reasoning_effort === 'high' && typeof high.body.thinking_budget === 'number' && high.said === 'ready', JSON.stringify(high.body))
  const honoured = await turn(honours, false, 'high')
  check('with the switch: thinking off sends reasoning_effort none, as before', honoured.body?.reasoning_effort === 'none' && !('thinking_budget' in honoured.body) && honoured.said === 'ready' && honoured.stamp === 'effort asked high · applied thinking off · wire reasoning_effort=none', JSON.stringify({ body: honoured.body, stamp: honoured.stamp }))
  const legacy = await turn(unstated, false, 'high')
  check('an engine that states nothing: the same body as with the switch, key for key', legacy.body?.reasoning_effort === 'none' && withoutModel(legacy.body) === withoutModel(honoured.body) && legacy.stamp === honoured.stamp, JSON.stringify({ legacy: legacy.body, honoured: honoured.body }))
  const legacyLow = await turn(unstated, true, 'low')
  const honouredLow = await turn(honours, true, 'low')
  check('an engine that states nothing: the dial at low sends none, as with the switch', legacyLow.body?.reasoning_effort === 'none' && withoutModel(legacyLow.body) === withoutModel(honouredLow.body), JSON.stringify(legacyLow.body))
}

section("§3 the serve road's verify step (a short reply with thinking off) passes on all three")
{
  const refused = await verify(refuses)
  check('no switch: the verify request carries neither off field and the reply proves the server', refused.ok && refused.words.startsWith('ready · local/no-switch · 32k window (served) · reply in ') && refused.body !== undefined && !('reasoning_effort' in refused.body) && !('chat_template_kwargs' in refused.body), JSON.stringify(refused))
  const honoured = await verify(honours)
  check('with the switch: both off fields ride, as before', honoured.ok && honoured.body?.reasoning_effort === 'none' && JSON.stringify(honoured.body?.chat_template_kwargs) === '{"enable_thinking":false}', JSON.stringify(honoured))
  const legacy = await verify(unstated)
  check('an engine that states nothing: the same verify body as with the switch, key for key', legacy.ok && legacy.body?.reasoning_effort === 'none' && withoutModel(legacy.body) === withoutModel(honoured.body), JSON.stringify({ legacy: legacy.body, honoured: honoured.body }))
}

for (const one of engines) one.close()
console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: TensorFold's thinking switch as the engine states it`)
process.exit(failures === 0 ? 0 : 1)
