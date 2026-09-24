#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'alias-served-rows-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'MERCURY_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_CUSTOM_MODEL_OPTION',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_CONSOLE_MODEL',
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_DEFAULT_HAIKU_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_AUTOPILOT_MODELS',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'CI',
  'NODE_ENV',
]) {
  delete process.env[key]
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
for (const base of [
  'ANTHROPIC_BASE_URL',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_ZAI_API_BASE',
  'MERCURY_MOONSHOT_OAUTH_BASE',
]) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail?: string): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })

const ALIAS = 'kimi-for-coding'
const FAST_ALIAS = 'kimi-for-coding-highspeed'
const SERVED = 'kimi-k3'
const OTHER_SERVED = 'kimi-k2.7-code'
const MOONSHOT_TITLE = 'MERCURY — MOONSHOT MODELS'
const KIMI_LABEL = 'Kimi account (device-code sign-in · global (kimi.ai))'
const OFFERED = `${ALIAS}, ${FAST_ALIAS}`
const PLAIN_REFUSAL = `model '${SERVED}' is not offered by the ${KIMI_LABEL} live catalogue. The catalogue offers: ${OFFERED}.`
const OBSERVED_REFUSAL = `model '${SERVED}' is not offered by the ${KIMI_LABEL} live catalogue. ${SERVED} is served here as ${ALIAS}. The catalogue offers: ${OFFERED}.`

let servedField: string | null = SERVED
let chatRequests = 0
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const chunk = (body: Record<string, unknown>): Record<string, unknown> => ({
  id: 'chatcmpl-fixture',
  object: 'chat.completion.chunk',
  ...(servedField !== null ? { model: servedField } : {}),
  ...body,
})
type Hold = { arrived: () => void; released: Promise<void> }
let holdNext: Hold | null = null
function holdNextReply(): { arrived: Promise<void>; release: () => void } {
  let arrived: () => void = () => {}
  let release: () => void = () => {}
  const arrivedPromise = new Promise<void>(resolve => { arrived = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  holdNext = { arrived, released }
  return { arrived: arrivedPromise, release }
}
const fixture = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0] ?? ''
  req.on('data', () => {})
  req.on('end', () => {
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [
        { id: ALIAS, object: 'model', created: 200, owned_by: 'moonshot', context_length: 262144 },
        { id: FAST_ALIAS, object: 'model', created: 100, owned_by: 'moonshot', context_length: 262144 },
      ] }))
      return
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      chatRequests++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const opening = sse(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture answer' } }] }))
      const closing = sse(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } })) + 'data: [DONE]\n\n'
      const held = holdNext
      if (held !== null) {
        holdNext = null
        res.write(opening)
        held.arrived()
        void held.released.then(() => res.end(closing))
        return
      }
      res.end(opening + closing)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const port = (fixture.address() as { port: number }).port
const loopback = `http://127.0.0.1:${port}`
process.env.MERCURY_MOONSHOT_CODING_BASE = `${loopback}/coding/v1`
process.env.MERCURY_MOONSHOT_API_BASE = `${loopback}/platform/v1`

const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const spelled = String(url instanceof Request ? url.url : url)
  if (spelled.startsWith(loopback)) return realFetch(url, init)
  if (spelled.includes('/v1/models')) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fixture: no list here' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected request: ${spelled}`)
}) as typeof fetch

;(await import('../../src/utils/config.ts')).enableConfigs()
const accounts = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
const catalogue = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const { keyLanePins, getModelOptions, MOONSHOT_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
const { moonshotCallModel } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { resolveEngineDispatch } = await import('../../src/utils/swarm/engineDispatch.ts')
const { validateModel } = await import('../../src/utils/model/validateModel.ts')
const { getModelUsage } = await import('../../src/bootstrap/state.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { credentialFingerprint } = await import('../../src/services/providers/credentialIdentity.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const React = (await import('react')).default
const { render } = await import('../../src/ink.ts')
const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.tsx')
const { createStore } = await import('../../src/state/store.ts')
const { call } = await import('../../src/commands/model/mercuryModel.tsx')

type Owner = {
  moonshotServedModelFor?: (requested: string) => string | undefined
  moonshotAliasesServing?: (served: string) => string[]
  moonshotAccountIdentity?: () => string | undefined
  recordMoonshotServedModel?: (requested: string, served: string) => boolean
}
const owner = accounts as unknown as Owner
const servedFor = (requested: string): string | undefined => owner.moonshotServedModelFor?.(requested)
const aliasesServing = (served: string): string[] => owner.moonshotAliasesServing?.(served) ?? []
const identityNow = (): string | undefined => owner.moonshotAccountIdentity?.()
const recordDirect = (requested: string, served: string): boolean => owner.recordMoonshotServedModel?.(requested, served) ?? false

const TOKENS_A = { accessToken: 'fixture-access-a', refreshToken: 'fixture-refresh-a', accessTokenExpiresAtMs: Date.now() + 86400000 }
const TOKENS_B = { accessToken: 'fixture-access-b', refreshToken: 'fixture-refresh-b', accessTokenExpiresAtMs: Date.now() + 86400000 }
async function signIn(tokens: typeof TOKENS_A): Promise<void> {
  accounts.writeMoonshotTokens(tokens, 'global')
  await catalogue.refreshMoonshotCatalogue({ force: true })
}

type Row = { id: string; servedAs?: { id: string; displayName: string } }
const rows = (): Row[] => keyLanePins('moonshot') as Row[]
const rowServedAs = (id: string): string | undefined => rows().find(row => row.id === id)?.servedAs?.id
const labelOf = (id: string): string | undefined => getModelOptions().find(option => option.group === MOONSHOT_MODEL_GROUP && option.value === id)?.label

const chatParams = (model: string): Parameters<typeof moonshotCallModel>[0] => ({
  messages: [createUserMessage({ content: 'say hi' })],
  systemPrompt: ['fixture system prompt'],
  thinkingConfig: { type: 'disabled' },
  tools: [],
  signal: new AbortController().signal,
  options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model, isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'high' },
}) as never
type Settled = { model: string; api: boolean; text: string }
async function turn(model: string): Promise<Settled[]> {
  const out: Settled[] = []
  for await (const item of moonshotCallModel(chatParams(model))) {
    if ((item as { type?: string }).type !== 'assistant') continue
    const message = item as { isApiErrorMessage?: boolean; message: { model: string; content: Array<{ type: string; text?: string }> } }
    out.push({ model: message.message.model, api: message.isApiErrorMessage === true, text: message.message.content.map(block => block.text ?? '').join('') })
  }
  return out
}
const refusalOf = async (id: string): Promise<string> => {
  const verdict = await catalogue.qualifyMoonshotModel(id)
  return verdict.kind === 'refused' ? verdict.message : `${verdict.kind}: ${verdict.modelId}`
}
const dispatchRefusalOf = (id: string): Promise<string> => resolveEngineDispatch(id).then(resolved => `resolved ${resolved?.model ?? 'null'}`, error => (error instanceof Error ? error.message : String(error)))
const typedRefusalOf = async (id: string): Promise<string> => (await validateModel(id)).error ?? 'valid'

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 150))
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const rowLine = (lines: string[], label: string): number => lines.findIndex(l => new RegExp(`${escapeRegExp(label)}\\s{2,}[○●⦿] (current|switch|unavail|next)`).test(l))
async function mountModel(model: string): Promise<{ frame: () => string; unmount: () => void }> {
  const stdout = Object.assign(new PassThrough(), { columns: 178, rows: 51 })
  stdout.resume()
  const input: string[] = []
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return input.shift() ?? null }, readableLength: 0, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } })
  const store = createStore({ ...getDefaultAppState(), mainLoopModel: model }, () => {})
  const picker = await call(() => {}, { messages: [] } as never, '')
  const instance = await render(React.createElement(AppStoreContext.Provider, { value: store }, picker), { stdout: stdout as never, stdin: stdin as never, patchConsole: false })
  const frame = (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, '')
  const until = Date.now() + 5000
  while (Date.now() < until && !(frame().includes(MOONSHOT_TITLE) && rowLine(frame().split('\n'), 'Kimi For Coding Highspeed') >= 0)) await flush()
  await flush()
  await flush()
  return { frame, unmount: () => instance.unmount() }
}
const lineUnder = (lines: string[], title: string): string => {
  const at = lines.findIndex(l => l.includes(title))
  if (at < 0) return ''
  const col = lines[at]!.indexOf(title)
  const right = lines[at]!.indexOf('│', col)
  return (lines[at + 1] ?? '').slice(col, right > col ? right : undefined).trim()
}
async function captureFrame(name: string): Promise<string[]> {
  const mounted = await mountModel(ALIAS)
  const frame = mounted.frame()
  mounted.unmount()
  const lines = frame.split('\n')
  if (frameDir !== undefined) writeFileSync(join(frameDir, `model-178x51-${name}.txt`), frame + '\n')
  const painted = lines.filter(l => /Kimi For Coding/.test(l) && /[○●⦿] (current|switch|unavail|next)/.test(l)).map(l => l.replace(/^.*?│\s*(?:│\s*)?/, '').replace(/\s+│.*$/, '').replace(/\s{2,}/g, '  ').trim())
  console.log(`  [record] ${name}: under the title "${lineUnder(lines, MOONSHOT_TITLE)}" · rows: ${painted.join(' | ')}`)
  check(`[${name}] the frame fits 178x51`, lines.length <= 51 && lines.every(line => stringWidth(line) <= 178), `${lines.length} lines · widest ${Math.max(...lines.map(line => stringWidth(line)))}`)
  check(`[${name}] the Moonshot section is on screen with both alias rows`, lines.some(l => l.includes(MOONSHOT_TITLE)) && rowLine(lines, 'Kimi For Coding Highspeed') >= 0 && lines.some(l => /Kimi For Coding(?! Highspeed)/.test(l) && /[○●⦿] (current|switch)/.test(l)))
  check(`[${name}] the current mark sits on the ${ALIAS} row`, lines.some(l => /Kimi For Coding(?! Highspeed)/.test(l) && l.includes('● current')))
  return lines
}

section(`§1 no observation, no mapping: a fresh Kimi sign-in lists the aliases bare and refuses ${SERVED} with the plain sentence`)
await signIn(TOKENS_A)
check('the live list lands with the two aliases', rows().map(row => row.id).join(',') === `${ALIAS},${FAST_ALIAS}`, rows().map(row => row.id).join(','))
check('no row carries a served word before any reply was observed', rows().every(row => row.servedAs === undefined))
check(`the owner answers nothing for ${ALIAS}`, servedFor(ALIAS) === undefined && aliasesServing(SERVED).length === 0)
check(`the picker labels are the bare aliases`, labelOf(ALIAS) === 'Kimi For Coding' && labelOf(FAST_ALIAS) === 'Kimi For Coding Highspeed', `${labelOf(ALIAS)} / ${labelOf(FAST_ALIAS)}`)
const plainBefore = await refusalOf(SERVED)
console.log(`  [record] refusal before any observation: ${plainBefore}`)
check('the admission refuses with the plain sentence (no invented mapping)', plainBefore === PLAIN_REFUSAL, plainBefore)
check('the Agent tool road throws the same plain sentence', (await dispatchRefusalOf(SERVED)) === PLAIN_REFUSAL)
check('the typed /model road answers the same plain sentence', (await typedRefusalOf(SERVED)) === PLAIN_REFUSAL)
const unobservedLines = await captureFrame('kimi-unobserved')
check('[kimi-unobserved] both rows paint the bare alias', rowLine(unobservedLines, 'Kimi For Coding') >= 0 && rowLine(unobservedLines, 'Kimi For Coding Highspeed') >= 0 && !unobservedLines.some(l => l.includes('Kimi For Coding · ')))

section(`§2 an observed reply: the served-model field of a settled turn on ${ALIAS} paints the row and reaches the refusal`)
{
  const settled = await turn(ALIAS)
  check('the fixture turn settled with the answer and no fault', settled.length >= 1 && settled.some(item => item.text === 'fixture answer') && settled.every(item => !item.api), JSON.stringify(settled))
  check('the transcript keeps the dispatchable id as the message model (the resume law: a resumed session must request the alias, never the served id)', settled.every(item => item.model === ALIAS), settled.map(item => item.model).join(','))
  const ledgerKeys = Object.keys(getModelUsage())
  check(`the session ledger keys the turn by the requested id (${ALIAS}), not the served id`, ledgerKeys.includes(ALIAS) && !ledgerKeys.includes(SERVED), ledgerKeys.join(','))
  check(`the owner remembers ${ALIAS} → ${SERVED} for this account`, servedFor(ALIAS) === SERVED, String(servedFor(ALIAS)))
  check(`the reverse read names ${ALIAS} as the alias serving ${SERVED}`, aliasesServing(SERVED).join(',') === ALIAS, aliasesServing(SERVED).join(','))
  const epochBefore = catalogueEpoch()
  check('a changed observation bumps the catalogue epoch once (the picker repaints in place); an unchanged one does not', recordDirect('kimi-fixture-alias', 'kimi-fixture-target') && catalogueEpoch() === epochBefore + 1 && !recordDirect('kimi-fixture-alias', 'kimi-fixture-target') && catalogueEpoch() === epochBefore + 1)
  recordDirect('kimi-fixture-alias', 'kimi-fixture-alias')
  check(`the ${ALIAS} row carries the served id and its short form`, rowServedAs(ALIAS) === SERVED && rows().find(row => row.id === ALIAS)?.servedAs?.displayName === 'K3', JSON.stringify(rows()))
  check(`the ${FAST_ALIAS} row stays bare (no reply observed on it)`, rowServedAs(FAST_ALIAS) === undefined)
  check(`the picker label reads 'Kimi For Coding · K3' and the other row stays bare`, labelOf(ALIAS) === 'Kimi For Coding · K3' && labelOf(FAST_ALIAS) === 'Kimi For Coding Highspeed', `${labelOf(ALIAS)} / ${labelOf(FAST_ALIAS)}`)
  const observed = await refusalOf(SERVED)
  console.log(`  [record] refusal after the observation: ${observed}`)
  check(`the admission names the alias: '${SERVED} is served here as ${ALIAS}' and still lists the offered ids`, observed === OBSERVED_REFUSAL, observed)
  const dispatch = await dispatchRefusalOf(SERVED)
  check('the Agent tool road throws the sentence with the served fact', dispatch === OBSERVED_REFUSAL, dispatch)
  check('the typed /model road answers the sentence with the served fact', (await typedRefusalOf(SERVED)) === OBSERVED_REFUSAL)
  if (frameDir !== undefined) {
    writeFileSync(join(frameDir, `refusal-${SERVED}.txt`), [
      `[before any observed reply] ${plainBefore}`,
      `[after a reply on ${ALIAS} carried model=${SERVED}] ${observed}`,
      `[Agent tool, model: '${SERVED}'] Error: ${dispatch}`,
      '',
    ].join('\n'))
  }
  const observedLines = await captureFrame('kimi-observed')
  check(`[kimi-observed] the ${ALIAS} row paints 'Kimi For Coding · K3'`, rowLine(observedLines, 'Kimi For Coding · K3') >= 0, observedLines.filter(l => l.includes('Kimi For Coding')).join(' | '))
  check(`[kimi-observed] the ${FAST_ALIAS} row paints the bare alias`, rowLine(observedLines, 'Kimi For Coding Highspeed') >= 0)
}

section('§2a the transport fact: the compat client decodes the reply model field into one typed event; a reply without the field yields none')
{
  const events: Array<{ type: string; model?: string }> = []
  for await (const event of streamCompatChat({ apiKey: 'fixture', url: `${loopback}/coding/v1/chat/completions`, request: { model: ALIAS, messages: [{ role: 'user', content: 'hi' }] } })) events.push(event as { type: string; model?: string })
  const servedEvents = events.filter(event => event.type === 'served-model')
  check(`one served-model event carries the wire's word (${SERVED}), deduplicated across chunks`, servedEvents.length === 1 && servedEvents[0]?.model === SERVED, JSON.stringify(events.map(event => event.type)))
  check('the text and finish still settle beside it', events.some(event => event.type === 'text-delta') && events.some(event => event.type === 'finish'))
  servedField = null
  const bare: Array<{ type: string }> = []
  for await (const event of streamCompatChat({ apiKey: 'fixture', url: `${loopback}/coding/v1/chat/completions`, request: { model: ALIAS, messages: [{ role: 'user', content: 'hi' }] } })) bare.push(event as { type: string })
  check('a reply without a model field yields no served-model event (nothing invented)', !bare.some(event => event.type === 'served-model') && bare.some(event => event.type === 'finish'))
  servedField = SERVED
}

section('§3 per-account separation: another sign-in, an env key, and the return of the first account')
{
  const identityA = identityNow()
  await signIn(TOKENS_B)
  const identityB = identityNow()
  check('the two sign-ins carry different identities (the credential-fingerprint law)', identityA !== undefined && identityB !== undefined && identityA !== identityB, `${identityA} / ${identityB}`)
  check('the second account reads no observation', servedFor(ALIAS) === undefined && rows().every(row => row.servedAs === undefined))
  check('the second account is refused with the plain sentence', (await refusalOf(SERVED)) === PLAIN_REFUSAL)
  servedField = OTHER_SERVED
  await turn(ALIAS)
  servedField = SERVED
  check(`the second account observes its own mapping (${ALIAS} → ${OTHER_SERVED})`, servedFor(ALIAS) === OTHER_SERVED && rows().find(row => row.id === ALIAS)?.servedAs?.displayName === 'K2.7 Code', String(servedFor(ALIAS)))
  check(`the second account's refusal names its own served id, not the first account's`, (await refusalOf(OTHER_SERVED)).includes(`${OTHER_SERVED} is served here as ${ALIAS}`) && (await refusalOf(SERVED)) === PLAIN_REFUSAL)
  process.env.MOONSHOT_API_KEY = 'fixture-env-key'
  await catalogue.refreshMoonshotCatalogue({ force: true })
  check('an env key account reads no observation of either sign-in', servedFor(ALIAS) === undefined && rows().every(row => row.servedAs === undefined))
  delete process.env.MOONSHOT_API_KEY
  await signIn(TOKENS_A)
  check(`the first account's mapping is back untouched (${ALIAS} → ${SERVED})`, servedFor(ALIAS) === SERVED && labelOf(ALIAS) === 'Kimi For Coding · K3', String(servedFor(ALIAS)))
}

section('§4 replacement: a later reply replaces the record; a reply that serves the alias itself drops it; a reply without the field changes nothing')
{
  servedField = OTHER_SERVED
  await turn(ALIAS)
  check(`the newer reply replaces the record (${ALIAS} → ${OTHER_SERVED})`, servedFor(ALIAS) === OTHER_SERVED && labelOf(ALIAS) === 'Kimi For Coding · K2.7 Code', `${servedFor(ALIAS)} / ${labelOf(ALIAS)}`)
  check(`${SERVED} is refused with the plain sentence again; ${OTHER_SERVED} names the alias`, (await refusalOf(SERVED)) === PLAIN_REFUSAL && (await refusalOf(OTHER_SERVED)) === OBSERVED_REFUSAL.replaceAll(SERVED, OTHER_SERVED))
  servedField = ALIAS
  await turn(ALIAS)
  check('a reply that names the alias itself drops the record (the row is bare again)', servedFor(ALIAS) === undefined && labelOf(ALIAS) === 'Kimi For Coding', String(servedFor(ALIAS)))
  servedField = null
  await turn(ALIAS)
  check('a reply without the field observes nothing', servedFor(ALIAS) === undefined)
  servedField = SERVED
  await turn(ALIAS)
  check(`the mapping is observed again (${ALIAS} → ${SERVED})`, servedFor(ALIAS) === SERVED)
  const requestsBefore = chatRequests
  const fileBefore = readFileSync(join(home, '.moonshot-auth.json'), 'utf8')
  await turn(ALIAS)
  check('an unchanged observation rewrites nothing (the store moves only when the mapping changes)', chatRequests === requestsBefore + 1 && readFileSync(join(home, '.moonshot-auth.json'), 'utf8') === fileBefore)
}

section('§5 persistence: the record rests in the account owner\'s auth-scoped file, survives a restart and a disconnect, and stays keyed to its account')
{
  const file = JSON.parse(readFileSync(join(home, '.moonshot-auth.json'), 'utf8')) as { tokens?: unknown; servedModels?: Record<string, Array<{ requested: string; served: string; observedAtMs: number }>> }
  const identity = identityNow()
  const stored = identity !== undefined ? file.servedModels?.[identity] : undefined
  check('the auth file carries the record under the account\'s fingerprint, beside the tokens', identity !== undefined && Array.isArray(stored) && stored.some(record => record.requested === ALIAS && record.served === SERVED) && file.tokens !== undefined, JSON.stringify(file.servedModels))
  check('no token or key material enters the record', !JSON.stringify(file.servedModels ?? {}).includes('fixture-access') && !JSON.stringify(file.servedModels ?? {}).includes('fixture-refresh'))
  const child = join(scratch, 'read-after-restart.ts')
  writeFileSync(child, [
    ";(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }",
    `const owner = await import(${JSON.stringify(join(import.meta.dir, '../../src/services/providers/moonshot/moonshotAccounts.ts'))})`,
    `console.log(JSON.stringify({ served: owner.moonshotServedModelFor(${JSON.stringify(ALIAS)}), aliases: owner.moonshotAliasesServing(${JSON.stringify(SERVED)}) }))`,
    '',
  ].join('\n'))
  const restarted = spawnSync(process.execPath, ['run', child], { env: { ...process.env }, encoding: 'utf8' })
  const line = restarted.stdout.trim().split('\n').at(-1) ?? ''
  let parsed: { served?: string; aliases?: string[] } = {}
  try {
    parsed = JSON.parse(line) as { served?: string; aliases?: string[] }
  } catch {
    parsed = {}
  }
  check('a fresh process reads the same mapping from the file (the restart law)', restarted.status === 0 && parsed.served === SERVED && (parsed.aliases ?? []).join(',') === ALIAS, `${restarted.status}: ${line || restarted.stderr.trim().split('\n').at(-1)}`)
  accounts.writeMoonshotTokens(null)
  check('signed out, nothing is observed (no account, no record)', servedFor(ALIAS) === undefined)
  await signIn(TOKENS_A)
  check('the same account signing in again reads its own record', servedFor(ALIAS) === SERVED)
  check('the file survives the round trip at the auth scope', existsSync(join(home, '.moonshot-auth.json')))
}

const authFileServedModels = (): Record<string, Array<{ requested: string; served: string; observedAtMs: number }>> =>
  (JSON.parse(readFileSync(join(home, '.moonshot-auth.json'), 'utf8')) as { servedModels?: Record<string, Array<{ requested: string; served: string; observedAtMs: number }>> }).servedModels ?? {}

section('§5a a sign-in that changes mid-turn never moves the served model to the new account')
{
  servedField = ALIAS
  await turn(ALIAS)
  check('the first account starts this leg with no record for the alias', servedFor(ALIAS) === undefined)
  await signIn(TOKENS_B)
  await turn(ALIAS)
  check('the second account starts this leg with no record for the alias either', servedFor(ALIAS) === undefined)
  await signIn(TOKENS_A)
  servedField = SERVED
  const held = holdNextReply()
  const inFlight = turn(ALIAS)
  await held.arrived
  accounts.writeMoonshotTokens(TOKENS_B, 'global')
  check('the second account is current while the first account\'s reply is still in flight', identityNow() === credentialFingerprint(TOKENS_B.refreshToken))
  held.release()
  const settled = await inFlight
  check('the held turn settled with the answer and no fault', settled.some(item => item.text === 'fixture answer') && settled.every(item => !item.api), JSON.stringify(settled))
  check('with the second account current, nothing is observed for the alias and no alias serves the id', servedFor(ALIAS) === undefined && aliasesServing(SERVED).length === 0, `${String(servedFor(ALIAS))} / ${aliasesServing(SERVED).join(',')}`)
  const identityA = credentialFingerprint(TOKENS_A.refreshToken)
  const recordedForA = authFileServedModels()[identityA] ?? []
  check('the record was written under the fingerprint of the first account\'s refresh token (the dispatch-time identity rule)', recordedForA.some(record => record.requested === ALIAS && record.served === SERVED), JSON.stringify(authFileServedModels()))
  check('no record was written under the second account', (authFileServedModels()[credentialFingerprint(TOKENS_B.refreshToken)] ?? []).length === 0)
  await signIn(TOKENS_A)
  check('signed back in as the first account, the mapping is its own', servedFor(ALIAS) === SERVED && aliasesServing(SERVED).join(',') === ALIAS)
}

section('§5b a routine token refresh that rotates the refresh token carries the account\'s rows to the new identity')
{
  const before = identityNow()
  check('the leg starts with the first account signed in and its row recorded', before === credentialFingerprint(TOKENS_A.refreshToken) && servedFor(ALIAS) === SERVED)
  const posts: Array<{ url: string; grant: string | null; refreshToken: string | null }> = []
  const rotating = (async (url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ''))
    posts.push({ url: String(url), grant: form.get('grant_type'), refreshToken: form.get('refresh_token') })
    return Response.json({ access_token: 'fixture-access-a2', refresh_token: 'fixture-refresh-a2', expires_in: 86400 })
  }) as typeof fetch
  const fresh = await accounts.refreshMoonshotTokens({ fetchImpl: rotating })
  check('the refresh posted the stored refresh token once and landed a rotated one', posts.length === 1 && posts[0]?.url.endsWith('/api/oauth/token') === true && posts[0]?.grant === 'refresh_token' && posts[0]?.refreshToken === TOKENS_A.refreshToken && fresh?.refreshToken === 'fixture-refresh-a2' && fresh.accessToken === 'fixture-access-a2', JSON.stringify(posts))
  const after = identityNow()
  check('the account identity moved to the rotated refresh token\'s fingerprint', after === credentialFingerprint('fixture-refresh-a2') && after !== before, `${before} → ${after}`)
  check('the served row follows the account across the rotation', servedFor(ALIAS) === SERVED && aliasesServing(SERVED).join(',') === ALIAS, String(servedFor(ALIAS)))
  const table = authFileServedModels()
  check('the old identity\'s rows are gone from the file and the new identity holds them', before !== undefined && table[before] === undefined && (after === undefined ? [] : table[after] ?? []).some(record => record.requested === ALIAS && record.served === SERVED), JSON.stringify(table))
  await catalogue.refreshMoonshotCatalogue({ force: true })
  check('the picker row keeps its served word after the rotation', labelOf(ALIAS) === 'Kimi For Coding · K3', String(labelOf(ALIAS)))
  check('the refusal still names the alias after the rotation', (await refusalOf(SERVED)) === OBSERVED_REFUSAL)
}

section('§6 the seams, source-shaped')
{
  const client = readFileSync(join(import.meta.dir, '../../src/services/providers/openaicompat/compatChatClient.ts'), 'utf8')
  const runtime = readFileSync(join(import.meta.dir, '../../src/services/providers/openaicompat/compatChatCallModel.ts'), 'utf8')
  const lane = readFileSync(join(import.meta.dir, '../../src/services/providers/moonshot/moonshotCallModel.ts'), 'utf8')
  const admission = readFileSync(join(import.meta.dir, '../../src/services/providers/catalogueAdmission.ts'), 'utf8')
  const ownerSource = readFileSync(join(import.meta.dir, '../../src/services/providers/moonshot/moonshotAccounts.ts'), 'utf8')
  check('the one chunk decoder names the served model as a typed event', client.includes("out.push({ type: 'served-model', model: servedModel })"))
  check('the shared runtime hands the settled served word to the lane owner and never stamps it onto the transcript model', runtime.includes('profile.noteServedModel?.(modelId, outcome.served, credential)') && runtime.includes('    model: modelId,\n    content: [] as ContentBlock[],'))
  check('the Moonshot lane routes the observation to its account owner', lane.includes('recordMoonshotServedModel(requested, served, { identity: credential.accountIdentity })'))
  check('the refusal words keep one owner; the served fact is an optional clause of the same sentence', admission.includes('is not offered by the ${accountLabel} live catalogue.${alias}${hint}'))
  check('the dispatch credential pins the account identity from the token set in hand, through the one helper the current-identity read uses', ownerSource.includes('accountIdentity: tokenIdentity(tokens)') && ownerSource.includes('if (tokens) return tokenIdentity(tokens)') && ownerSource.includes("accountIdentity: credentialFingerprint(envKey)") && ownerSource.includes("accountIdentity: credentialFingerprint(stored)"))
  check('a rotated refresh token moves the rows in the same publish that stores the tokens', ownerSource.includes('writeAuthFile(file => withServedModelsMoved(withTokens(file, next, region), tokenIdentity(stored), tokenIdentity(next)))'))
}

globalThis.fetch = realFetch
fixture.closeAllConnections()
await new Promise<void>(resolve => fixture.close(() => resolve()))
rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-alias-served-rows: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
