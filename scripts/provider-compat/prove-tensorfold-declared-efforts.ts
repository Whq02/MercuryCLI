#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

const REFUSAL = 'thinking off is not supported by this chat template: it has no thinking switch or closable generation prefix'
const CAPABILITY_NAMES = ['text_generation', 'thinking_budget', 'reasoning', 'prompt_cache', 'thinking_switch', 'thinking_applicable']
type Stated = boolean | 'unstated'
const capabilitiesOf = (thinkingSwitch: boolean): Record<string, boolean> => Object.fromEntries(CAPABILITY_NAMES.map(name => [name, name === 'thinking_switch' ? thinkingSwitch : true]))

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
          if (stated === false && body.reasoning_effort === 'none') return send(400, { error: { message: REFUSAL, type: 'invalid_request_error' } })
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
const plain = await engine('undeclared', false)
const lacksLow = await engine('no-low', true)
const engines = [refuses, honours, unstated, plain, lacksLow]
process.env.MERCURY_LOCAL_PROBE_TARGETS = engines.map(one => `tensorfold=${one.root}`).join(',')

const DECLARED = ['none', 'low', 'high']
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
const declared = updateSettingsForSource('userSettings', { models: { ...Object.fromEntries([refuses, honours, unstated].map(one => [`local/${one.name}`, { efforts: DECLARED, reasoning: true }])), [`local/${lacksLow.name}`]: { efforts: ['none', 'high'], reasoning: true } } } as never)
if (declared.error) throw new Error(String(declared.error))
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const { effortStampLine } = await import('../../src/utils/effortStamp.ts')

await refreshLocalDiscovery({ force: true })

type Turn = { body: Record<string, unknown> | undefined; said: string; error: string; stamp: string }
async function turn(one: Engine, thinking: boolean, effortValue: string): Promise<Turn> {
  const record = localRecordFor(`local/${one.name}`)
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
const show = (t: Turn): string => JSON.stringify({ effort: t.body?.reasoning_effort ?? null, budget: t.body?.thinking_budget ?? null, said: t.said, error: t.error.slice(0, 160), stamp: t.stamp })

section("§1 the operator declares none, low and high for three TensorFold models; the engines state their own thinking switch")
{
  const read = (one: Engine): { server?: string; thinkingSwitch?: boolean } | undefined => localRecordFor(`local/${one.name}`)
  check('the engines are read as they state themselves: no switch, with the switch, nothing stated', read(refuses)?.thinkingSwitch === false && read(honours)?.thinkingSwitch === true && read(unstated) !== undefined && !('thinkingSwitch' in read(unstated)!), JSON.stringify([read(refuses), read(honours), read(unstated)].map(r => r?.thinkingSwitch)))
  const views = [refuses, honours, unstated].map(one => effortVocabularyFor(`local/${one.name}`))
  check("each model's effort vocabulary is the operator's, the declared words among it", views.every(view => view.kind === 'provider' && view.source === 'operator' && DECLARED.every(word => view.vocabulary.includes(word))), JSON.stringify(views))
  const undeclared = effortVocabularyFor(`local/${plain.name}`)
  check('a model the operator declared nothing for keeps the lane\'s own vocabulary', undeclared.kind === 'provider' && undeclared.source === 'local', JSON.stringify(undeclared))
}

section("§2 the engine that cannot switch thinking off: the operator's declaration never puts the off word on its request")
{
  const off = await turn(refuses, false, 'high')
  console.log(`  [record] thinking off, asked high: ${show(off)}`)
  check('thinking off: the request carries no effort word and the reply arrives (the engine answers the off word with HTTP 400)', off.body !== undefined && !('reasoning_effort' in off.body) && !('thinking_budget' in off.body) && off.said === 'ready' && off.error === '', show(off))
  check('thinking off: the stamp is the one an omitted effort gets', off.stamp === 'effort asked high · applied none · wire none', off.stamp)
  const base = await turn(plain, false, 'high')
  check('…the same request, key for key, as the same engine gets with nothing declared', base.body !== undefined && off.body !== undefined && JSON.stringify({ ...off.body, model: '' }) === JSON.stringify({ ...base.body, model: '' }) && base.said === 'ready', JSON.stringify({ declared: off.body, undeclared: base.body }))
  const none = await turn(refuses, true, 'none')
  console.log(`  [record] thinking on, the operator's own none asked: ${show(none)}`)
  check("the operator's own none asked with thinking on: no effort word either, and the reply arrives", none.body !== undefined && !('reasoning_effort' in none.body) && none.said === 'ready' && none.error === '', show(none))
}

section("§3 what the declaration still does there, and everywhere the engine has not ruled the word out")
{
  const low = await turn(refuses, true, 'low')
  check("no switch: the operator's low rides as declared, a word the engine takes", low.body?.reasoning_effort === 'low' && low.said === 'ready' && low.error === '', show(low))
  const high = await turn(refuses, true, 'high')
  check('no switch: high rides with its thinking budget, the lane\'s own word', high.body?.reasoning_effort === 'high' && typeof high.body.thinking_budget === 'number' && high.said === 'ready', show(high))
  for (const one of [honours, unstated]) {
    const off = await turn(one, false, 'high')
    check(`${one.name}: thinking off sends none, as the operator declared and the engine allows`, off.body?.reasoning_effort === 'none' && off.said === 'ready' && off.error === '' && off.stamp === 'effort asked high · applied thinking off · wire reasoning_effort=none', show(off))
    const none = await turn(one, true, 'none')
    check(`${one.name}: the operator's none asked with thinking on sends none`, none.body?.reasoning_effort === 'none' && none.said === 'ready' && none.error === '', show(none))
  }
}

section('§4 the rule is the engine\'s statement and one word')
{
  const profileOf = (one: Engine): { refusesEffort?: (word: string) => boolean } => localLaneProfileFor(localRecordFor(`local/${one.name}`)!) as { refusesEffort?: (word: string) => boolean }
  const table = [refuses, honours, unstated].map(one => [one.name, ...['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(word => profileOf(one).refusesEffort?.(word) === true)])
  check('only the engine that states no switch refuses a word, and the word is none', JSON.stringify(table) === JSON.stringify([['no-switch', 'none'], ['with-switch'], ['unstated']]), JSON.stringify(table))
}

section('§5 /effort says what the next request carries: where the dial sends none for low, the receipt says so in the words of the reply\'s own stamp')
{
  const { executeEffort } = await import('../../src/commands/effort/effort.tsx')
  type Row = { said: string; sent: unknown; stamp: string }
  const rows = new Map<string, Row>()
  for (const one of [plain, refuses, honours, unstated, lacksLow]) {
    for (const level of ['low', 'medium', 'high']) {
      const said = executeEffort(level, `local/${one.name}`).message
      const t = await turn(one, true, level)
      rows.set(`${one.name} ${level}`, { said, sent: t.body?.reasoning_effort ?? null, stamp: t.stamp })
    }
  }
  const at = (name: string, level: string): Row => rows.get(`${name} ${level}`)!
  const saved = (level: string): string => `Effort set to ${level} — saved as your default for future sessions.`
  const showRow = (name: string, level: string): string => JSON.stringify(at(name, level))
  check('no declaration, an engine with no thinking switch: low rides as no word at all, and the receipt says applied none', at('undeclared', 'low').said === `${saved('low')} (local/undeclared: asked low · applied none)` && at('undeclared', 'low').sent === null && at('undeclared', 'low').stamp === 'effort asked low · applied none · wire none', showRow('undeclared', 'low'))
  for (const name of ['with-switch', 'unstated']) {
    check(`${name}, low declared: low rides as none, and the receipt says applied none`, at(name, 'low').said === `${saved('low')} (local/${name}: asked low · applied none)` && at(name, 'low').sent === 'none' && at(name, 'low').stamp === 'effort asked low · applied none · wire reasoning_effort=none', showRow(name, 'low'))
  }
  check('no-switch, low declared: the engine cannot switch thinking off, low rides as low, and the receipt is plain', at('no-switch', 'low').said === saved('low') && at('no-switch', 'low').sent === 'low' && at('no-switch', 'low').stamp === 'effort asked low · applied low · wire reasoning_effort=low', showRow('no-switch', 'low'))
  check('a declaration with no low: the receipt names the nearest tier of that vocabulary, as before, and the request carries it', at('no-low', 'low').said === `${saved('low')} (local/no-low runs none, the nearest tier in its effort vocabulary)` && at('no-low', 'low').sent === 'none', showRow('no-low', 'low'))
  const upper = [...rows.entries()].filter(([key]) => !key.endsWith(' low'))
  const expected = (key: string): string => {
    const [name, level] = key.split(' ') as [string, string]
    return level === 'medium' && name !== 'undeclared' ? `${saved('medium')} (local/${name} runs ${name === 'no-low' ? 'none' : 'low'}, the nearest tier in its effort vocabulary)` : saved(level)
  }
  check('medium and high read as they did on every engine, and their requests carry the word asked', upper.every(([key, row]) => row.said === expected(key) && row.sent === key.split(' ')[1]), JSON.stringify(upper.filter(([key, row]) => row.said !== expected(key) || row.sent !== key.split(' ')[1])))
  const named = [...rows.values()].filter(row => / · applied (\S+)\)$/.test(row.said))
  check('wherever the receipt names an applied word, the reply\'s stamp names the same one', named.length === 3 && named.every(row => row.stamp.includes(` · applied ${/ · applied (\S+)\)$/.exec(row.said)![1]} · `)), JSON.stringify(named))
}

for (const one of engines) one.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
