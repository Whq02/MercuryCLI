#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'model-refresh-moonshot-'))
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
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
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
process.env.BROWSER = '/usr/bin/true'
const DEAD = 'http://127.0.0.1:1'
for (const base of [
  'ANTHROPIC_BASE_URL',
  'MERCURY_CUSTOM_OAUTH_URL',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_OPENROUTER_AUTH_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_GEMINI_OAUTH_AUTH_BASE',
  'MERCURY_GEMINI_OAUTH_TOKEN_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_ZAI_API_BASE',
  'MERCURY_MOONSHOT_OAUTH_BASE',
  'MERCURY_MOONSHOT_API_BASE',
  'MERCURY_UPDATE_API_BASE_URL',
]) {
  process.env[base] = DEAD
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const nowS = Math.floor(Date.now() / 1000)
const TOKEN = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'fixture-subject-plan', iat: nowS, exp: nowS + 86_400 })}.fixture-signature`
const ALIAS = 'kimi-for-coding'
const FAST = 'kimi-for-coding-highspeed'
const ALIAS_NAME = 'Kimi for Coding'
const FAST_NAME = 'Kimi For Coding Highspeed'
const K3 = 'k3'
const K3_NAME = 'K3'
const K3_256K_NAME = 'K3 256K'
const KIMI_LABEL = 'Kimi account (device-code sign-in · global (kimi.ai))'
const MOONSHOT_TITLE = 'MERCURY — MOONSHOT MODELS'
const OLD_LIST = { object: 'list', data: [
  { id: FAST, object: 'model', created: 200, owned_by: 'moonshot', context_length: 262_144 },
  { id: ALIAS, object: 'model', created: 100, owned_by: 'moonshot', context_length: 262_144, display_name: ALIAS_NAME },
] }
const PLAN_LIST = { object: 'list', data: [
  { id: FAST, object: 'model', created: 400, owned_by: 'moonshot', context_length: 262_144 },
  { id: ALIAS, object: 'model', created: 300, owned_by: 'moonshot', context_length: 262_144, display_name: ALIAS_NAME },
  { id: 'k3-256k', object: 'model', created: 200, owned_by: 'moonshot' },
  { id: K3, object: 'model', created: 100, owned_by: 'moonshot' },
] }
type Mode = { kind: 'list'; body: unknown } | { kind: 'hold' } | { kind: 'refuse'; status: number }
let mode: Mode = { kind: 'list', body: PLAN_LIST }
let requests = 0
let releaseHeld: (() => void) | null = null
const ledger = join(scratch, 'wire.jsonl')
writeFileSync(ledger, '')
const fixture = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  const isList = req.method === 'GET' && path === '/coding/v1/models'
  const authorized = req.headers.authorization === `Bearer ${TOKEN}`
  const answer = (status: number, body: unknown): void => {
    appendFileSync(ledger, JSON.stringify({ method: req.method, path, status, at: Date.now() }) + '\n')
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (!isList) return answer(404, { error: { message: `fixture: no route ${path}` } })
  if (!authorized) return answer(401, { error: { message: 'fixture refuses the credential' } })
  requests++
  const current = mode
  if (current.kind === 'refuse') return answer(current.status, { error: { message: 'fixture down' } })
  if (current.kind === 'list') return answer(200, current.body)
  releaseHeld = () => answer(200, PLAN_LIST)
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const address = fixture.address()
if (address === null || typeof address === 'string') throw new Error('fixture has no port')
const BASE = `http://127.0.0.1:${address.port}`
process.env.MERCURY_MOONSHOT_CODING_BASE = `${BASE}/coding/v1`
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.startsWith(BASE)) return realFetch(input as never, init)
  return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `fixture: no list at ${url}` } }), { status: 404, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

;(await import('../../src/utils/config.js')).enableConfigs()
const React = (await import('react')).default
const { render } = await import('../../src/ink.ts')
const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.tsx')
const { createStore } = await import('../../src/state/store.ts')
const { call } = await import('../../src/commands/model/mercuryModel.tsx')
const accounts = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
const catalogue = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')

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
const record = (words: string): void => console.log(`  [record] ${words}`)
const flush = (ms = 50): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!ok() && Date.now() < deadline) await flush(25)
  return ok()
}
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const linesOf = (frame: string): string[] => frame.split('\n')
const hasRow = (frame: string, name: string): boolean => linesOf(frame).some(line => new RegExp(`│ (?:│ | {2})${escape(name)} {2,}[○●⦿] (?:current|switch|unavail|next)`).test(line))
const lineUnder = (frame: string, title: string): string => {
  const lines = linesOf(frame)
  const at = lines.findIndex(line => line.includes(title))
  if (at < 0) return ''
  const col = lines[at]!.indexOf(title)
  const right = lines[at + 1]!.indexOf('│', col)
  return (lines[at + 1] ?? '').slice(col, right > col ? right : undefined).trim()
}
const focusOf = (frame: string): string => {
  const card = linesOf(frame).find(line => line.includes('│ │ ')) ?? ''
  const inner = card.split('│ │ ')[1] ?? ''
  return inner.replace(/\s+[○●⦿] (?:current|switch|unavail|next|expand|gated)\b.*$/, '').replace(/\s*│.*$/, '').trim()
}
const noticeOf = (frame: string): string => linesOf(frame).map(line => line.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '').trim()).find(line => line.startsWith('Moonshot')) ?? ''
const MOONSHOT_NAMES = new Set([ALIAS_NAME, FAST_NAME, K3_NAME, K3_256K_NAME])
const onMoonshot = (name: string): boolean => name.startsWith('Moonshot — ') || MOONSHOT_NAMES.has(name)
const fits = (frame: string, columns: number, rows: number): boolean => linesOf(frame).length <= rows && linesOf(frame).every(line => stringWidth(line) <= columns)
const file = (name: string, frame: string): void => {
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), frame + '\n')
}
type Band = { columns: number; rows: number }
const BANDS: Band[] = [{ columns: 178, rows: 51 }, { columns: 80, rows: 21 }]
const tag = (band: Band): string => `${band.columns}x${band.rows}`

async function mount(model: string, band: Band) {
  const stdout = Object.assign(new PassThrough(), { columns: band.columns, rows: band.rows })
  stdout.resume()
  const input: string[] = []
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return input.shift() ?? null }, readableLength: 0, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } })
  const store = createStore({ ...getDefaultAppState(), mainLoopModel: model }, () => {})
  const picker = await call(() => {}, { messages: [] } as never, '')
  const instance = await render(React.createElement(AppStoreContext.Provider, { value: store }, picker), { stdout: stdout as never, stdin: stdin as never, patchConsole: false })
  const frame = (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, '')
  await until(() => /^\s*╰/.test(linesOf(frame()).at(-1) ?? '') && frame().includes('CHOOSE A MODEL'), 5000)
  await flush(100)
  const press = async (keys: string, expectChange = true): Promise<boolean> => {
    const before = frame()
    input.push(keys)
    stdin.emit('readable')
    await until(() => frame() !== before, expectChange ? 2000 : 150)
    await flush(40)
    return frame() !== before
  }
  const walkToMoonshot = async (): Promise<boolean> => {
    await press('\x1b[H', false)
    for (let step = 0; step < 90 && !onMoonshot(focusOf(frame())); step++) await press('\x1b[B')
    return onMoonshot(focusOf(frame()))
  }
  return { frame, press, walkToMoonshot, unmount: () => instance.unmount() }
}

const signIn = (): void => {
  accounts.writeMoonshotTokens({ accessToken: TOKEN, refreshToken: 'fixture-refresh-plan', accessTokenExpiresAtMs: Date.now() + 86_400_000 }, 'global')
  recordSignIn('moonshot', 'oauth')
}
const primeWith = async (body: unknown): Promise<void> => {
  catalogue.__resetMoonshotCatalogueForTest()
  mode = { kind: 'list', body }
  const snapshot = await catalogue.refreshMoonshotCatalogue({ force: true })
  if (snapshot === null || snapshot.fetchedAtMs === 0) throw new Error(`the priming read did not land: ${JSON.stringify(snapshot)}`)
}
const failedRead = async (): Promise<void> => {
  catalogue.__resetMoonshotCatalogueForTest()
  mode = { kind: 'refuse', status: 503 }
  const snapshot = await catalogue.refreshMoonshotCatalogue({ force: true })
  if (snapshot === null || snapshot.fetchedAtMs !== 0 || snapshot.lastError === undefined) throw new Error(`the failing read did not fail: ${JSON.stringify(snapshot)}`)
}

try {
  signIn()
  check('the fixture sign-in resolves as a Kimi account', accounts.resolveMoonshotAccount()?.kind === 'kimi-oauth' && accounts.resolveMoonshotAccount()?.label === KIMI_LABEL, JSON.stringify(accounts.resolveMoonshotAccount()))

  section('§1 a cold open with the list held: one request, the reading row, ↵ joins the read and keeps its own notice')
  {
    catalogue.__resetMoonshotCatalogueForTest()
    mode = { kind: 'hold' }
    const before = requests
    const cold = await mount(ALIAS, BANDS[0]!)
    await until(() => requests > before, 2000)
    check('a cold open starts exactly one list request (whatever asked, one wire)', requests === before + 1, `requests ${requests - before}`)
    check('the frame fits 178x51', fits(cold.frame(), 178, 51))
    const reached = await cold.walkToMoonshot()
    check('the cursor reaches the Moonshot block, on the reading row while the list is in flight', reached && focusOf(cold.frame()) === 'Moonshot — reading model list…', focusOf(cold.frame()))
    file('held-178x51-reading', cold.frame())
    await cold.press('\r')
    await until(() => noticeOf(cold.frame()).includes('reading the model list'), 2000)
    check('↵ on the reading row says it is reading the account list, and adds no second request (single flight)', noticeOf(cold.frame()).includes('Moonshot — reading the model list of the Kimi account') && requests === before + 1, `${noticeOf(cold.frame())} · requests ${requests - before}`)
    releaseHeld?.()
    releaseHeld = null
    await until(() => hasRow(cold.frame(), K3_NAME) && noticeOf(cold.frame()).includes('landed'), 3000)
    check('the released list lands in place: the plan rows paint and the ↵ notice counts them', hasRow(cold.frame(), K3_NAME) && hasRow(cold.frame(), K3_256K_NAME) && noticeOf(cold.frame()).includes('Moonshot model list landed: 4 model(s)'), `${noticeOf(cold.frame())} · rows ${[K3_NAME, K3_256K_NAME, ALIAS_NAME, FAST_NAME].filter(name => hasRow(cold.frame(), name)).join(',')}`)
    file('held-178x51-landed', cold.frame())
    cold.unmount()
  }

  for (const band of BANDS) {
    section(`§2 ${tag(band)} the list changed since it was last read: the open re-reads it the way every other family's open does`)
    await primeWith(OLD_LIST)
    mode = { kind: 'list', body: PLAN_LIST }
    const before = requests
    const stale = await mount(ALIAS, band)
    await until(() => hasRow(stale.frame(), K3_NAME), 1500)
    const frame = stale.frame()
    file(`stale-${tag(band)}-open`, frame)
    record(`${tag(band)} stale open · under the title "${lineUnder(frame, MOONSHOT_TITLE)}" · rows ${[K3_NAME, K3_256K_NAME, ALIAS_NAME, FAST_NAME].filter(name => hasRow(frame, name)).join(',') || 'none'} · notice "${noticeOf(frame)}" · requests on open ${requests - before}`)
    check(`${tag(band)}: the open makes one list request although a list is cached (the other families' open law)`, requests === before + 1, `requests ${requests - before}`)
    const planRows = [K3_NAME, K3_256K_NAME].filter(name => hasRow(frame, name))
    check(`${tag(band)}: the Moonshot block is live on open: the plan's K3 rows paint around the current row, the retired list does not stand`, planRows.length >= (band.rows >= 40 ? 2 : 1) && hasRow(frame, ALIAS_NAME), `rows ${[K3_NAME, K3_256K_NAME, ALIAS_NAME, FAST_NAME].filter(name => hasRow(frame, name)).join(',') || 'none'}`)
    check(`${tag(band)}: the group line carries the live count beside the sign-in words`, lineUnder(frame, MOONSHOT_TITLE) === 'signed in · 4 models live', lineUnder(frame, MOONSHOT_TITLE))
    check(`${tag(band)}: the changed list paints the family's existing notice`, noticeOf(frame) === 'Moonshot — the live list changed; rows updated', noticeOf(frame))
    check(`${tag(band)}: the current mark stays on ${ALIAS} and the frame fits`, frame.includes(`${ALIAS} · model IDs`) && fits(frame, band.columns, band.rows), linesOf(frame).filter(line => line.includes('model IDs')).join(' | '))
    stale.unmount()
  }

  for (const band of BANDS) {
    section(`§3 ${tag(band)} the last read failed moments ago: the open reads again instead of waiting for ↵`)
    await failedRead()
    mode = { kind: 'list', body: PLAN_LIST }
    const before = requests
    const unread = await mount(ALIAS, band)
    await until(() => hasRow(unread.frame(), K3_NAME), 1500)
    const openRequests = requests - before
    const reached = await unread.walkToMoonshot()
    const frame = unread.frame()
    file(`unread-${tag(band)}-open`, frame)
    record(`${tag(band)} unread open · focus "${focusOf(frame)}" · under the title "${lineUnder(frame, MOONSHOT_TITLE)}" · notice "${noticeOf(frame)}" · requests on open ${openRequests}`)
    check(`${tag(band)}: the cursor reaches the Moonshot block`, reached, focusOf(frame))
    check(`${tag(band)}: the open reads the list although the last read failed (no wait for ↵)`, openRequests === 1, `requests ${openRequests}`)
    check(`${tag(band)}: the block is live on open, not the unavailable row`, hasRow(frame, K3_NAME) && !focusOf(frame).startsWith('Moonshot — '), focusOf(frame))
    check(`${tag(band)}: the group line reads signed in with the live count`, lineUnder(frame, MOONSHOT_TITLE) === 'signed in · 4 models live', lineUnder(frame, MOONSHOT_TITLE))
    check(`${tag(band)}: the frame fits`, fits(frame, band.columns, band.rows))
    if (focusOf(frame).startsWith('Moonshot — ')) {
      const gated = linesOf(frame).find(line => line.includes('not selectable') || line.includes('model list unavailable')) ?? ''
      record(`${tag(band)} the row under the cursor: "${focusOf(frame)}" · ${gated.trim()}`)
      await unread.press('\r')
      await until(() => hasRow(unread.frame(), K3_NAME) && noticeOf(unread.frame()).includes('landed'), 3000)
      const after = unread.frame()
      file(`unread-${tag(band)}-after-enter`, after)
      record(`${tag(band)} after ↵ · under the title "${lineUnder(after, MOONSHOT_TITLE)}" · rows ${[K3_NAME, K3_256K_NAME, ALIAS_NAME, FAST_NAME].filter(name => hasRow(after, name)).join(',') || 'none'} · notice "${noticeOf(after)}" · requests ${requests - before}`)
    }
    unread.unmount()
  }

  section('§4 the traffic switch and a signed-out account: no request on open, the honest row')
  {
    catalogue.__resetMoonshotCatalogueForTest()
    process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    const before = requests
    const dark = await mount(ALIAS, BANDS[0]!)
    await flush(300)
    const reached = await dark.walkToMoonshot()
    check('traffic off: the open sends nothing and the row says the switch is on', requests === before && reached && focusOf(dark.frame()) === 'Moonshot — list unavailable' && dark.frame().includes('catalogue traffic is off'), `requests ${requests - before} · focus "${focusOf(dark.frame())}"`)
    dark.unmount()
    delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
    accounts.writeMoonshotTokens(null)
    catalogue.__resetMoonshotCatalogueForTest()
    const out = await mount(ALIAS, BANDS[0]!)
    await flush(300)
    const found = await out.walkToMoonshot()
    check('signed out: the open sends nothing and the sign-in row leads the block', requests === before && found && focusOf(out.frame()).startsWith('Moonshot — sign in with Kimi'), `requests ${requests - before} · focus "${focusOf(out.frame())}"`)
    out.unmount()
  }

  section('§5 the seam, source-shaped: every picker in the /model surface opens the Moonshot road beside the other families')
  {
    const wrapper = readFileSync(join(import.meta.dir, '../../src/commands/model/mercuryModel.tsx'), 'utf8')
    const opens = (road: string): number => (wrapper.match(new RegExp(`useCatalogueRefreshOnOpen\\(${road}, setNotice\\)`, 'g')) ?? []).length
    check('the Moonshot road is opened wherever the OpenRouter road is', opens('MOONSHOT_ROAD') === opens('OPENROUTER_ROAD') && opens('MOONSHOT_ROAD') >= 1, `moonshot ${opens('MOONSHOT_ROAD')} · openrouter ${opens('OPENROUTER_ROAD')}`)
    check('the road reads the account-keyed cache and forces its refresh', wrapper.includes('cached: () => getCachedMoonshotCatalogue()') && wrapper.includes('refresh: () => refreshMoonshotCatalogue({ force: true })') && wrapper.includes('kimi-oauth:${kimiAccountKey(tokens)}:${kimiCodingBase(account.region)}'))
    check('the group line carries the live words the catalogue owner chose', wrapper.includes('moonshotCatalogueSourceWords()'))
  }
} finally {
  globalThis.fetch = realFetch
  fixture.closeAllConnections()
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (frameDir !== undefined) writeFileSync(join(frameDir, 'wire.jsonl'), readFileSync(ledger))
}
console.log(`\nprove-model-picker-refresh-moonshot: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}; worlds kept at ${scratch}`)
process.exit(failures === 0 ? 0 : 1)
