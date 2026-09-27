#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-thinking-wires-agree-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
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

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { localLaneProfileFor, localModelAcceptsEffort } = await import('../../src/services/providers/local/localCallModel.ts')
const { buildLocalExtras, localThinkingOff } = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { ollamaChatUrl } = await import('../../src/services/providers/local/ollamaChatTransport.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
type LocalModelRecord = import('../../src/services/providers/local/localDiscovery.ts').LocalModelRecord

const thinker: LocalModelRecord = { id: 'thinker:27b', server: 'ollama', baseUrl: `${root}/v1`, toolsDeclared: true, thinkingDeclared: true, family: 'qwen3', parameterSize: '27B' }
const plain: LocalModelRecord = { id: 'plain:8b', server: 'ollama', baseUrl: `${root}/v1`, toolsDeclared: true, thinkingDeclared: false, family: 'qwen3', parameterSize: '8B' }

const v1BodyFor = (record: LocalModelRecord, thinkingEnabled: boolean): { reasoning_effort?: string; think?: unknown } =>
  buildLocalExtras({ wireModel: record.id, effortValue: 'high', thinkingEnabled, maxOutputTokensOverride: undefined, server: record.server, acceptsEffort: localModelAcceptsEffort(record) })
const nativeBodyFor = async (record: LocalModelRecord, thinkingEnabled: boolean): Promise<Record<string, unknown> | undefined> => {
  const before = chatBodies.length
  for await (const item of compatChatCallModel(localLaneProfileFor(record), {
    messages: [{ type: 'user', message: { role: 'user', content: 'hi' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
    systemPrompt: ['sys'] as never,
    thinkingConfig: (thinkingEnabled ? { type: 'enabled', budget_tokens: 1024 } : { type: 'disabled' }) as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model: `local/${record.id}`, querySource: 'user', effortValue: 'high', getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
  })) {
    void item
  }
  return chatBodies.length > before ? chatBodies.at(-1) : undefined
}
const predicateFor = (record: LocalModelRecord, thinkingEnabled: boolean): boolean =>
  localThinkingOff({ server: record.server, acceptsEffort: localModelAcceptsEffort(record), thinkingEnabled })

section('1 · the fixture record and the roads: one Ollama record whose base points at the loopback fixture')
{
  check('the native road posts to the fixture /api/chat (ollamaChatUrl of the record base)', ollamaChatUrl(thinker.baseUrl) === `${root}/api/chat`, ollamaChatUrl(thinker.baseUrl))
  check('the record is a thinking-declared Ollama model (the effort dial applies)', thinker.server === 'ollama' && thinker.thinkingDeclared === true && localModelAcceptsEffort(thinker) === true)
  check('the sibling record states no thinking (no dial on either wire)', plain.thinkingDeclared === false && localModelAcceptsEffort(plain) === false)
  check('every proof process runs with probing off (MERCURY_LOCAL_PROBE_TARGETS=none)', process.env.MERCURY_LOCAL_PROBE_TARGETS === 'none')
}

section('2 · thinking OFF on the thinking-declared record: reasoning_effort "none" on /v1 and think false on /api/chat')
{
  const v1 = v1BodyFor(thinker, false)
  const native = await nativeBodyFor(thinker, false)
  check('the thinking-off dispatch reached the fixture /api/chat', native !== undefined, requests.join(', '))
  check('/v1: reasoning_effort "none"', v1.reasoning_effort === 'none', `sent ${JSON.stringify(v1.reasoning_effort)}`)
  check('/api/chat: think false', native?.think === false, `sent ${JSON.stringify(native?.think)}`)
  check('the predicate says off, and both wires read as it says', predicateFor(thinker, false) === true && (v1.reasoning_effort === 'none') === predicateFor(thinker, false) && native?.think === !predicateFor(thinker, false))
}

section('3 · thinking ON on the same record: no "none" on /v1 and think true on /api/chat')
{
  const v1 = v1BodyFor(thinker, true)
  const native = await nativeBodyFor(thinker, true)
  check('the thinking-on dispatch reached the fixture /api/chat', native !== undefined, requests.join(', '))
  check('/v1: the effort word, never "none"', v1.reasoning_effort !== undefined && v1.reasoning_effort !== 'none', `sent ${JSON.stringify(v1.reasoning_effort)}`)
  check('/api/chat: think true', native?.think === true, `sent ${JSON.stringify(native?.think)}`)
  check('the predicate says not off, and both wires read as it says', predicateFor(thinker, true) === false && (v1.reasoning_effort === 'none') === predicateFor(thinker, true) && native?.think === !predicateFor(thinker, true))
}

section('4 · a record that states no thinking: neither key on either wire, thinking on or off')
{
  const v1Off = v1BodyFor(plain, false)
  const v1On = v1BodyFor(plain, true)
  const nativeOff = await nativeBodyFor(plain, false)
  const nativeOn = await nativeBodyFor(plain, true)
  check('both dispatches reached the fixture /api/chat', nativeOff !== undefined && nativeOn !== undefined, requests.join(', '))
  check('/v1: no reasoning_effort', !('reasoning_effort' in v1Off) && !('reasoning_effort' in v1On), `${JSON.stringify(v1Off)} ${JSON.stringify(v1On)}`)
  check('/api/chat: no think key', nativeOff !== undefined && !('think' in nativeOff) && nativeOn !== undefined && !('think' in nativeOn), `${JSON.stringify(nativeOff?.think)} ${JSON.stringify(nativeOn?.think)}`)
  check('the predicate says not off for a model with nothing to switch', predicateFor(plain, false) === false && predicateFor(plain, true) === false)
}

section('5 · each wire carries only its own spelling, and the fixture saw nothing but POST /api/chat')
{
  check('no think key rides the /v1 body, no reasoning_effort rides the /api/chat body', !('think' in v1BodyFor(thinker, false)) && chatBodies.every(body => !('reasoning_effort' in body)))
  check('every request the fixture saw was POST /api/chat (no /v1 fallthrough, no probe)', requests.length === 4 && requests.every(line => line === 'POST /api/chat'), requests.join(', '))
}

section('6 · one owner: the native think knob in localCallModel.ts reads the localThinkingOff predicate from compatWire.ts')
{
  const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'providers', 'local', 'localCallModel.ts'), 'utf8')
  const thinkLines = source.split('\n').filter(line => /\bthink:\s/.test(line))
  check('exactly one line of localCallModel.ts sets the native think knob', thinkLines.length === 1, thinkLines.join(' | '))
  check('that line reads think: !localThinkingOff( — the predicate, not its own expression', thinkLines.length === 1 && thinkLines[0]!.includes('think: !localThinkingOff('), thinkLines.map(line => line.trim()).join(' | '))
  check('that line does not read the bare switch (think: thinkingEnabled)', !thinkLines.some(line => /\bthink:\s*thinkingEnabled\b/.test(line)), thinkLines.map(line => line.trim()).join(' | '))
  check('localThinkingOff is imported from compatWire.js (the one owner), not defined locally', /import \{[^}]*\blocalThinkingOff\b[^}]*\} from '\.\.\/openaicompat\/compatWire\.js'/.test(source) && !/function localThinkingOff\b/.test(source))
}

fixture.stop(true)
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
