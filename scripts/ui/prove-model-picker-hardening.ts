#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { mountOffscreen, settle as sleep, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'picker-hardening-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN',
  'MERCURY_CUSTOM_MODEL_OPTION', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'NODE_ENV',
]) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

const React = (await import('react')).default
const { Box, render, flushPendingSyncWork, EventEmitter, InputEvent } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.js')
const { escapeFromOutsidePress } = await import('../../src/ink/recessLayer.js')
const { ModalContext } = await import('../../src/context/modalContext.js')
const pure = await import('../../src/utils/model/modelPickerGroups.js')
const ledger = await import('../../src/utils/model/modelUseLedger.js')
type ModelChoice = import('../../src/components/MercuryModelPicker.js').ModelChoice

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const ANTHROPIC = 'Mercury — Anthropic models'
const OPENAI = 'Mercury — OpenAI models'
const OPENROUTER = 'Mercury — OpenRouter models'
const GEMINI = 'Mercury — Gemini models'
const HF = 'Mercury — Hugging Face models'
const LOGIN = 'Claude Max login'
const KEY = 'API key'
const EMAIL40 = 'a-forty-character-email-address@example.com'
const ALIAS40 = 'A Forty Character Alias Name For A Model'
const ID60 = 'vendor-with-a-long-name/a-sixty-character-model-identifier-x'
const NEMOTRON = 'nvidia/nemotron-3-ultra:free'
const ODD_ID = 'x/y·z│w'
const row = (id: string, name: string, ctx: string, group: string, extra: Partial<ModelChoice> = {}): ModelChoice => ({ id, name, tag: '', ctx, group, ...extra })
const anthropic: ModelChoice[] = [
  row('claude-fable-5-1', 'Fable 5.1', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row('claude-opus-5-5', 'Opus 5.5', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row('claude-fable-5-2-preview', 'claude-fable-5-2-preview', '1M ctx', ANTHROPIC, { door: LOGIN, tag: 'live · unknown to mercury' }),
  row('claude-opus-5-5', 'Opus 5.5', '1M ctx', ANTHROPIC, { door: KEY }),
]
const openrouterListed: ModelChoice[] = [
  row(NEMOTRON, NEMOTRON, '1M ctx', OPENROUTER),
  row(ID60, ID60, '1.31M ctx', OPENROUTER),
  row('z-ai/glm-5.3-flash', ALIAS40, '1.31M ctx', OPENROUTER),
  row(ODD_ID, ODD_ID, '128k ctx', OPENROUTER),
  row('gated/one', 'GLM (5.3) Vision*', '64k ctx', OPENROUTER, { gated: true, gatedReason: 'not offered on this key' }),
]
const OPENROUTER_TOTAL = 30
const openrouterDoor: ModelChoice = { id: '__mercury_openrouter_expand__', name: `OpenRouter — ${OPENROUTER_TOTAL} models live`, tag: '', ctx: '', group: OPENROUTER, action: true, expand: { group: OPENROUTER, family: 'OpenRouter', total: OPENROUTER_TOTAL } }
const openrouterFull: ModelChoice[] = [...openrouterListed, ...Array.from({ length: OPENROUTER_TOTAL - openrouterListed.length }, (_, k) => row(`vendor-${k}/model.${k}`, `Vendor ${k}`, '128k ctx', OPENROUTER))]
const openai: ModelChoice[] = [row('gpt-6-astra', 'GPT-6 Astra', '872k ctx', OPENAI), { id: '__gpt_connect__', name: 'Sign in to ChatGPT', tag: 'runs /logins', ctx: '', group: OPENAI, action: true }]
const gemini: ModelChoice[] = Array.from({ length: 14 }, (_, k) => row(`gemini-3.${k}-pro`, `Gemini 3.${k} Pro`, '1M ctx', GEMINI))
const hfDoor: ModelChoice = { id: '__mercury_huggingface_expand__', name: 'Hugging Face — 3 models live', tag: '', ctx: '', group: HF, action: true, expand: { group: HF, family: 'Hugging Face', total: 3 } }
const hfFull: ModelChoice[] = Array.from({ length: 3 }, (_, k) => row(`huggingface/org/model-${k}`, `HF ${k}`, '32k ctx', HF))
const INHERIT: ModelChoice = { id: 'inherit', name: 'Inherit', tag: "the parent's model", ctx: '', group: 'Sub-agent', choice: "a choice, not a model — the spawned agent runs its parent's model" }
const headings = {
  [ANTHROPIC]: { name: 'ANTHROPIC', doors: [{ door: LOGIN, account: EMAIL40, active: true }, { door: KEY, account: '…6f2a' }] },
  [OPENROUTER]: { name: 'OPENROUTER', doors: [{ door: 'OAuth key', account: '…9c1d', active: true }] },
  [OPENAI]: { name: 'OPENAI', doors: [{ door: 'ChatGPT Pro login', account: EMAIL40, active: true }] },
  [GEMINI]: { name: 'GEMINI', doors: [{ door: 'Google account', account: EMAIL40, active: true }] },
  [HF]: { name: 'HUGGING FACE', doors: [{ door: 'token', account: '…aa11', active: true }], note: 'unverified' },
}
const estate: ModelChoice[] = [...anthropic, ...openrouterListed, openrouterDoor, ...openai, ...gemini, hfDoor]
const expandRows = (group: string): ModelChoice[] => (group === OPENROUTER ? openrouterFull : group === HF ? hfFull : [])
const REACH = estate.filter(m => pure.isModelRow(m)).length - openrouterListed.length + openrouterFull.length + hfFull.length

type Mount = { models: ModelChoice[]; current: string; top?: string; columns: number; height: number; pendingNext?: string; withHeadings?: boolean }
const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
async function mount(opts: Mount) {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: opts.columns, rows: opts.height }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const selected: Array<[string, string | undefined]> = []
  let closed = 0
  const node = React.createElement(
    StdinContext.Provider,
    { value: context },
    React.createElement(Box, { flexDirection: 'column' }, React.createElement(MercuryModelPicker, {
      models: opts.models,
      current: opts.current,
      ctxPct: 22,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'supercode'],
      effort: 'max',
      ...(opts.withHeadings === false ? {} : { headings }),
      ...(opts.top !== undefined ? { topGroup: opts.top } : {}),
      ...(opts.pendingNext !== undefined ? { pendingNext: opts.pendingNext } : {}),
      expandRows,
      onSelect: (id: string, door?: string) => { selected.push([id, door]) },
      onClose: () => { closed++ },
    } as never)),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  return {
    selected,
    closed: () => closed,
    frame: (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    lines: (): string[] => stripAnsi(instance.lastFrame()).replace(/\n$/, '').split('\n'),
    async key(name: string, sequence = '', pasted = false): Promise<boolean> {
      const event = new InputEvent({ name, sequence, ctrl: false, shift: false, fn: false, meta: false, option: false, super: false, isPasted: pasted } as never)
      emitter.emit('input', event)
      await settle()
      return event.didStopImmediatePropagation()
    },
    async type(text: string): Promise<void> {
      for (const ch of text) await this.key(ch, ch)
    },
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}
const inner = (line: string): string => line.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '').replace(/^│ /, '')
const lineWith = (lines: string[], needle: string): string => lines.find(line => line.includes(needle)) ?? ''
const cursorLine = (lines: string[]): string => inner(lines.find(line => line.includes('│ │ ') || line.includes('❯ ')) ?? '').trim()
const title = (lines: string[]): string => inner(lineWith(lines, 'Mercury · model')).trim()
const cells = (line: string): string[] => inner(line).replace(/^│ /, '').trim().split(/\s{2,}/)
const save = (name: string, columns: number, rows: number, frame: string): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}-${columns}x${rows}.txt`), frame + '\n')
}

function auditBox(label: string, lines: string[], columns: number): string[] {
  const problems: string[] = []
  const at = lines.findIndex(l => l.includes('Mercury · model'))
  if (at < 0) return [`${label}: no title line`]
  const left = lines[at]!.indexOf('│')
  const right = lines[at]!.lastIndexOf('│')
  const top = lines.findIndex(l => l.indexOf('╭') === left)
  const bottom = lines.findIndex((l, k) => k > top && l.indexOf('╰') === left)
  if (top < 0 || bottom < 0) problems.push(`${label}: the box has no top or bottom border`)
  lines.forEach((l, k) => {
    const chars = [...l]
    if (chars.length > columns) problems.push(`${label}: line ${k} is wider than the terminal`)
    if (k <= top || k >= bottom) return
    if (chars[left] !== '│' || chars[right] !== '│') problems.push(`${label}: line ${k} breaks the border: ${l.trim()}`)
    if (chars.slice(right + 1).join('').trim() !== '') problems.push(`${label}: line ${k} spills past the right border`)
  })
  return problems
}

section('§1 overflow: every size the brief names, the longest live ids, the cursor on every line kind — the border holds, a cut cell ends with the ellipsis, the tail never wraps')
for (const [columns, height] of [[80, 24], [100, 30], [120, 40], [178, 51], [200, 60], [269, 70], [22, 24]] as Array<[number, number]>) {
  const board = await mount({ models: estate, current: 'claude-fable-5-1', top: ANTHROPIC, columns, height })
  const problems: string[] = []
  let stops = 0
  const kinds = new Set<string>()
  for (let step = 0; step < 40; step++) {
    const lines = board.lines()
    problems.push(...auditBox(`${columns}x${height} step ${step}`, lines, columns))
    const on = cursorLine(lines)
    kinds.add(on.startsWith('❯ ') ? 'heading' : 'row')
    stops++
    if (step === 0) save('hardening-home', columns, height, board.frame())
    const before = board.frame()
    if (lines.some(l => l.includes('❯ OPENROUTER') || l.includes('❯ HUGGING FACE'))) await board.key('right')
    await board.key('down')
    if (board.frame() === before) break
  }
  await board.key('/', '/')
  await board.type('a-filter-longer-than-any-panel-1234567890-abcdefghijklmnopqrstuvwxyz-0123456789-abcdefghijklmnopqrstuvwxyz')
  problems.push(...auditBox(`${columns}x${height} long filter`, board.lines(), columns))
  await board.key('escape')
  check(`${columns}x${height}: ${stops} cursor stops (${[...kinds].join('+')}) and a long filter — nothing crosses the box border`, problems.length === 0, problems.slice(0, 3).join(' | '))
  const lines = board.lines()
  const nemotron = lineWith(lines, NEMOTRON.slice(0, 12))
  const tails = lines.filter(l => l.includes('new · no'))
  if (columns >= 60) check(`${columns}x${height}: the tail column reads "new · no alias" whole or ends with the ellipsis, never wraps`, tails.length > 0 && tails.every(l => /new · no alias|new · no…|new · no …/.test(l)) && !lines.some(l => /^\s*│\s+alias\s*│/.test(l)), tails.map(inner).join(' | '))
  else check(`${columns}x${height}: at the floor every model row is one line cut with the ellipsis`, lines.filter(l => /│ (?:│ | {2})(?:❯ )?[A-Za-z—]/.test(l) && !/[▾▸❯] [A-Z]/.test(l) && !/ · |╭|╰|context|effort|filter by|↑↓/.test(l)).every(l => l.includes('…')), lines.slice(3, 8).map(inner).join(' | '))
  if (columns >= 100) check(`${columns}x${height}: the longest OpenRouter id stands whole with its ctx`, /nvidia\/nemotron-3-ultra:free\s{2,}1M ctx/.test(nemotron), inner(nemotron))
  const sixty = lineWith(lines, 'vendor-with-a-lo')
  check(`${columns}x${height}: the sixty-character id is cut with the ellipsis and its 1.31M ctx cell stands`, columns < 60 || (sixty.includes('…') && (columns < 100 || sixty.includes('1.31M ctx'))), inner(sixty))
  const odd = lineWith(lines, 'x/y·z')
  check(`${columns}x${height}: an id holding · and │ paints in its cell without breaking the row`, columns < 60 || (odd !== '' && auditBox('odd', [lines[0]!, ...lines.slice(1)], columns).length === 0), inner(odd))
  board.close()
}

section('§2 the pointer: a click outside closes at once even with the filter open, a click on a row selects then activates, on a heading folds, on the filter line focuses it')
{
  const COLS = 178
  const ROWS = 51
  const selected: string[] = []
  let closed = 0
  const element = React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(MercuryModelPicker, {
    models: estate,
    current: 'claude-fable-5-1',
    ctxPct: 22,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'supercode'],
    effort: 'max',
    headings,
    topGroup: ANTHROPIC,
    expandRows,
    onSelect: (id: string) => { selected.push(id) },
    onClose: () => { closed++ },
  } as never))
  const m: Mounted = await mountOffscreen(element, COLS, ROWS)
  await waitFor(() => m.screen().includes('↑↓ select'), 4000)
  await sleep(120)
  const press = async (data: string, ms = 140): Promise<void> => { m.push(data); await sleep(ms) }
  const panelLeft = (): number => (m.lines().find(l => l.includes('Mercury · model')) ?? '').indexOf('│')
  const rowY = (needle: string): number => m.lines().findIndex(l => l.includes(needle))
  const click = async (x: number, y: number): Promise<void> => { await press(`\x1b[<0;${x + 1};${y + 1}M`); await press(`\x1b[<0;${x + 1};${y + 1}m`, 60) }
  check('the picker painted through the real input road', m.screen().includes('Mercury · model') && panelLeft() > 0, m.lines().slice(0, 3).join(' | '))
  await press('/')
  await press('opus', 200)
  check('the filter is open with text (the header counts the matches)', /Mercury · model · \d+ of \d+ match/.test(m.screen()), title(m.lines()))
  await click(2, 2)
  check('one click outside the panel closes the picker even with the filter open (the estate law of the config popup)', closed === 1, `closed ${closed} · title ${title(m.lines())}`)
  check('the outside-press flag is clear after the press', escapeFromOutsidePress() === false)
  m.unmount()
  await sleep(60)

  closed = 0
  selected.length = 0
  const n: Mounted = await mountOffscreen(element, COLS, ROWS)
  await waitFor(() => n.screen().includes('↑↓ select'), 4000)
  await sleep(120)
  const pressN = async (data: string, ms = 140): Promise<void> => { n.push(data); await sleep(ms) }
  const clickN = async (x: number, y: number): Promise<void> => { await pressN(`\x1b[<0;${x + 1};${y + 1}M`); await pressN(`\x1b[<0;${x + 1};${y + 1}m`, 60) }
  const leftN = (n.lines().find(l => l.includes('Mercury · model')) ?? '').indexOf('│')
  const opusY = n.lines().findIndex(l => l.includes('claude-opus-5-5'))
  await clickN(leftN + 6, opusY)
  check('a click on an unselected row moves the cursor box onto it', n.lines()[n.lines().findIndex(l => l.includes('claude-opus-5-5')) - 1]?.includes('╭') === true && selected.length === 0, cursorLine(n.lines()))
  await sleep(600)
  const opusY2 = n.lines().findIndex(l => l.includes('claude-opus-5-5'))
  await clickN(leftN + 6, opusY2)
  check('a second click on the selected row activates it (the same act as ↵)', selected.length === 1 && selected[0] === 'claude-opus-5-5', selected.join(','))
  const headingY = n.lines().findIndex(l => l.includes('OPENAI ·'))
  await clickN(leftN + 4, headingY)
  await sleep(600)
  await clickN(leftN + 4, n.lines().findIndex(l => l.includes('OPENAI ·')))
  check('two clicks on a heading select it then fold it (the files menu grammar)', n.lines().some(l => /[❯▸] OPENAI ·/.test(l)) && !n.screen().includes('gpt-6-astra'), lineWith(n.lines(), 'OPENAI'))
  const filterY = n.lines().findIndex(l => l.includes('filter by name or id'))
  await clickN(leftN + 4, filterY)
  check('a click on the filter line focuses it (the legend swaps to type to filter)', n.screen().includes('type to filter'), inner(lineWith(n.lines(), '↑↓ select')).trim())
  await pressN('astra', 200)
  check('typing after the click lands in the filter', n.screen().includes('/ astra') && /1 of \d+ match/.test(n.screen()), title(n.lines()))
  await clickN(2, 2)
  check('a click outside with the filter focused closes the picker in one press', closed === 1, `closed ${closed}`)
  n.unmount()
  await sleep(60)
}

section('§3 the filter: N of M counts the whole reach when groups drop, zero matches read 0 of M, a metacharacter is text, a paste lands whole, ⌫ on the empty filter stays')
{
  const board = await mount({ models: estate, current: 'claude-fable-5-1', top: ANTHROPIC, columns: 120, height: 40 })
  await board.key('/', '/')
  await board.type('zzz')
  check(`zero matches read 0 of ${REACH} match (the reach, not the groups still standing)`, title(board.lines()) === `Mercury · model · 0 of ${REACH} match`, title(board.lines()))
  check('zero matches leave no heading, no row, and ↵ selects nothing', !board.frame().includes('ANTHROPIC') && board.selected.length === 0)
  await board.key('return')
  check('↵ on zero matches selects nothing and keeps the picker', board.selected.length === 0 && board.closed() === 0)
  for (let k = 0; k < 3; k++) await board.key('backspace')
  await board.type('.')
  const dots = estate.filter(m => pure.isModelRow(m) && pure.matchesPickerFilter(m, '.')).length - openrouterListed.filter(m => pure.matchesPickerFilter(m, '.')).length + openrouterFull.filter(m => pure.matchesPickerFilter(m, '.')).length + hfFull.filter(m => pure.matchesPickerFilter(m, '.')).length
  check(`"." is a literal dot: ${dots} of ${REACH} match, the OPENAI group (no dot) drops and M still counts it`, title(board.lines()) === `Mercury · model · ${dots} of ${REACH} match` && !board.frame().includes('OPENAI ·'), title(board.lines()))
  await board.key('backspace')
  await board.type('(')
  check('"(" is text: the one alias holding it matches', title(board.lines()) === `Mercury · model · 1 of ${REACH} match` && board.frame().includes('GLM (5.3) Vision*'), title(board.lines()))
  await board.key('backspace')
  await board.type('*')
  check('"*" is text, not a wildcard', title(board.lines()) === `Mercury · model · 1 of ${REACH} match`, title(board.lines()))
  await board.key('backspace')
  const consumed = await board.key('backspace')
  check('⌫ on the empty filter is consumed and the filter stays focused', consumed && board.frame().includes('esc leaves the filter'), inner(lineWith(board.lines(), '↑↓ select')).trim())
  await board.key('gemini-3.1', 'gemini-3.1', true)
  check('a paste lands whole in the filter and narrows at once', board.frame().includes('/ gemini-3.1') && title(board.lines()) === `Mercury · model · 5 of ${REACH} match`, title(board.lines()))
  await board.key('escape')
  check('esc clears the paste and the picker stays with the cursor back on the current row', board.closed() === 0 && title(board.lines()) === 'Mercury · model' && cursorLine(board.lines()).includes('claude-fable-5-1'), cursorLine(board.lines()))
  await board.key('/', '/')
  await board.type('  OPUS  ')
  check('the needle is trimmed and case-blind', title(board.lines()) === `Mercury · model · 2 of ${REACH} match`, title(board.lines()))
  await board.key('escape')
  await board.key('escape')
  check('the second esc closes', board.closed() === 1)
  board.close()
}

section('§4 the two-door split: current and next sit on the row under the wire\'s door, never on both rows of one model')
{
  const board = await mount({ models: estate, current: 'claude-opus-5-5', top: ANTHROPIC, columns: 178, height: 51, pendingNext: 'claude-fable-5-1' })
  const lines = board.lines()
  const opusRows = lines.filter(l => l.includes('claude-opus-5-5'))
  check('the model both doors list paints two rows', opusRows.length === 2, opusRows.map(inner).join(' | '))
  const loginAt = lines.findIndex(l => l.includes(`${LOGIN} · ${EMAIL40}`))
  const keyAt = lines.findIndex(l => l.includes(`${KEY} · …6f2a`))
  const loginRow = lines.slice(loginAt, keyAt).find(l => l.includes('claude-opus-5-5')) ?? ''
  const keyRow = lines.slice(keyAt).find(l => l.includes('claude-opus-5-5')) ?? ''
  check('current marks the row under the active door only', /claude-opus-5-5\s{2,}current\s{2,}/.test(loginRow) && !/current/.test(keyRow), `${inner(loginRow).trim()} || ${inner(keyRow).trim()}`)
  check('the cursor lands on that row', lines[lines.indexOf(loginRow) - 1]?.includes('╭') === true)
  check('a queued next marks its one row and no other', lines.filter(l => /\s{2}next\s{2}/.test(l)).length === 1, lines.filter(l => l.includes('next')).map(inner).join(' | '))
  board.close()
}

section('§5 c never dies silent: a heading, a choice row and a sign-in row answer in the notice slot')
{
  const board = await mount({ models: [INHERIT, ...estate], current: 'inherit', top: 'Sub-agent', columns: 120, height: 40 })
  await board.key('c', 'c')
  check('c on a choice row speaks the choice', board.frame().includes("a choice, not a model — the spawned agent runs its parent's model"), board.lines().filter(l => l.includes('choice')).map(inner).join(' | '))
  await board.key('left')
  await board.key('c', 'c')
  check('c on a heading answers with the heading law', board.frame().includes('no context window on a provider heading · ↓ reaches its rows'), cursorLine(board.lines()))
  await board.key('/', '/')
  await board.type('sign in')
  await board.key('escape')
  while (!cursorLine(board.lines()).includes('Sign in to ChatGPT')) { const before = board.frame(); await board.key('down'); if (board.frame() === before) break }
  await board.key('c', 'c')
  check('c on a sign-in row says it is not a model', board.frame().includes('Sign in to ChatGPT · not a model · no context window'), cursorLine(board.lines()))
  board.close()
}

section('§6 a heading with no provider entry: a choice group reads its name alone; a provider with rows keeps N live')
{
  const board = await mount({ models: [INHERIT, ...estate], current: 'inherit', top: 'Sub-agent', columns: 120, height: 40, withHeadings: false })
  check('the choice group heading is its name, never "0 live"', inner(lineWith(board.lines(), 'SUB-AGENT')).trim() === '❯ SUB-AGENT' || inner(lineWith(board.lines(), 'SUB-AGENT')).trim() === '▾ SUB-AGENT', inner(lineWith(board.lines(), 'SUB-AGENT')).trim())
  check('a provider group without an entry still counts its live rows', inner(lineWith(board.lines(), 'ANTHROPIC')).trim() === '▾ ANTHROPIC · 3 live', inner(lineWith(board.lines(), 'ANTHROPIC')).trim())
  check('the pure words agree', pure.headingWords(undefined, 'Sub-agent', { live: 0 }) === 'SUB-AGENT' && pure.headingWords(undefined, 'Mercury — Gemini models', { live: 14 }) === 'GEMINI · 14 live' && pure.headingWords({ name: 'OPENROUTER', doors: [], reason: 'live catalogue not fetched yet — retry shortly' }, OPENROUTER, { live: 0 }) === 'OPENROUTER · live catalogue not fetched yet — retry shortly')
  const reachTotal = (pure as { pickerReachTotal?: (groups: unknown, fullRows: unknown) => number }).pickerReachTotal
  check('the reach total is the pure module\'s and counts every door\'s full list', reachTotal !== undefined && reachTotal(pure.groupPickerRows(estate), expandRows) === REACH, reachTotal === undefined ? 'no pickerReachTotal export' : String(reachTotal(pure.groupPickerRows(estate), expandRows)))
  board.close()
}

section('§7 the use ledger under the config home: absent, corrupt, another version, an empty file, bad rows, concurrent writers')
{
  const path = ledger.modelUseLedgerPath()
  check('the ledger lives under the config home, never the operator\'s', path.startsWith(home) && !path.includes(join(process.env.HOME ?? '~', '.mercury')), path)
  check('absent reads empty', JSON.stringify(ledger.readModelUseLedger()) === '{}')
  check('a write lands', await ledger.recordModelUse('anthropic', 'claude-fable-5-1', { door: LOGIN, now: () => 1000 }) && ledger.readModelUseLedger().anthropic?.at === 1000 && ledger.readModelUseLedger().anthropic?.door === LOGIN)
  writeFileSync(path, '{ not json')
  check('a corrupt file reads empty and never throws', JSON.stringify(ledger.readModelUseLedger()) === '{}')
  check('a write over a corrupt file still lands (the store quarantines the damaged copy)', await ledger.recordModelUse('openai', 'gpt-6-astra', { now: () => 2000 }) && ledger.readModelUseLedger().openai?.at === 2000)
  writeFileSync(path, JSON.stringify({ _v: 99, uses: { anthropic: { at: 5, model: 'x', extra: true }, BAD: { at: 1, model: 'y' }, openai: { at: 'no', model: 'z' }, zai: { at: 3, model: '' }, deepseek: { at: -1, model: 'q' } }, unknown: [1] }))
  const other = ledger.readModelUseLedger()
  check('another version reads its valid rows and drops the malformed ones', other.anthropic?.at === 5 && Object.keys(other).length === 1, JSON.stringify(other))
  check('a write over another version keeps its valid rows', await ledger.recordModelUse('moonshot', 'kimi-k3', { now: () => 7 }) && ledger.readModelUseLedger().anthropic?.at === 5 && ledger.readModelUseLedger().moonshot?.at === 7)
  writeFileSync(path, '')
  check('an empty file reads empty and accepts a write', JSON.stringify(ledger.readModelUseLedger()) === '{}' && await ledger.recordModelUse('gemini', 'gemini-3-pro', { now: () => 8 }))
  check('a family outside the ledger reads undefined for the order rule', ledger.readModelUseLedger().deepseek === undefined)
  check('a bad family name or an empty model is refused without a write', !(await ledger.recordModelUse('Not A Family', 'x')) && !(await ledger.recordModelUse('anthropic', '  ')))
  const races = await Promise.all([
    ledger.recordModelUse('anthropic', 'a', { now: () => 11 }),
    ledger.recordModelUse('openai', 'b', { now: () => 12 }),
    ledger.recordModelUse('openrouter', 'c', { now: () => 13 }),
    ledger.recordModelUse('anthropic', 'd', { now: () => 14 }),
  ])
  const after = ledger.readModelUseLedger()
  check('four concurrent writers all land and the latest use wins per family', races.every(Boolean) && after.anthropic?.model === 'd' && after.openai?.model === 'b' && after.openrouter?.model === 'c' && after.gemini?.at === 8, JSON.stringify(after))
  const ordered = pure.orderPickerGroups(pure.groupPickerRows(estate), { top: OPENAI, recentAt: group => ({ [OPENROUTER]: 13, [ANTHROPIC]: 14 } as Record<string, number>)[group] })
  check('the order rule: the seat first, then the ledger\'s most recent, the never-used in today\'s order', ordered.map(g => g.group).join(' > ') === [OPENAI, ANTHROPIC, OPENROUTER, GEMINI, HF].join(' > '), ordered.map(g => g.group).join(' > '))
}

section('§9 a host narrower than the terminal: the picker follows the host\'s columns (the config popup\'s doors, the crew wizard)')
{
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 120, rows: 40 }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = React.createElement(
    StdinContext.Provider,
    { value: context },
    React.createElement(ModalContext.Provider, { value: { rows: 30, columns: 90, scrollRef: null } }, React.createElement(Box, { flexDirection: 'column', width: 90 }, React.createElement(MercuryModelPicker, {
      models: [INHERIT, ...estate],
      current: 'inherit',
      ctxPct: null,
      headings,
      topGroup: 'Sub-agent',
      expandRows,
      onSelect: () => {},
      onClose: () => {},
    } as never))),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  const lines = stripAnsi(instance.lastFrame()).replace(/\n$/, '').split('\n')
  const widest = Math.max(...lines.map(line => [...line].length))
  check('inside a 90-column host on a 120-column terminal the picker paints no wider than the host (88 with the reserve), the title whole', widest <= 90 && lines.some(line => inner(line).trim() === 'Mercury · model') && auditBox('host', lines, 90).length === 0, `widest ${widest} · ${lines[1] ?? ''}`)
  check('the choice row leads inside the host and a provider heading follows', lines.some(line => inner(line).trim().startsWith('▾ SUB-AGENT') || inner(line).trim().startsWith('❯ SUB-AGENT')) && lines.some(line => line.includes('ANTHROPIC ·')))
  instance.unmount()
  instance.cleanup()
  stream.destroy()
}

section('§10 the floor tier: with the cursor deep in a group, the window keeps that group\'s heading on screen with the title')
{
  const deep: ModelChoice[] = ['claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-haiku-4-5'].map(id => (id === 'claude-opus-4-8'
    ? row(id, 'Opus 4.8', '', ANTHROPIC, { gated: true, gatedReason: 'not offered on this key — the live list names the newer generations only, sign in with a subscription to reach it', tag: 'a pinned generation the key does not serve; the row stays for the record and switches nowhere' })
    : row(id, id.replace('claude-', '').replace(/-/g, ' '), '1M ctx', ANTHROPIC)))
  const board = await mount({ models: [...deep, ...openai], current: 'claude-opus-4-8', top: ANTHROPIC, columns: 80, height: 22 })
  const lines = board.lines()
  const all = lines.join('\n')
  check('80x22: the box closes inside the terminal and the cut is named', lines.length <= 22 && lines.some(l => l.trimStart().startsWith('╰')) && /↓ \d+ more/.test(all), `${lines.length} lines`)
  check('80x22: the focused row is boxed and its heading stands above the window with the title', all.includes('Mercury · model') && /[▾▸❯] [A-Z.]+ · /.test(all) && lines.some(l => l.includes('│ │ ') && l.includes('claude-opus-4-8')), lines.slice(1, 6).map(inner).join(' | '))
  const headingAt = lines.findIndex(l => /[▾▸❯] ANTHROPIC · /.test(l))
  const aboveAt = lines.findIndex(l => l.includes('↑ ') && l.includes('more'))
  check('the pinned heading paints once, under the above-count line, ahead of the rows', headingAt >= 0 && lines.filter(l => /[▾▸❯] ANTHROPIC · /.test(l)).length === 1 && (aboveAt < 0 || aboveAt < headingAt), `heading ${headingAt} · above ${aboveAt}`)
  for (let step = 0; step < 12 && !cursorLine(board.lines()).startsWith('❯ '); step++) await board.key('up')
  check('walking up to the heading lands on it as the cursor stop (the pinned line is the same heading, never a second stop)', cursorLine(board.lines()).startsWith('❯ ANTHROPIC') && board.lines().filter(l => /[▾▸❯] ANTHROPIC · /.test(l)).length === 1, cursorLine(board.lines()))
  board.close()
}

section('§8 the seams in source')
{
  const picker = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'MercuryModelPicker.tsx'), 'utf8')
  const wrapper = readFileSync(join(import.meta.dir, '..', '..', 'src', 'commands', 'model', 'mercuryModel.tsx'), 'utf8')
  const fold = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'mercury-ui', 'menuFold.tsx'), 'utf8')
  check('the picker reads the outside-press seam the config popup reads', picker.includes("import { escapeFromOutsidePress } from '../ink/recessLayer.js'") && picker.includes("if ((filterFocus || filter !== '') && !escapeFromOutsidePress()) {"))
  check('the match total is the pure reach', picker.includes('const totalModels = filtering ? pickerReachTotal(groups, fullRowsOf) : 0'))
  check('the state word is keyed by the row, not the id', picker.includes('const stateWordOf = (m: ModelChoice, key: string): [string, string] =>') && picker.includes('key === currentKey ? [MODEL_PICKER_CURRENT, TEAL]'))
  check('the filter line takes a pointer through the one row wrapper, with no hover paint of its own', fold.includes('<InteractiveRow id={id ?? \'menu:filter\'} height={1} directActivate onActivate={onFocus}>') && fold.includes('{() => line}') && picker.includes('id="model:filter" onFocus={() => setFilterFocus(true)}'))
  const select = wrapper.slice(wrapper.indexOf('function handleSelect('), wrapper.indexOf('function applySelection('))
  const apply = wrapper.slice(wrapper.indexOf('function applySelection('), wrapper.indexOf('if (transitionConfirm) {'))
  check('the door flip never runs at select time (before the preview card and the daemon\'s word)', !select.includes('handleSlotSwitch(') && select.includes('const pick: PickRoad = { flip: otherDoor === true'))
  const refusedAt = apply.indexOf("if (receipt.state === 'refused') {")
  const flipAt = apply.indexOf('const slotNote = flipDoorNote(pick)')
  check('the flip lands on the apply road after a refusal is ruled out, and rides every sentence', refusedAt >= 0 && flipAt >= 0 && refusedAt < flipAt && (apply.match(/flipDoorNote\(pick\)/g) ?? []).length === 2 && (apply.match(/\$\{slotNote\}/g) ?? []).length === 7)
  check('the use record carries the door on the /model road too', (apply.match(/noteModelUse\(value, pick\.door\)/g) ?? []).length === 2)
  check('the preview card carries the pick to the apply road', wrapper.includes('applySelection(held.value, held.id, held.pick)') && wrapper.includes('setTransitionConfirm({ value, id, plan: gatePlan, refreshed: false, pick })'))
  const config = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'Settings', 'Config.tsx'), 'utf8')
  check('the picker sizes its panel from the slot it is mounted in, and both config doors hand the popup\'s inner width and rows through the modal context', picker.includes('const slot = useModalOrTerminalSize({ rows: termRows, columns: cols })') && picker.includes('const panelWidth = panelWidthFor(slot.columns, MODEL_PICKER_PANEL)') && (config.match(/<ModalContext\.Provider value=\{\{ rows: contentHeight, columns: width, scrollRef: null \}\}>/g) ?? []).length === 2)
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-model-picker-hardening: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
