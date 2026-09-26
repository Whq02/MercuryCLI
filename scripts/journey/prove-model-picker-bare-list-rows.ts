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
const scratch = mkdtempSync(join(tmpdir(), 'model-bare-list-rows-'))
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
  'MERCURY_MOONSHOT_CODING_BASE',
  'MERCURY_UPDATE_API_BASE_URL',
]) {
  process.env[base] = DEAD
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const OPENAI_KEY = 'fixture-openai-key-not-a-real-key'
process.env.OPENAI_API_KEY = OPENAI_KEY

const MARKER = 'live · unknown to mercury'
const SOURCE = 'OpenAI API key (env)'
const OPENAI_TITLE = 'MERCURY — OPENAI MODELS'
const SOL = 'gpt-5.6-sol'
const TERRA = 'gpt-5.6-terra'
const NOVA = 'gpt-5.7-nova'
const KNOWN = [SOL, TERRA, NOVA]
const KNOWN_NAMES: Record<string, string> = { [SOL]: 'GPT-5.6 Sol', [TERRA]: 'GPT-5.6 Terra', [NOVA]: 'GPT-5.7 Nova' }
const BARE = ['whisper-1', 'tts-1', 'dall-e-3', 'text-embedding-3-large', 'omni-moderation-latest', 'babbage-002', 'gpt-image-1']
const UNSERVED = ['GPT-6 Astra', 'GPT-5.6 Luna', 'GPT-5.5']
const bareRow = (id: string): Record<string, unknown> => ({ id, object: 'model', created: 1_700_000_000, owned_by: 'system' })
const OPENAI_LIST = { object: 'list', data: [...KNOWN, ...BARE].map(bareRow) }
const MOONSHOT_LIST = { object: 'list', data: [
  { ...bareRow('nano-9'), created: 400, owned_by: 'moonshot' },
  { ...bareRow('kimi-for-coding'), created: 300, owned_by: 'moonshot', context_length: 262_144, display_name: 'Kimi for Coding' },
  { ...bareRow('k3'), created: 100, owned_by: 'moonshot' },
] }
const DEEPSEEK_LIST = { object: 'list', data: [bareRow('v4-flash'), bareRow('deepseek-v4-pro')] }
let requests = 0
const ledger = join(scratch, 'wire.jsonl')
writeFileSync(ledger, '')
const fixture = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname
  const answer = (status: number, body: unknown): void => {
    appendFileSync(ledger, JSON.stringify({ method: req.method, path, status, at: Date.now() }) + '\n')
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'GET') return answer(404, { error: { message: `fixture: no route ${req.method} ${path}` } })
  if (path === '/v1/models') {
    if (req.headers.authorization !== `Bearer ${OPENAI_KEY}`) return answer(401, { error: { message: 'fixture refuses the credential' } })
    requests++
    return answer(200, OPENAI_LIST)
  }
  if (path === '/moonshot/v1/models') return answer(200, MOONSHOT_LIST)
  if (path === '/deepseek/models') return answer(200, DEEPSEEK_LIST)
  return answer(404, { error: { message: `fixture: no route ${path}` } })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const address = fixture.address()
if (address === null || typeof address === 'string') throw new Error('fixture has no port')
const BASE = `http://127.0.0.1:${address.port}`
process.env.MERCURY_OPENAI_API_BASE = `${BASE}/v1`
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
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const moonshot = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const deepseek = await import('../../src/services/providers/deepseek/deepseekCatalogue.ts')
const options = await import('../../src/utils/model/modelOptions.ts')
const { getModelOptions, isProviderActionRow, OPENAI_MODEL_GROUP, MOONSHOT_MODEL_GROUP, DEEPSEEK_MODEL_GROUP, ZAI_MODEL_GROUP } = options

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
const ROW = /│ (?:│ | {2})(\S.*?) {2,}([○●⦿]) (current|switch|unavail|next|expand|gated)\b/
const rowNames = (frame: string): string[] => linesOf(frame).map(line => ROW.exec(line)?.[1] ?? '').filter(name => name !== '')
const hasRow = (frame: string, name: string): boolean => linesOf(frame).some(line => new RegExp(`│ (?:│ | {2})${escape(name)} {2,}[○●⦿] (?:current|switch|unavail|next)`).test(line))
const lineUnder = (frame: string, title: string): string => {
  const lines = linesOf(frame)
  const at = lines.findIndex(line => line.includes(title))
  if (at < 0) return ''
  const col = lines[at]!.indexOf(title)
  const right = lines[at + 1]!.indexOf('│', col)
  return (lines[at + 1] ?? '').slice(col, right > col ? right : undefined).trim()
}
const cardOf = (frame: string): string[] => linesOf(frame).filter(line => line.includes('│ │ ')).map(line => (line.split('│ │ ')[1] ?? '').replace(/\s*│ │\s*$/, '').trimEnd())
const focusOf = (frame: string): string => (cardOf(frame)[0] ?? '').replace(/\s+[○●⦿] (?:current|switch|unavail|next|expand|gated)\b.*$/, '').trim()
const cardWords = (frame: string): string => (cardOf(frame)[1] ?? '').trim()
const rowLine = (frame: string, name: string): string => linesOf(frame).find(line => new RegExp(`│ (?:│ | {2})${escape(name)} {2,}[○●⦿] (?:current|switch|unavail|next)`).test(line)) ?? ''
const ctxCell = (frame: string, name: string): string => rowLine(frame, name).replace(/^.*?[○●⦿] (?:current|switch|unavail|next)/, '').replace(/\s*│(?: │)?\s*$/, '').trim()
const glyphCol = (frame: string, name: string): number => rowLine(frame, name).search(/[○●⦿] (?:current|switch|unavail|next)/)
const availableOf = (frame: string): number => Number(/· (\d+) AVAILABLE/.exec(frame)?.[1] ?? -1)
const fits = (frame: string, columns: number, rows: number): boolean => linesOf(frame).length <= rows && linesOf(frame).every(line => stringWidth(line) <= columns)
const file = (name: string, frame: string): void => {
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), frame + '\n')
}
type Band = { columns: number; rows: number }
const BANDS: Band[] = [{ columns: 178, rows: 51 }, { columns: 80, rows: 21 }]
const tag = (band: Band): string => `${band.columns}x${band.rows}`
const openaiRows = () => getModelOptions().filter(o => o.group === OPENAI_MODEL_GROUP && !isProviderActionRow(o.value))
const liveOpenaiRows = () => openaiRows().filter(o => o.unavailable === undefined)

async function mount(model: string, band: Band) {
  const stdout = Object.assign(new PassThrough(), { columns: band.columns, rows: band.rows })
  stdout.resume()
  const input: string[] = []
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return input.shift() ?? null }, readableLength: 0, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } })
  const store = createStore({ ...getDefaultAppState(), mainLoopModel: model }, () => {})
  const done: string[] = []
  const picker = await call((result?: string) => { done.push(result ?? '') }, { messages: [] } as never, '')
  const instance = await render(React.createElement(AppStoreContext.Provider, { value: store }, picker), { stdout: stdout as never, stdin: stdin as never, patchConsole: false })
  const frame = (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, '')
  await until(() => /^\s*╰/.test(linesOf(frame()).at(-1) ?? '') && frame().includes('CHOOSE A MODEL'), 5000)
  await flush(150)
  const press = async (keys: string, expectChange = true): Promise<boolean> => {
    const before = frame()
    input.push(keys)
    stdin.emit('readable')
    await until(() => frame() !== before, expectChange ? 2000 : 150)
    await flush(40)
    return frame() !== before
  }
  return { frame, press, done, unmount: () => instance.unmount() }
}

const primeOpenai = async (): Promise<void> => {
  catalogue.__resetOpenaiCatalogueForTest()
  const snapshot = await catalogue.refreshOpenaiCatalogue('api-key', { force: true })
  if (snapshot === null || snapshot.models.length === 0 || snapshot.lastError !== undefined) throw new Error(`the priming read did not land: ${JSON.stringify(snapshot)}`)
}

try {
  section('§1 the composer: every id of the bare list is a selectable OpenAI row, the parsed rows first, the unknown ones marked')
  {
    await primeOpenai()
    const availability = catalogue.getGptSeatAvailability()
    check('the bare list qualifies every id: the seat is ready with ten ids, the three gpt ids first', availability.state === 'ready' && availability.ids.join(',') === [...KNOWN, ...BARE].join(','), JSON.stringify(availability))
    const rows = openaiRows()
    const live = liveOpenaiRows()
    record(`the OpenAI section: ${rows.map(row => `${row.value}${row.description === '' ? '' : ` [${row.description}]`}${row.unavailable === undefined ? '' : ' (unavailable)'}`).join(' · ')}`)
    check('nothing filtered: the seven bare ids are selectable rows, in the list\'s order, after the three gpt rows', live.map(row => row.value).join(',') === [...KNOWN, ...BARE].join(','), live.map(row => row.value).join(','))
    check('the unserved pins still trail as visible-but-unavailable rows', rows.slice(live.length).map(row => row.label).join(',') === UNSERVED.join(',') && rows.slice(live.length).every(row => row.unavailable !== undefined), rows.slice(live.length).map(row => row.label).join(','))
    const unknown = live.filter(row => BARE.includes(row.value))
    check(`each of the seven carries the marker "${MARKER}" as its words`, unknown.length === 7 && unknown.every(row => row.description === MARKER), unknown.map(row => `${row.value}:"${row.description}"`).join(' · '))
    check('each unknown row is named by its raw id and stays selectable', unknown.every(row => row.label === row.value && row.unavailable === undefined), unknown.map(row => `${row.value}:${row.label}`).join(','))
    check('each unknown row carries the typed live-unknown field and states no window (the bare list states none)', unknown.every(row => row.liveUnknown === true && row.statedContextWindow === undefined), unknown.map(row => `${row.value}:${String(row.liveUnknown)}/${String(row.statedContextWindow)}`).join(' · '))
    check('the model-facing description of an unknown row says it is listed live and unknown to the catalogue, never a GPT agent', unknown.every(row => (row.descriptionForModel ?? '').startsWith(`${row.value} (${row.value}) — listed live by the connected OpenAI API key`) && (row.descriptionForModel ?? '').includes("unknown to Mercury's catalogue") && !(row.descriptionForModel ?? '').includes('a GPT primary agent')), unknown[0]?.descriptionForModel)
    const known = live.filter(row => KNOWN.includes(row.value))
    check('a known bare id is unmarked: the pinned rows and the grammar-only row alike carry no words', known.length === 3 && known.every(row => row.description === '' && row.liveUnknown === undefined) && known.map(row => row.label).join(',') === KNOWN.map(id => KNOWN_NAMES[id]).join(','), known.map(row => `${row.value}:"${row.description}"`).join(' · '))
    check('the known rows keep their model-facing description', known.every(row => (row.descriptionForModel ?? '').includes('a GPT primary agent from the live catalogue')))
    check('the marker is the one exception to the neutral grammar: every other model row of every group stays wordless', getModelOptions().filter(o => !isProviderActionRow(o.value) && o.description !== '').every(o => o.description === MARKER && BARE.includes(o.value)), getModelOptions().filter(o => !isProviderActionRow(o.value) && o.description !== '' && o.description !== MARKER).map(o => `${o.value}:${o.description}`).join(' · '))
  }

  for (const band of BANDS) {
    section(`§2 ${tag(band)} the picker: the seven rows after the gpt rows, the heading counting them, the marker under the focused unknown row`)
    await primeOpenai()
    const before = requests
    const open = await mount('whisper-1', band)
    await until(() => requests > before, 2000)
    await flush(100)
    const frame = open.frame()
    file(`open-${tag(band)}-whisper`, frame)
    record(`${tag(band)} open · heading "${lineUnder(frame, OPENAI_TITLE)}" · rows ${rowNames(frame).join(',')} · card "${cardOf(frame).join(' / ')}" · cells whisper-1 "${ctxCell(frame, 'whisper-1')}" tts-1 "${ctxCell(frame, 'tts-1')}" ${KNOWN_NAMES[NOVA]} "${ctxCell(frame, KNOWN_NAMES[NOVA]!)}" · available ${availableOf(frame)}`)
    check(`${tag(band)}: the open reads the list once and the frame fits`, requests === before + 1 && fits(frame, band.columns, band.rows), `requests ${requests - before}`)
    check(`${tag(band)}: the heading counts every live id, the seven included`, lineUnder(frame, OPENAI_TITLE) === `${SOURCE} · signed in · 10 models live`, lineUnder(frame, OPENAI_TITLE))
    const painted = rowNames(frame)
    const order = [...KNOWN.map(id => KNOWN_NAMES[id]!), ...BARE, ...UNSERVED]
    const inOrder = band.rows >= 40
      ? painted.slice(0, order.length).join(',') === order.join(',')
      : painted.length >= 3 && painted.includes('whisper-1') && `,${order.join(',')},`.includes(`,${painted.slice(0, painted.findIndex(name => UNSERVED.includes(name)) < 0 ? painted.length : painted.findIndex(name => UNSERVED.includes(name)) + 1).join(',')},`)
    check(`${tag(band)}: the rows paint in provenance order after the gpt rows${band.rows >= 40 ? ' (all seven, then the unserved pins)' : ' (the window around the current row)'}`, inOrder, painted.join(','))
    check(`${tag(band)}: the current mark sits on whisper-1, a selectable row`, focusOf(frame) === 'whisper-1' && frame.includes('whisper-1 · model IDs are real') && hasRow(frame, 'whisper-1'), focusOf(frame))
    check(`${tag(band)}: the focused unknown row carries the marker as its words`, cardWords(frame) === MARKER, `card "${cardOf(frame).join(' / ')}"`)
    check(`${tag(band)}: the banner counts the seven as available`, availableOf(frame) === getModelOptions().filter(o => !isProviderActionRow(o.value) && o.unavailable === undefined).length, `${availableOf(frame)} vs ${getModelOptions().filter(o => !isProviderActionRow(o.value) && o.unavailable === undefined).length}`)
    check(`${tag(band)}: an unknown row's context cell is blank, focused or not — the resolver's borrowed default never paints`, ctxCell(frame, 'whisper-1') === '' && ctxCell(frame, 'tts-1') === '', `whisper-1 "${ctxCell(frame, 'whisper-1')}" · tts-1 "${ctxCell(frame, 'tts-1')}"`)
    check(`${tag(band)}: the known rows keep their column and the rows still align (one glyph column)`, ctxCell(frame, KNOWN_NAMES[NOVA]!) === '200k ctx' && glyphCol(frame, 'whisper-1') > 0 && glyphCol(frame, 'whisper-1') === glyphCol(frame, KNOWN_NAMES[NOVA]!) && glyphCol(frame, 'tts-1') === glyphCol(frame, KNOWN_NAMES[NOVA]!), `${KNOWN_NAMES[NOVA]} "${ctxCell(frame, KNOWN_NAMES[NOVA]!)}" · glyph columns ${glyphCol(frame, 'whisper-1')}/${glyphCol(frame, 'tts-1')}/${glyphCol(frame, KNOWN_NAMES[NOVA]!)}`)
    await open.press('\x1b[B')
    const next = open.frame()
    file(`walk-${tag(band)}-tts`, next)
    check(`${tag(band)}: the marker follows the cursor onto the next unknown row`, focusOf(next) === 'tts-1' && cardWords(next) === MARKER, `focus "${focusOf(next)}" · card "${cardOf(next).join(' / ')}"`)
    check(`${tag(band)}: the focused unknown row's cell stays blank on the walk`, ctxCell(next, 'tts-1') === '' && ctxCell(next, 'whisper-1') === '', `tts-1 "${ctxCell(next, 'tts-1')}" · whisper-1 "${ctxCell(next, 'whisper-1')}"`)
    await open.press('\x1b[A')
    await open.press('\x1b[A')
    const known = open.frame()
    file(`walk-${tag(band)}-nova`, known)
    check(`${tag(band)}: a known bare id carries no words under its card`, focusOf(known) === KNOWN_NAMES[NOVA] && cardWords(known) === '', `focus "${focusOf(known)}" · card "${cardOf(known).join(' / ')}"`)
    check(`${tag(band)}: a known bare id keeps its column when focused`, ctxCell(known, KNOWN_NAMES[NOVA]!) === '200k ctx', `${KNOWN_NAMES[NOVA]} "${ctxCell(known, KNOWN_NAMES[NOVA]!)}"`)
    check(`${tag(band)}: the walked frames fit`, fits(next, band.columns, band.rows) && fits(known, band.columns, band.rows))
    open.unmount()
  }

  section('§3 ↵ on an unknown row takes the road every row takes')
  {
    await primeOpenai()
    const settle = async (steps: number, name: string): Promise<{ answer: string; frame: string }> => {
      const pick = await mount(SOL, BANDS[0]!)
      await flush(150)
      for (let step = 0; step < steps; step++) await pick.press('\x1b[B')
      check(`the cursor reaches ${name} from the current gpt row`, focusOf(pick.frame()) === name, focusOf(pick.frame()))
      await pick.press('\r', false)
      await until(() => pick.done.length > 0, 3000)
      const frame = pick.frame()
      pick.unmount()
      return { answer: pick.done[0] ?? '', frame }
    }
    const known = await settle(1, KNOWN_NAMES[TERRA]!)
    const unknown = await settle(3, 'whisper-1')
    record(`↵ on ${TERRA} settles "${known.answer}" · ↵ on whisper-1 settles "${unknown.answer}"`)
    check('↵ on the unknown row takes the very road a known row takes: the switch road answers both with one sentence, and the picker refuses neither as gated', unknown.answer !== '' && unknown.answer === known.answer && !unknown.frame.includes('not selectable') && !known.frame.includes('not selectable'), `known "${known.answer}" · unknown "${unknown.answer}"`)
  }

  section('§4 the key lanes: a live id the family\'s pins module cannot name is marked after the known rows; the Z.AI pins never are')
  {
    process.env.MERCURY_MOONSHOT_API_BASE = `${BASE}/moonshot/v1`
    process.env.MERCURY_DEEPSEEK_API_BASE = `${BASE}/deepseek`
    process.env.MOONSHOT_API_KEY = 'fixture-moonshot-key-not-a-real-key'
    process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-key-not-a-real-key'
    process.env.ZAI_API_KEY = 'fixture-zai-key-not-a-real-key'
    moonshot.__resetMoonshotCatalogueForTest()
    deepseek.__resetDeepseekCatalogueForTest()
    const kimi = await moonshot.refreshMoonshotCatalogue({ force: true })
    const seek = await deepseek.refreshDeepseekCatalogue({ force: true })
    check('both fixture lists land', kimi?.models.length === 3 && seek?.models.length === 2 && kimi.lastError === undefined && seek.lastError === undefined, JSON.stringify([kimi, seek]))
    const all = getModelOptions()
    const lane = (group: string) => all.filter(o => o.group === group && !isProviderActionRow(o.value))
    const kimiRows = lane(MOONSHOT_MODEL_GROUP)
    record(`Moonshot: ${kimiRows.map(row => `${row.value}${row.description === '' ? '' : ` [${row.description}]`}`).join(' · ')}`)
    check('Moonshot: the plan pin and the kimi- id are known and unmarked, the foreign id is marked and trails them', kimiRows.map(row => row.value).join(',') === 'k3,kimi-for-coding,nano-9' && kimiRows.slice(0, 2).every(row => row.description === '') && kimiRows[2]?.description === MARKER && kimiRows.every(row => row.unavailable === undefined), kimiRows.map(row => `${row.value}:"${row.description}"`).join(' · '))
    check('Moonshot: the marked row says it is listed live and unknown to the catalogue', (kimiRows[2]?.descriptionForModel ?? '').includes('listed live by the Moonshot account') && (kimiRows[2]?.descriptionForModel ?? '').includes("unknown to Mercury's catalogue"), kimiRows[2]?.descriptionForModel)
    const seekRows = lane(DEEPSEEK_MODEL_GROUP)
    record(`DeepSeek: ${seekRows.map(row => `${row.value}${row.description === '' ? '' : ` [${row.description}]`}`).join(' · ')}`)
    check('DeepSeek: the pinned id is unmarked, the unpinned live id is marked and trails it', seekRows.map(row => row.value).join(',') === 'deepseek-v4-pro,v4-flash' && seekRows[0]?.description === '' && seekRows[1]?.description === MARKER && seekRows.every(row => row.unavailable === undefined), seekRows.map(row => `${row.value}:"${row.description}"`).join(' · '))
    check('the counts the headings read count the marked rows too', moonshot.moonshotCatalogueSourceWords() === '3 models live' && deepseek.deepseekCatalogueSourceWords() === '2 models live', `${moonshot.moonshotCatalogueSourceWords()} · ${deepseek.deepseekCatalogueSourceWords()}`)
    check('the marked key-lane rows carry the typed live-unknown field; a window rides the typed field only where the list or a pin states one', kimiRows[2]?.liveUnknown === true && seekRows[1]?.liveUnknown === true && kimiRows[2]?.statedContextWindow === undefined && seekRows[1]?.statedContextWindow === undefined && kimiRows[0]?.liveUnknown === undefined && kimiRows[0]?.statedContextWindow === 1_048_576 && kimiRows[1]?.statedContextWindow === 262_144 && seekRows[0]?.statedContextWindow === 1_000_000, [...kimiRows, ...seekRows].map(row => `${row.value}:${String(row.liveUnknown)}/${String(row.statedContextWindow)}`).join(' · '))
    check('Z.AI: dated pins, no live list, nothing marked', lane(ZAI_MODEL_GROUP).length > 0 && lane(ZAI_MODEL_GROUP).every(row => row.description === ''))
    for (const key of ['MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY']) delete process.env[key]
    process.env.MERCURY_MOONSHOT_API_BASE = DEAD
    process.env.MERCURY_DEEPSEEK_API_BASE = DEAD
    moonshot.__resetMoonshotCatalogueForTest()
    deepseek.__resetDeepseekCatalogueForTest()
  }

  section('§5 the seams, source-shaped')
  {
    const src = (rel: string): string => readFileSync(join(import.meta.dir, '../../src', rel), 'utf8')
    const composer = src('utils/model/modelOptions.ts')
    check('the composer exports the marker by its exact words', composer.includes("export const LIVE_UNKNOWN_ROW_WORDS = 'live · unknown to mercury'"))
    const gpt = composer.slice(composer.indexOf('function getQualifiedGptOptions'), composer.indexOf('export interface KeyLanePin'))
    check('the OpenAI rows mark an unparsed candidate by its typed identity and filter nothing', gpt.includes('candidate.identity.unparsed === true') && gpt.includes('LIVE_UNKNOWN_ROW_WORDS') && !/startsWith\('gpt|\/\^gpt|parseGptModelId|\.filter\(/.test(gpt))
    const lanes = composer.slice(composer.indexOf('export function keyLaneGroupRows'), composer.indexOf('export function keyLaneProviderRows'))
    check('the key-lane rows lead with the pins the module names and trail the live-only ids, marked', lanes.includes('LIVE_UNKNOWN_ROW_WORDS') && lanes.includes('liveUnknown') && !/isDeepseekModelId|isKimiModelId|startsWith\('/.test(lanes))
    const wrapper = src('commands/model/mercuryModel.tsx')
    check('the OpenAI heading counts the seat\'s live ids', /gptAvailability\.ids\.length === 1 \? 'model' : 'models'\} live/.test(wrapper))
    check('the row shape carries the typed live-unknown field, set beside the words by both composers', composer.includes('liveUnknown?: boolean\n}\n\nexport const LIVE_UNKNOWN_ROW_WORDS') && (composer.match(/\.\.\.\((?:liveUnknown|pin\.liveUnknown === true) \? \{ liveUnknown: true \} : \{\}\)/g) ?? []).length === 2)
    const mapping = wrapper.slice(wrapper.indexOf('function modelChoiceOf'), wrapper.indexOf('function expandRowsOf'))
    check("the row mapping paints an unknown row's stated window or nothing, on the carrier rows' road — it never asks the window resolver for one", mapping.includes('if (opt.liveUnknown === true || opt.statedContextWindow !== undefined || qualifiedIdSpaceOf(opt.value)?.qualifiedPrefix !== undefined) {') && mapping.includes('opt.liveUnknown === true') && mapping.includes('getContextWindowForModel(') && mapping.indexOf('opt.liveUnknown === true') < mapping.indexOf('getContextWindowForModel('))
  }
} finally {
  globalThis.fetch = realFetch
  fixture.closeAllConnections()
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (frameDir !== undefined) writeFileSync(join(frameDir, 'wire.jsonl'), readFileSync(ledger))
}
console.log(`\nprove-model-picker-bare-list-rows: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}; worlds kept at ${scratch}`)
process.exit(failures === 0 ? 0 : 1)
