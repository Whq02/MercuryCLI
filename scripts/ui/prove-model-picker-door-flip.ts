#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'picker-door-flip-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_CUSTOM_MODEL_OPTION', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'NODE_ENV', 'CI', 'MERCURY_EFFORT_LEVEL',
]) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1/anthropic'
for (const base of ['MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}
const MAX_CREDENTIAL = {
  claudeAiOauth: {
    accessToken: 'fixture-access-token-000000000001',
    refreshToken: 'fixture-refresh-token-00000000001',
    expiresAt: 4102444800000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
  },
}
const MANAGED_KEY = 'proof-managed-key-ci-gate-not-a-real-key'
writeFileSync(join(home, '.credentials.json'), JSON.stringify(MAX_CREDENTIAL), { mode: 0o600 })
const { enableConfigs, saveGlobalConfig, getGlobalConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveGlobalConfig(config => ({ ...config, primaryApiKey: MANAGED_KEY }))
const auth = await import('../../src/utils/auth.js')
auth.clearOAuthTokenCache()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const React = (await import('react')).default
const { render } = await import('../../src/ink.js')
const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.js')
const { createStore } = await import('../../src/state/store.js')
const { call } = await import('../../src/commands/model/mercuryModel.js')
const { FAMILY_GENERATIONS } = await import('../../src/utils/model/configs.js')
const { getModelStrings } = await import('../../src/utils/model/modelStrings.js')
const { renderModelName } = await import('../../src/utils/model/model.js')
const anthropic = await import('../../src/services/providers/anthropic/anthropicCatalogue.js')
const { slotSeatView } = await import('../../src/services/providers/slotSwitch.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { readModelUseLedger } = await import('../../src/utils/model/modelUseLedger.js')
type Message = import('../../src/types/message.js').Message

const strings = getModelStrings()
const OPUS = strings[FAMILY_GENERATIONS.opus[0]!]!
const SONNET = strings[FAMILY_GENERATIONS.sonnet[0]!]!
const listOf = (ids: string[]): Response => new Response(JSON.stringify({ data: ids.map(id => ({ id, display_name: renderModelName(id), type: 'model' })), has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.includes('/v1/models')) throw new Error(`unexpected request: ${url}`)
  const headers = new Headers(init?.headers as HeadersInit | undefined)
  if (headers.has('x-api-key')) return listOf([OPUS])
  return listOf([OPUS, SONNET])
}) as typeof fetch

section('§0 two Anthropic doors signed in: the Max login on the seat, the managed key beside it; the key door lists the opus, the login door lists both')
{
  const doors = anthropic.anthropicDoors().map(door => door.door)
  check('both doors are credentialed', doors.includes('subscription') && doors.includes('api-key'), doors.join(','))
  await anthropic.refreshAnthropicCatalogue({ force: true })
  const listing = anthropic.anthropicListedModel(OPUS)
  check('the opus is named by both live lists, the sonnet by the login list alone', listing !== undefined && listing.doors.length === 2 && anthropic.anthropicListedModel(SONNET)?.doors.length === 1, JSON.stringify(listing))
  const seat = slotSeatView('anthropic')
  check('the seat view: the subscription is active and the key is the other slot', seat.active === 'subscription' && seat.other?.kind === 'api-key', JSON.stringify(seat))
}

const painted: Message[] = []
const receipts: string[] = []
function seat(setModel: () => Promise<{ state: 'refused'; detail: string } | { state: 'applied' } | { state: 'no-op' }>, served: string): void {
  setFocusedSessionConnector(Object.assign(new NoSessionConnector(), {
    sessionId: () => 'proof-session',
    modelFacts: () => ({ effective: served, main: served, setting: served, sessionPin: null, pendingSwitch: null, effectiveSource: 'live' as const }),
    setModel,
    addDisplayRow: (row: Message) => { painted.push(row) },
  }) as never)
}
const flush = (ms = 150): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function mountPicker(): Promise<{ frame: () => string; press: (keys: string) => Promise<void>; unmount: () => void }> {
  const stdout = Object.assign(new PassThrough(), { columns: 178, rows: 51 })
  stdout.resume()
  const input: string[] = []
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return input.shift() ?? null }, readableLength: 0, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } })
  const store = createStore({ ...getDefaultAppState(), mainLoopModel: SONNET }, () => {})
  const picker = await call((result?: string) => { receipts.push(result ?? '') }, { messages: [] } as never, '')
  const instance = await render(React.createElement(AppStoreContext.Provider, { value: store }, picker), { stdout: stdout as never, stdin: stdin as never, patchConsole: false })
  const frame = (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, '')
  const until = Date.now() + 6000
  while (Date.now() < until && !(frame().includes('API key ·') && frame().includes('↑↓ select'))) await flush()
  await flush(300)
  const press = async (keys: string): Promise<void> => {
    input.push(keys)
    stdin.emit('readable')
    await flush(120)
  }
  return { frame, press, unmount: () => instance.unmount() }
}
const inner = (line: string): string => line.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '').replace(/^│ /, '').trim()
const doorRowsOf = (frame: string, id: string): string[] => frame.split('\n').filter(line => new RegExp(`\\s${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`).test(line) && !line.includes('Mercury · model')).map(inner)
async function walkToLoginDoorRow(picker: { frame: () => string; press: (keys: string) => Promise<void> }, id: string): Promise<boolean> {
  for (let step = 0; step < 30; step++) {
    const lines = picker.frame().split('\n')
    const loginDoorAt = lines.findIndex(line => inner(line).startsWith('Claude Max login · '))
    const boxedAt = lines.findIndex(line => line.includes('│ │ '))
    if (boxedAt > loginDoorAt && loginDoorAt >= 0 && new RegExp(`\\s${id}\\s`).test(lines[boxedAt]!)) return true
    await picker.press('\x1b[B')
  }
  return false
}
async function walkToKeyDoorRow(picker: { frame: () => string; press: (keys: string) => Promise<void> }, id: string): Promise<boolean> {
  for (let step = 0; step < 30; step++) {
    const lines = picker.frame().split('\n')
    const keyDoorAt = lines.findIndex(line => inner(line).startsWith('API key · '))
    const boxedAt = lines.findIndex(line => line.includes('│ │ '))
    if (boxedAt > keyDoorAt && keyDoorAt >= 0 && new RegExp(`\\s${id}\\s`).test(lines[boxedAt]!)) return true
    await picker.press('\x1b[B')
  }
  return false
}

section('§1 ↵ on the opus row under the key door while the daemon refuses the switch: the door stays where it was')
{
  seat(async () => ({ state: 'refused', detail: 'the runner is mid-compaction (fixture)' }), SONNET)
  const picker = await mountPicker()
  const frame = picker.frame()
  check('the heading names both doors and the login door is active', /ANTHROPIC · Claude Max login \+ API key · \d+ live/.test(frame) && /Claude Max login · .* · active/.test(frame), frame.split('\n').filter(l => l.includes('ANTHROPIC') || l.includes('login ·')).map(inner).join(' | '))
  check('the opus stands under both doors, the sonnet under the login door alone', doorRowsOf(frame, OPUS).length === 2 && doorRowsOf(frame, SONNET).length === 1, `${doorRowsOf(frame, OPUS).join(' || ')} · ${doorRowsOf(frame, SONNET).join(' || ')}`)
  check('the cursor walks onto the opus row under the key door', await walkToKeyDoorRow(picker, OPUS), picker.frame().split('\n').filter(line => line.includes('│ │ ') || line.includes('API key · …')).map(inner).join(' | '))
  await picker.press('\r')
  await flush(400)
  check('the receipt is the refusal', receipts.length === 1 && receipts[0]!.startsWith('The model switch was refused: the runner is mid-compaction (fixture)'), receipts.join(' | '))
  check('the billing door did not flip on a refused switch', slotSeatView('anthropic').active === 'subscription' && getGlobalConfig().anthropicPreferredSource === undefined, `active ${slotSeatView('anthropic').active} · preference ${String(getGlobalConfig().anthropicPreferredSource)}`)
  check('no seat receipt row was painted', painted.length === 0, String(painted.length))
  check('the use ledger recorded nothing', readModelUseLedger().anthropic === undefined)
  picker.unmount()
  await flush()
}

section('§2 the same pick while the daemon applies it: the door flips, one receipt names the switch and the door, the ledger carries the door')
{
  receipts.length = 0
  seat(async () => ({ state: 'applied' }), SONNET)
  const picker = await mountPicker()
  check('the cursor walks onto the opus row under the key door', await walkToKeyDoorRow(picker, OPUS))
  await picker.press('\r')
  await flush(400)
  check('the switch sentence names the model and carries the slot receipt', receipts.length === 1 && receipts[0]!.startsWith(`Set model to ${renderModelName(OPUS)}`) && receipts[0]!.includes('active slot switched') && /managed key/.test(receipts[0]!), receipts.join(' | '))
  check('the billing door flipped to the key', slotSeatView('anthropic').active === 'api-key' && getGlobalConfig().anthropicPreferredSource === 'api-key', `active ${slotSeatView('anthropic').active}`)
  check('the seat receipt row was painted once', painted.length === 1, String(painted.length))
  check('the use ledger names the family, the model and the door', readModelUseLedger().anthropic?.model === OPUS && readModelUseLedger().anthropic?.door === 'API key', JSON.stringify(readModelUseLedger().anthropic))
  picker.unmount()
  await flush()
}

section('§3 the same model under the other door while the switch is a no-op: the flip still lands and the sentence says so')
{
  receipts.length = 0
  painted.length = 0
  seat(async () => ({ state: 'no-op' }), OPUS)
  const picker = await mountPicker()
  const frame = picker.frame()
  const doorLines = frame.split('\n').map(inner).filter(line => line.startsWith('API key · ') || line.startsWith('Claude Max login · '))
  check('the key door is active now and its rows come first', doorLines.length === 2 && doorLines[0]!.startsWith('API key · ') && doorLines[0]!.endsWith(' · active') && !doorLines[1]!.endsWith(' · active'), doorLines.join(' | '))
  const opusRows = doorRowsOf(frame, OPUS)
  check('current marks the opus under the active key door only', opusRows.length === 2 && /current/.test(opusRows[0]!) && !/current/.test(opusRows[1]!), opusRows.join(' || '))
  check('the cursor walks onto the opus row under the login door (the other door now)', await walkToLoginDoorRow(picker, OPUS))
  await picker.press('\r')
  await flush(400)
  check('the no-op sentence carries the door flip instead of "nothing to change"', receipts.length === 1 && receipts[0]!.startsWith(`Already on ${renderModelName(OPUS)}`) && !receipts[0]!.includes('nothing to change') && receipts[0]!.includes('active slot switched'), receipts.join(' | '))
  check('the billing door flipped back to the login', slotSeatView('anthropic').active === 'subscription', `active ${slotSeatView('anthropic').active}`)
  picker.unmount()
  await flush()
}

releaseFocusedSessionConnector()
rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-model-picker-door-flip: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
