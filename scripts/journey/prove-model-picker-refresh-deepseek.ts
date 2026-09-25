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
const scratch = mkdtempSync(join(tmpdir(), 'model-refresh-deepseek-'))
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
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_ZAI_API_BASE',
  'MERCURY_MOONSHOT_OAUTH_BASE',
  'MERCURY_MOONSHOT_API_BASE',
  'MERCURY_MOONSHOT_CODING_BASE',
  'MERCURY_UPDATE_API_BASE_URL',
]) {
  process.env[base] = DEAD
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

const KEY = 'fixture-deepseek-key-not-a-real-key'
const PRO = 'deepseek-v4-pro'
const FLASH = 'deepseek-flash'
const NEXT = 'deepseek-fixture-next'
const PRO_NAME = 'DeepSeek V4 Pro'
const FLASH_NAME = 'DeepSeek V4.1 Flash'
const NEXT_NAME = 'Deepseek Fixture Next'
const DEEPSEEK_TITLE = 'MERCURY — DEEPSEEK MODELS'
const OLD_LIST = { object: 'list', data: [
  { id: PRO, object: 'model', owned_by: 'deepseek' },
  { id: FLASH, object: 'model', owned_by: 'deepseek' },
] }
const LIVE_LIST = { object: 'list', data: [
  { id: FLASH, object: 'model', owned_by: 'deepseek' },
  { id: PRO, object: 'model', owned_by: 'deepseek' },
  { id: NEXT, object: 'model', owned_by: 'deepseek' },
] }
type Mode = { kind: 'list'; body: unknown } | { kind: 'hold' } | { kind: 'refuse'; status: number }
let mode: Mode = { kind: 'list', body: LIVE_LIST }
let requests = 0
let releaseHeld: (() => void) | null = null
const ledger = join(scratch, 'wire.jsonl')
writeFileSync(ledger, '')
const fixture = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  const isList = req.method === 'GET' && path === '/models'
  const authorized = req.headers.authorization === `Bearer ${KEY}`
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
  releaseHeld = () => answer(200, LIVE_LIST)
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const address = fixture.address()
if (address === null || typeof address === 'string') throw new Error('fixture has no port')
const BASE = `http://127.0.0.1:${address.port}`
process.env.MERCURY_DEEPSEEK_API_BASE = BASE
process.env.DEEPSEEK_API_KEY = KEY
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
const accounts = await import('../../src/services/providers/deepseek/deepseekAccounts.ts')
const catalogue = await import('../../src/services/providers/deepseek/deepseekCatalogue.ts')

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
const ROW_MARK = /[○●⦿] (?:current|switch|unavail|next)/
const hasRow = (frame: string, name: string): boolean => linesOf(frame).some(line => new RegExp(`│ (?:│ | {2})${escape(name)} {2,}[○●⦿] (?:current|switch|unavail|next)`).test(line))
const rowsOf = (frame: string): string => [PRO_NAME, FLASH_NAME, NEXT_NAME].filter(name => hasRow(frame, name)).join(',') || 'none'
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
const noticeOf = (frame: string): string => linesOf(frame).map(line => line.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '').trim()).find(line => line.startsWith('DeepSeek — ') && !ROW_MARK.test(line)) ?? ''
const DEEPSEEK_NAMES = new Set([PRO_NAME, FLASH_NAME, NEXT_NAME])
const onDeepseek = (name: string): boolean => name.startsWith('DeepSeek — ') || DEEPSEEK_NAMES.has(name)
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
  const walkToDeepseek = async (): Promise<boolean> => {
    await press('\x1b[H', false)
    for (let step = 0; step < 90 && !onDeepseek(focusOf(frame())); step++) await press('\x1b[B')
    return onDeepseek(focusOf(frame()))
  }
  return { frame, press, walkToDeepseek, unmount: () => instance.unmount() }
}

const primeWith = async (body: unknown): Promise<void> => {
  catalogue.__resetDeepseekCatalogueForTest()
  mode = { kind: 'list', body }
  const snapshot = await catalogue.refreshDeepseekCatalogue({ force: true })
  if (snapshot === null || snapshot.fetchedAtMs === 0) throw new Error(`the priming read did not land: ${JSON.stringify(snapshot)}`)
}
const failedRead = async (): Promise<void> => {
  catalogue.__resetDeepseekCatalogueForTest()
  mode = { kind: 'refuse', status: 503 }
  const snapshot = await catalogue.refreshDeepseekCatalogue({ force: true })
  if (snapshot === null || snapshot.fetchedAtMs !== 0 || snapshot.lastError === undefined) throw new Error(`the failing read did not fail: ${JSON.stringify(snapshot)}`)
}

try {
  check('the fixture key resolves as a DeepSeek key from the environment', accounts.resolveDeepseekAccount()?.kind === 'api-key' && accounts.resolveDeepseekAccount()?.keySource === 'env', JSON.stringify(accounts.resolveDeepseekAccount()))

  section('§1 a cold open with the list held: one request, the dated pins stand in, the released list lands in place')
  {
    catalogue.__resetDeepseekCatalogueForTest()
    mode = { kind: 'hold' }
    const before = requests
    const cold = await mount(FLASH, BANDS[0]!)
    await until(() => requests > before, 2000)
    check('a cold open starts exactly one list request (whatever asked, one wire)', requests === before + 1, `requests ${requests - before}`)
    check('the frame fits 178x51', fits(cold.frame(), 178, 51))
    check('the dated pins stand in while the list is in flight, the current mark on the Flash row', hasRow(cold.frame(), PRO_NAME) && hasRow(cold.frame(), FLASH_NAME) && !hasRow(cold.frame(), NEXT_NAME) && cold.frame().includes(`${FLASH} · model IDs`), rowsOf(cold.frame()))
    record(`178x51 held open · under the title "${lineUnder(cold.frame(), DEEPSEEK_TITLE)}" · rows ${rowsOf(cold.frame())} · requests on open ${requests - before}`)
    file('held-178x51-pins', cold.frame())
    releaseHeld?.()
    releaseHeld = null
    await until(() => hasRow(cold.frame(), NEXT_NAME) && lineUnder(cold.frame(), DEEPSEEK_TITLE).includes('models live'), 3000)
    check('the released list lands in place: the live-only row paints after the pins', hasRow(cold.frame(), PRO_NAME) && hasRow(cold.frame(), FLASH_NAME) && hasRow(cold.frame(), NEXT_NAME), `rows ${rowsOf(cold.frame())}`)
    check('the group line carries the live count beside the key words once the list lands', lineUnder(cold.frame(), DEEPSEEK_TITLE) === 'key present · 3 models live', lineUnder(cold.frame(), DEEPSEEK_TITLE))
    check('a cold open sends nothing more once the list has landed', requests === before + 1, `requests ${requests - before}`)
    file('held-178x51-landed', cold.frame())
    cold.unmount()
  }

  for (const band of BANDS) {
    section(`§2 ${tag(band)} the list changed since it was last read: the open re-reads it the way every other family's open does`)
    await primeWith(OLD_LIST)
    mode = { kind: 'list', body: LIVE_LIST }
    const before = requests
    const stale = await mount(FLASH, band)
    await until(() => hasRow(stale.frame(), NEXT_NAME), 1500)
    const frame = stale.frame()
    file(`stale-${tag(band)}-open`, frame)
    record(`${tag(band)} stale open · under the title "${lineUnder(frame, DEEPSEEK_TITLE)}" · rows ${rowsOf(frame)} · notice "${noticeOf(frame)}" · requests on open ${requests - before}`)
    check(`${tag(band)}: the open makes one list request although a list is cached (the other families' open law)`, requests === before + 1, `requests ${requests - before}`)
    check(`${tag(band)}: the DeepSeek block is live on open: the live-only row paints beside the pins, the retired list does not stand`, hasRow(frame, NEXT_NAME) && hasRow(frame, FLASH_NAME), `rows ${rowsOf(frame)}`)
    check(`${tag(band)}: the group line carries the live count beside the key words`, lineUnder(frame, DEEPSEEK_TITLE) === 'key present · 3 models live', lineUnder(frame, DEEPSEEK_TITLE))
    check(`${tag(band)}: the changed list paints the family's existing notice`, noticeOf(frame) === 'DeepSeek — the live list changed; rows updated', noticeOf(frame))
    check(`${tag(band)}: the current mark stays on ${FLASH} and the frame fits`, frame.includes(`${FLASH} · model IDs`) && fits(frame, band.columns, band.rows), linesOf(frame).filter(line => line.includes('model IDs')).join(' | '))
    stale.unmount()
  }

  for (const band of BANDS) {
    section(`§3 ${tag(band)} the last read failed moments ago: the open reads again instead of waiting out the failure window`)
    await failedRead()
    mode = { kind: 'list', body: LIVE_LIST }
    const before = requests
    const failed = await mount(FLASH, band)
    await until(() => hasRow(failed.frame(), NEXT_NAME), 1500)
    const frame = failed.frame()
    file(`failed-${tag(band)}-open`, frame)
    record(`${tag(band)} failed-read open · under the title "${lineUnder(frame, DEEPSEEK_TITLE)}" · rows ${rowsOf(frame)} · notice "${noticeOf(frame)}" · requests on open ${requests - before}`)
    check(`${tag(band)}: the open reads the list although the last read failed (no wait for the retry window)`, requests === before + 1, `requests ${requests - before}`)
    check(`${tag(band)}: the block is live on open, not the pins alone`, hasRow(frame, NEXT_NAME) && hasRow(frame, FLASH_NAME), `rows ${rowsOf(frame)}`)
    check(`${tag(band)}: the group line reads the key words with the live count`, lineUnder(frame, DEEPSEEK_TITLE) === 'key present · 3 models live', lineUnder(frame, DEEPSEEK_TITLE))
    check(`${tag(band)}: the frame fits`, fits(frame, band.columns, band.rows))
    failed.unmount()
  }

  section('§4 the traffic switch and a missing key: no request on open, the honest rows')
  {
    catalogue.__resetDeepseekCatalogueForTest()
    process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    const before = requests
    const dark = await mount(FLASH, BANDS[0]!)
    await flush(300)
    const frame = dark.frame()
    check('traffic off: the open sends nothing, the dated pins stand and the group line carries no count', requests === before && hasRow(frame, PRO_NAME) && hasRow(frame, FLASH_NAME) && !hasRow(frame, NEXT_NAME) && lineUnder(frame, DEEPSEEK_TITLE) === 'key present', `requests ${requests - before} · rows ${rowsOf(frame)} · under the title "${lineUnder(frame, DEEPSEEK_TITLE)}"`)
    dark.unmount()
    delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
    delete process.env.DEEPSEEK_API_KEY
    catalogue.__resetDeepseekCatalogueForTest()
    const out = await mount(FLASH, BANDS[0]!)
    await flush(300)
    const found = await out.walkToDeepseek()
    check('no key: the open sends nothing and the attach row leads the block', requests === before && found && focusOf(out.frame()) === 'DeepSeek — attach a key', `requests ${requests - before} · focus "${focusOf(out.frame())}"`)
    out.unmount()
    process.env.DEEPSEEK_API_KEY = KEY
  }

  section('§5 the seam, source-shaped: every picker in the /model surface opens the DeepSeek road beside the other families')
  {
    const wrapper = readFileSync(join(import.meta.dir, '../../src/commands/model/mercuryModel.tsx'), 'utf8')
    const opens = (road: string): number => (wrapper.match(new RegExp(`useCatalogueRefreshOnOpen\\(${road}, setNotice\\)`, 'g')) ?? []).length
    check('the DeepSeek road is opened wherever the OpenRouter road is', opens('DEEPSEEK_ROAD') === opens('OPENROUTER_ROAD') && opens('DEEPSEEK_ROAD') >= 1, `deepseek ${opens('DEEPSEEK_ROAD')} · openrouter ${opens('OPENROUTER_ROAD')}`)
    check('the road reads the key-keyed cache and forces its refresh', wrapper.includes('cached: () => getCachedDeepseekCatalogue()') && wrapper.includes('refresh: () => refreshDeepseekCatalogue({ force: true })') && wrapper.includes('${key.source}:${credentialFingerprint(key.key)}:${deepseekApiBase()}'))
    check('the group line carries the live words the catalogue owner chose', wrapper.includes('deepseekCatalogueSourceWords()'))
  }
} finally {
  globalThis.fetch = realFetch
  fixture.closeAllConnections()
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (frameDir !== undefined) writeFileSync(join(frameDir, 'wire.jsonl'), readFileSync(ledger))
}
console.log(`\nprove-model-picker-refresh-deepseek: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}; worlds kept at ${scratch}`)
process.exit(failures === 0 ? 0 : 1)
