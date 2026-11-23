#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-thinking-wires-agree-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

let failures = 0
const thinkingWireFixHint = 'make /v1 and /api/chat agree: compare localThinkingOff and buildLocalExtras in src/models/roads/openaicompat/compatWire.ts with ollamaThinkingValue and localModelAcceptsEffort in src/models/roads/local/localCallModel.ts, and the stamp in src/models/roads/openaicompat/chat-call-model/attempt.ts and src/models/effort/effortStamp.ts'
const sectionFixHints: Record<string, string> = {
  '1': 'the record shape or road is wrong: check localModelAcceptsEffort in src/models/roads/local/localCallModel.ts and ollamaChatUrl in src/models/roads/local/ollamaChatTransport.ts',
  '2': thinkingWireFixHint,
  '3': thinkingWireFixHint,
  '4': thinkingWireFixHint,
  '5': thinkingWireFixHint,
  '6': thinkingWireFixHint,
  '7': 'a wire leaked the other spelling or a request bypassed /api/chat: check buildLocalExtras in src/models/roads/openaicompat/compatWire.ts and the Ollama dispatch in src/models/roads/openaicompat/chat-call-model',
}
let sectionFixHint = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = !cond && sectionFixHint ? ` — ${sectionFixHint}` : ''
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${hint}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  sectionFixHint = sectionFixHints[t.split(' ')[0] ?? ''] ?? ''
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const requests: string[] = []
const chatBodies: Record<string, unknown>[] = []
const ndjson = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const fixture = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    if (request.method === 'POST' && path === '/api/chat') {
      const body = (await request.json()) as Record<string, unknown>
      chatBodies.push(body)
      return new Response(
        ndjson([
          { model: body.model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'ok' }, done: false },
          { model: body.model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 9, eval_count: 1 },
        ]),
        { headers: { 'content-type': 'application/x-ndjson' } },
      )
    }
    return new Response(JSON.stringify({ error: `the fixture answers only POST /api/chat, not ${request.method} ${path}` }), { status: 404, headers: { 'content-type': 'application/json' } })
  },
})
const root = `http://127.0.0.1:${fixture.port}`

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { localLaneProfileFor, localModelAcceptsEffort, ollamaThinkingValue } = await import('../../src/models/roads/local/localCallModel.ts')
const { buildLocalExtras, localThinkingOff } = await import('../../src/models/roads/openaicompat/compatWire.ts')
const { ollamaChatUrl } = await import('../../src/models/roads/local/ollamaChatTransport.ts')
const { compatChatCallModel } = await import('../../src/models/roads/openaicompat/compatChatCallModel.ts')
const { EFFORT_STAMP_THINKING_OFF, EFFORT_STAMP_THINKING_ON, EFFORT_STAMP_UNSUPPORTED } = await import('../../src/models/effort/effortStamp.ts')
type LocalModelRecord = import('../../src/models/roads/local/localDiscovery.ts').LocalModelRecord
type EffortStamp = import('../../src/models/effort/effortStamp.ts').EffortStampV1

const base = { server: 'ollama', baseUrl: `${root}/v1`, toolsDeclared: true, family: 'qwen3', parameterSize: '27B' } as const
const legacy: LocalModelRecord = { ...base, id: 'legacy:27b', thinkingDeclared: true }
const plain: LocalModelRecord = { ...base, id: 'plain:8b', thinkingDeclared: false }
const toggle: LocalModelRecord = { ...base, id: 'toggle:27b', thinking: { values: [false, true], default: true }, thinkingDeclared: true }
const named: LocalModelRecord = { ...base, id: 'named:27b', thinking: { values: ['low', 'high', 'max'], default: 'high' }, thinkingDeclared: true }
const offOnly: LocalModelRecord = { ...base, id: 'off-only:8b', thinking: { values: [false], default: false }, thinkingDeclared: false }

const v1BodyFor = (record: LocalModelRecord, thinkingEnabled: boolean, effortValue: string | undefined): { reasoning_effort?: string; think?: unknown } =>
  buildLocalExtras({ wireModel: record.id, effortValue, thinkingEnabled, maxOutputTokensOverride: undefined, server: record.server, acceptsEffort: localModelAcceptsEffort(record) })
let dispatches = 0
const nativeFor = async (record: LocalModelRecord, thinkingEnabled: boolean, effortValue: string | undefined): Promise<{ body: Record<string, unknown> | undefined; stamp: EffortStamp | undefined }> => {
  const before = chatBodies.length
  dispatches++
  let stamp: EffortStamp | undefined
  for await (const item of compatChatCallModel(localLaneProfileFor(record), {
    messages: [{ type: 'user', message: { role: 'user', content: 'hi' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
    systemPrompt: ['sys'] as never,
    thinkingConfig: (thinkingEnabled ? { type: 'enabled', budget_tokens: 1024 } : { type: 'disabled' }) as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model: `local/${record.id}`, querySource: 'user', effortValue, getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
  })) {
    const row = item as { type?: string; effort?: EffortStamp }
    if (row.type === 'assistant' && row.effort !== undefined) stamp = row.effort
  }
  return { body: chatBodies.length > before ? chatBodies.at(-1) : undefined, stamp }
}
const predicateFor = (record: LocalModelRecord, thinkingEnabled: boolean): boolean =>
  localThinkingOff({ server: record.server, acceptsEffort: localModelAcceptsEffort(record), thinkingEnabled })
const decisionFor = (record: LocalModelRecord, thinkingEnabled: boolean, effortValue: string | undefined): boolean | string | undefined =>
  ollamaThinkingValue(record, effortValue, thinkingEnabled)
const show = (value: unknown): string => JSON.stringify(value) ?? 'undefined'

section('1 · the fixture records and the roads: Ollama records whose base points at the loopback fixture, one per think shape')
{
  check('the native road posts to the fixture /api/chat (ollamaChatUrl of the record base)', ollamaChatUrl(legacy.baseUrl) === `${root}/api/chat`, ollamaChatUrl(legacy.baseUrl))
  check('legacy: thinking declared, no /api/show metadata (the effort dial applies, the predicate owns the boolean)', legacy.thinking === undefined && legacy.thinkingDeclared === true && localModelAcceptsEffort(legacy) === true)
  check('plain: no thinking (no dial on either wire)', plain.thinking === undefined && plain.thinkingDeclared === false && localModelAcceptsEffort(plain) === false)
  check('toggle and named: declared through metadata that holds a value other than false', [toggle, named].every(record => record.thinking!.values.some(value => value !== false) && record.thinkingDeclared === true && localModelAcceptsEffort(record) === true))
  check('off-only: metadata that holds only false declares no thinking', offOnly.thinking!.values.every(value => value === false) && offOnly.thinkingDeclared === false && localModelAcceptsEffort(offOnly) === false)
  check('every proof process runs with probing off (MERCURY_LOCAL_PROBE_TARGETS=none)', process.env.MERCURY_LOCAL_PROBE_TARGETS === 'none')
}

section('2 · legacy record, thinking OFF: reasoning_effort "none" on /v1, think false on /api/chat, the stamp says thinking off')
{
  const v1 = v1BodyFor(legacy, false, 'high')
  const { body, stamp } = await nativeFor(legacy, false, 'high')
  check('the thinking-off dispatch reached the fixture /api/chat', body !== undefined, requests.join(', '))
  check('/v1: reasoning_effort "none"', v1.reasoning_effort === 'none', `sent ${show(v1.reasoning_effort)}`)
  check('/api/chat: think false', body?.think === false, `sent ${show(body?.think)}`)
  check('the predicate says off, and both wires read as it says', predicateFor(legacy, false) === true && (v1.reasoning_effort === 'none') === predicateFor(legacy, false) && body?.think === !predicateFor(legacy, false))
  check('the native decision is the predicate\'s complement, nothing of its own', decisionFor(legacy, false, 'high') === !predicateFor(legacy, false) && body?.think === decisionFor(legacy, false, 'high'))
  check('the stamp reads the wire: applied "thinking off", wire think=false', stamp?.applied === EFFORT_STAMP_THINKING_OFF && stamp?.wire === 'think=false', show(stamp))
}

section('3 · legacy record, thinking ON: the effort word on /v1, think true on /api/chat, the stamp says thinking on')
{
  const v1 = v1BodyFor(legacy, true, 'high')
  const { body, stamp } = await nativeFor(legacy, true, 'high')
  check('the thinking-on dispatch reached the fixture /api/chat', body !== undefined, requests.join(', '))
  check('/v1: the effort word, never "none"', v1.reasoning_effort === 'high', `sent ${show(v1.reasoning_effort)}`)
  check('/api/chat: think true', body?.think === true, `sent ${show(body?.think)}`)
  check('the predicate says not off, and both wires read as it says', predicateFor(legacy, true) === false && (v1.reasoning_effort === 'none') === predicateFor(legacy, true) && body?.think === !predicateFor(legacy, true))
  check('the native decision is the predicate\'s complement, nothing of its own', decisionFor(legacy, true, 'high') === !predicateFor(legacy, true) && body?.think === decisionFor(legacy, true, 'high'))
  check('the stamp reads the wire: applied "thinking on", wire think=true', stamp?.applied === EFFORT_STAMP_THINKING_ON && stamp?.wire === 'think=true', show(stamp))
}

section('4 · boolean metadata (values [false, true]): the switch reaches both wires as the metadata spells it')
{
  const v1Off = v1BodyFor(toggle, false, 'high')
  const v1On = v1BodyFor(toggle, true, 'high')
  const off = await nativeFor(toggle, false, 'high')
  const on = await nativeFor(toggle, true, 'high')
  check('both dispatches reached the fixture /api/chat', off.body !== undefined && on.body !== undefined, requests.join(', '))
  check('off: /v1 "none", /api/chat think false', v1Off.reasoning_effort === 'none' && off.body?.think === false, `${show(v1Off.reasoning_effort)} ${show(off.body?.think)}`)
  check('on: /v1 the effort word, /api/chat think true', v1On.reasoning_effort === 'high' && on.body?.think === true, `${show(v1On.reasoning_effort)} ${show(on.body?.think)}`)
  check('the native decision and the predicate agree in both states', decisionFor(toggle, false, 'high') === !predicateFor(toggle, false) && decisionFor(toggle, true, 'high') === !predicateFor(toggle, true))
  check('the wire carries the decision, and the stamp reads the wire', off.body?.think === decisionFor(toggle, false, 'high') && on.body?.think === decisionFor(toggle, true, 'high') && off.stamp?.applied === EFFORT_STAMP_THINKING_OFF && on.stamp?.applied === EFFORT_STAMP_THINKING_ON && off.stamp?.wire === 'think=false' && on.stamp?.wire === 'think=true', `${show(off.stamp)} ${show(on.stamp)}`)
}

section('5 · string metadata (values low|high|max): the chosen level is one word on both wires, the model default when none is chosen')
{
  const high = await nativeFor(named, true, 'high')
  const max = await nativeFor(named, true, 'max')
  const unset = await nativeFor(named, true, undefined)
  check('every dispatch reached the fixture /api/chat', high.body !== undefined && max.body !== undefined && unset.body !== undefined, requests.join(', '))
  check('high: /v1 reasoning_effort "high", /api/chat think "high"', v1BodyFor(named, true, 'high').reasoning_effort === 'high' && high.body?.think === 'high', `${show(v1BodyFor(named, true, 'high').reasoning_effort)} ${show(high.body?.think)}`)
  check('max: /v1 reasoning_effort "max", /api/chat think "max"', v1BodyFor(named, true, 'max').reasoning_effort === 'max' && max.body?.think === 'max', `${show(v1BodyFor(named, true, 'max').reasoning_effort)} ${show(max.body?.think)}`)
  check('no level chosen: /api/chat carries the model default, /v1 names no level (the server\'s default is that same word)', unset.body?.think === named.thinking!.default && !('reasoning_effort' in v1BodyFor(named, true, undefined)), `${show(unset.body?.think)} ${show(v1BodyFor(named, true, undefined))}`)
  check('the wire carries the decision in every case', high.body?.think === decisionFor(named, true, 'high') && max.body?.think === decisionFor(named, true, 'max') && unset.body?.think === decisionFor(named, true, undefined))
  check('the stamp names the level: applied is the word, wire think=<word>', high.stamp?.applied === 'high' && high.stamp?.wire === 'think=high' && max.stamp?.applied === 'max' && max.stamp?.wire === 'think=max' && unset.stamp?.applied === 'high' && unset.stamp?.wire === 'think=high', `${show(high.stamp)} ${show(max.stamp)} ${show(unset.stamp)}`)
  check('a level the model never declared never rides the native wire (the asked word is kept to the declared values)', [high, max, unset].every(run => named.thinking!.values.includes(run.body?.think as string)))
}

section('6 · no thinking (plain) and off-only metadata: no dial on /v1; /api/chat carries nothing, or the one value the model declares')
{
  const v1Off = v1BodyFor(plain, false, 'high')
  const v1On = v1BodyFor(plain, true, 'high')
  const plainOff = await nativeFor(plain, false, 'high')
  const plainOn = await nativeFor(plain, true, 'high')
  const onlyOff = await nativeFor(offOnly, true, 'high')
  check('every dispatch reached the fixture /api/chat', plainOff.body !== undefined && plainOn.body !== undefined && onlyOff.body !== undefined, requests.join(', '))
  check('plain, /v1: no reasoning_effort, thinking on or off', !('reasoning_effort' in v1Off) && !('reasoning_effort' in v1On), `${show(v1Off)} ${show(v1On)}`)
  check('plain, /api/chat: no think key, thinking on or off', plainOff.body !== undefined && !('think' in plainOff.body) && plainOn.body !== undefined && !('think' in plainOn.body), `${show(plainOff.body?.think)} ${show(plainOn.body?.think)}`)
  check('plain: the decision is undefined on both sides (the predicate says not off for a model with nothing to switch)', decisionFor(plain, false, 'high') === undefined && decisionFor(plain, true, 'high') === undefined && predicateFor(plain, false) === false && predicateFor(plain, true) === false)
  check('plain: the stamp says the model has no effort control', plainOff.stamp?.applied === EFFORT_STAMP_UNSUPPORTED && plainOn.stamp?.applied === EFFORT_STAMP_UNSUPPORTED, `${show(plainOff.stamp)} ${show(plainOn.stamp)}`)
  check('off-only, thinking asked on: /api/chat think false (the one declared value), /v1 no dial', onlyOff.body?.think === false && decisionFor(offOnly, true, 'high') === false && !('reasoning_effort' in v1BodyFor(offOnly, true, 'high')), `${show(onlyOff.body?.think)} ${show(v1BodyFor(offOnly, true, 'high'))}`)
  check('off-only: the stamp says thinking off, as the wire does', onlyOff.stamp?.applied === EFFORT_STAMP_THINKING_OFF && onlyOff.stamp?.wire === 'think=false', show(onlyOff.stamp))
}

section('7 · each wire carries only its own spelling, and the fixture saw nothing but POST /api/chat')
{
  check('no think key rides the /v1 body, no reasoning_effort rides the /api/chat body', [legacy, toggle, named, plain, offOnly].every(record => !('think' in v1BodyFor(record, false, 'high')) && !('think' in v1BodyFor(record, true, 'high'))) && chatBodies.every(body => !('reasoning_effort' in body)))
  check('every request the fixture saw was POST /api/chat, one per dispatch (no /v1 fallthrough, no probe)', requests.length === dispatches && chatBodies.length === dispatches && requests.every(line => line === 'POST /api/chat'), `${dispatches} dispatches, saw: ${requests.join(', ')}`)
}


fixture.stop(true)
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
