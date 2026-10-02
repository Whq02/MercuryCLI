#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'picker-edges-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'HF_TOKEN', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MODEL_API_KEY', 'META_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN',
  'MERCURY_CUSTOM_MODEL_OPTION', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'NODE_ENV',
]) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_XAI_API_BASE', 'MERCURY_META_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

const React = (await import('react')).default
const { Box, render, flushPendingSyncWork, EventEmitter, InputEvent } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.js')
const { ModalContext } = await import('../../src/context/modalContext.js')
const { GLYPH } = await import('../../src/components/mercury-ui/glyphs.js')
const { truncateToWidth } = await import('../../src/utils/truncate.js')
const pure = await import('../../src/utils/model/modelPickerGroups.js')
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
const LOGIN = 'Claude Max login'
const KEY = 'API key'
const EMAIL40 = 'a-forty-character-email-address@example.com'
const PREVIEW = 'claude-fable-5-2-preview'
const row = (id: string, name: string, ctx: string, group: string, extra: Partial<ModelChoice> = {}): ModelChoice => ({ id, name, tag: '', ctx, group, ...extra })
const anthropic: ModelChoice[] = [
  row('claude-fable-5-1', 'Fable 5.1', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row('claude-opus-5-5', 'Opus 5.5', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row(PREVIEW, PREVIEW, '1M ctx', ANTHROPIC, { door: LOGIN, tag: 'live · unknown to mercury' }),
  row('claude-opus-5-5', 'Opus 5.5', '1M ctx', ANTHROPIC, { door: KEY }),
]
const OPENROUTER_TOTAL = 30
const openrouterListed: ModelChoice[] = [
  row('nvidia/nemotron-3-ultra:free', 'NVIDIA: Nemotron 3 Ultra (free)', '1M ctx', OPENROUTER),
  row('z-ai/glm-5.3-flash', 'Z.AI: GLM 5.3 Flash', '1.31M ctx', OPENROUTER),
]
const openrouterDoor: ModelChoice = { id: '__mercury_openrouter_expand__', name: `OpenRouter — ${OPENROUTER_TOTAL} models live`, tag: '', ctx: '', group: OPENROUTER, action: true, expand: { group: OPENROUTER, family: 'OpenRouter', total: OPENROUTER_TOTAL } }
const openrouterFull: ModelChoice[] = [...openrouterListed, ...Array.from({ length: OPENROUTER_TOTAL - openrouterListed.length }, (_, k) => row(`vendor-${k}/model.${k}`, `Vendor ${k}`, '128k ctx', OPENROUTER))]
const openai: ModelChoice[] = [row('gpt-6-astra', 'GPT-6 Astra', '872k ctx', OPENAI), { id: '__gpt_connect__', name: 'Sign in to ChatGPT', tag: 'runs /logins', ctx: '', group: OPENAI, action: true }]
const gemini: ModelChoice[] = Array.from({ length: 14 }, (_, k) => row(`gemini-3.${k}-pro`, `Gemini 3.${k} Pro`, '1M ctx', GEMINI))
const headings = {
  [ANTHROPIC]: { name: 'ANTHROPIC', doors: [{ door: LOGIN, account: EMAIL40, active: true }, { door: KEY, account: '…6f2a' }] },
  [OPENROUTER]: { name: 'OPENROUTER', doors: [{ door: 'OAuth key', account: '…9c1d', active: true }] },
  [OPENAI]: { name: 'OPENAI', doors: [{ door: 'ChatGPT Pro login', account: EMAIL40, active: true }] },
  [GEMINI]: { name: 'GEMINI', doors: [{ door: 'Google account', account: EMAIL40, active: true }] },
}
const estate: ModelChoice[] = [...anthropic, ...openrouterListed, openrouterDoor, ...openai, ...gemini]
const expandRows = (group: string): ModelChoice[] => (group === OPENROUTER ? openrouterFull : [])
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

type Mount = { columns: number; rows: number; slotRows?: number; current?: string; pendingNext?: string }
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
  const stdout = Object.assign(stream, { columns: opts.columns, rows: opts.rows }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const picker = React.createElement(MercuryModelPicker, {
    models: estate,
    current: opts.current ?? 'claude-fable-5-1',
    ctxPct: 22,
    efforts: EFFORTS,
    effort: 'max',
    headings,
    topGroup: ANTHROPIC,
    expandRows,
    ...(opts.pendingNext !== undefined ? { pendingNext: opts.pendingNext } : {}),
    onSelect: () => {},
    onClose: () => {},
  } as never)
  const body = opts.slotRows === undefined
    ? React.createElement(Box, { flexDirection: 'column' }, picker)
    : React.createElement(ModalContext.Provider, { value: { rows: opts.slotRows, columns: opts.columns, scrollRef: null } }, React.createElement(Box, { flexDirection: 'column' }, picker))
  const node = React.createElement(StdinContext.Provider, { value: context }, body)
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  return {
    frame: (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    lines: (): string[] => stripAnsi(instance.lastFrame()).replace(/\n$/, '').split('\n'),
    async key(name: string, sequence = '', pasted = false): Promise<void> {
      const event = new InputEvent({ name, sequence, ctrl: false, shift: false, fn: false, meta: false, option: false, super: false, isPasted: pasted } as never)
      emitter.emit('input', event)
      await settle()
    },
    async type(text: string): Promise<void> {
      for (const ch of text) await this.key(ch, ch)
    },
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}
const inner = (line: string): string => line.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '').replace(/^│ /, '')
const bare = (line: string): string => line.replace(/^\s*(?:│\s?)+/, '').replace(/(?:\s*│)+\s*$/, '').trim()
const lineWith = (lines: string[], needle: string): string => lines.find(line => line.includes(needle)) ?? ''
const cursorLine = (lines: string[]): string => inner(lines.find(line => line.includes('│ │ ') || line.includes('❯ ')) ?? '').trim()
const cells = (line: string): string[] => bare(line).split(/\s{2,}/)
const tailCell = (line: string): string => cells(line).at(-1) ?? ''
const PREVIEW_NEEDLE = 'claude-fable-5-2'
const boxLines = (lines: string[]): string[] => {
  const top = lines.findIndex(line => line.includes('╭'))
  const bottom = lines.findIndex((line, index) => index > top && /^\s*╰/.test(line))
  return top < 0 || bottom < 0 ? [] : lines.slice(top, bottom + 1)
}
const save = (name: string, columns: number, rows: number, frame: string): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}-${columns}x${rows}.txt`), frame + '\n')
}
function auditBox(label: string, lines: string[], columns: number): string[] {
  const problems: string[] = []
  const at = lines.findIndex(line => line.includes('Mercury · model'))
  if (at < 0) return [`${label}: no title line`]
  const left = lines[at]!.indexOf('│')
  const right = lines[at]!.lastIndexOf('│')
  const top = lines.findIndex(line => line.indexOf('╭') === left)
  const bottom = lines.findIndex((line, index) => index > top && line.indexOf('╰') === left)
  if (top < 0 || bottom < 0) problems.push(`${label}: the box has no top or bottom border`)
  lines.forEach((line, index) => {
    const chars = [...line]
    if (chars.length > columns) problems.push(`${label}: line ${index} is wider than the terminal`)
    if (index <= top || index >= bottom) return
    if (chars[left] !== '│' || chars[right] !== '│') problems.push(`${label}: line ${index} breaks the border: ${line.trim()}`)
    if (chars.slice(right + 1).join('').trim() !== '') problems.push(`${label}: line ${index} spills past the right border`)
  })
  return problems
}
const innerWidthAt = (columns: number): number => Math.min(pure.MODEL_PICKER_PANEL.cap, columns - pure.MODEL_PICKER_PANEL.reserve) - 4
const SIZES: Array<[number, number]> = [[178, 51], [80, 21]]

section('§1 the tail column: a note the tail cannot hold whole is clipped at its own cell budget with the row\'s own ellipsis, the same on the focused and the unfocused row; where the tail holds it, it stands whole')
for (const [columns, rows] of SIZES) {
  const board = await mount({ columns, rows })
  save('q1-tail', columns, rows, board.frame())
  const budget = pure.pickerColumns(innerWidthAt(columns) - 4).tail
  const expected = truncateToWidth(pure.MODEL_PICKER_NO_ALIAS, budget)
  const unfocused = lineWith(board.lines(), PREVIEW_NEEDLE)
  check(`${columns}x${rows}: the tail budget is ${budget} and the note ${expected === pure.MODEL_PICKER_NO_ALIAS ? 'stands whole' : `clips to "${expected}"`}`, budget > 0, String(budget))
  check(`${columns}x${rows}: the unfocused no-alias row's tail cell reads "${expected}" (the cell budget, the row's own ellipsis)`, tailCell(unfocused) === expected, `"${tailCell(unfocused)}" · ${bare(unfocused)}`)
  check(`${columns}x${rows}: nothing crosses the border`, auditBox(`${columns}x${rows}`, board.lines(), columns).length === 0, auditBox(`${columns}x${rows}`, board.lines(), columns).join(' | '))
  for (let step = 0; step < 6 && !cursorLine(board.lines()).includes(PREVIEW_NEEDLE); step++) await board.key('down')
  const focused = board.lines().find(line => line.includes('│ │ ') && line.includes(PREVIEW_NEEDLE)) ?? ''
  check(`${columns}x${rows}: the focused no-alias row's tail cell reads the same "${expected}" — the focus box never changes the clip`, tailCell(focused) === expected && tailCell(focused) === tailCell(unfocused), `focused "${tailCell(focused)}" · unfocused "${tailCell(unfocused)}"`)
  check(`${columns}x${rows}: the tail never wraps onto a second line`, !board.lines().some(line => /^\s*│\s+(?:│\s+)?(?:alias|no alias|…)\s*│/.test(line)))
  board.close()
}
{
  const columns = pure.pickerColumns(70)
  check('the pure columns at a 70-wide row: alias 17 · id 20 · state 13 · ctx 11 · tail 9 (the ratified shrink order, untouched)', JSON.stringify(columns) === JSON.stringify({ alias: 17, id: 20, state: 13, ctx: 11, tail: 9 }), JSON.stringify(columns))
  check('the pure columns at the ratified width: alias 22 · id 32 · state 13 · ctx 11 · tail 14', JSON.stringify(pure.pickerColumns(92)) === JSON.stringify({ alias: 22, id: 32, state: 13, ctx: 11, tail: 14 }), JSON.stringify(pure.pickerColumns(92)))
}

section('§2 a heading\'s account: an email the heading line cannot hold is clipped at its own cell budget, so the count and the door line\'s active word stand')
for (const [columns, rows] of SIZES) {
  const board = await mount({ columns, rows })
  const door = lineWith(board.lines(), `${LOGIN} · a-forty`)
  for (let step = 0; step < 12 && !cursorLine(board.lines()).startsWith('❯ OPENAI'); step++) await board.key('down')
  save('q2-heading-email', columns, rows, board.frame())
  const heading = cursorLine(board.lines())
  const width = innerWidthAt(columns) - 2
  const wholeHeading = `OPENAI · ChatGPT Pro login · ${EMAIL40} · 1 live`
  const wholeDoor = `${LOGIN} · ${EMAIL40} · 3 live · active`
  const headingFits = wholeHeading.length <= width
  check(`${columns}x${rows}: the OPENAI heading ends with its count, "· 1 live", never a cut email`, /· 1 live$/.test(heading), heading)
  check(`${columns}x${rows}: the heading's email ${headingFits ? 'stands whole' : 'is clipped with the ellipsis inside its own cell'}`, headingFits ? heading === `❯ ${wholeHeading}` : /· a-forty[^ ]*… · 1 live$/.test(heading), heading)
  check(`${columns}x${rows}: the heading fits the line`, [...heading].length <= width + 2, `${[...heading].length} > ${width + 2}`)
  check(`${columns}x${rows}: the login door line ends with "· active" ${wholeDoor.length <= width ? '(whole)' : '(its email clipped at its cell budget)'}`, /· 3 live · active$/.test(inner(door).trim()) && (wholeDoor.length > width || inner(door).trim() === wholeDoor), inner(door).trim())
  board.close()
}
{
  const heading = { name: 'OPENAI', doors: [{ door: 'ChatGPT Pro login', account: EMAIL40, active: true }] }
  const whole = pure.headingWords(heading, OPENAI, { live: 1 })
  check('the pure heading words without a width are untouched: NAME · door · account · N live', whole === `OPENAI · ChatGPT Pro login · ${EMAIL40} · 1 live`, whole)
  const clipped = pure.headingWords(heading, OPENAI, { live: 1 }, 60)
  check('with a width the account is clipped at its own budget and the count stands: the line fits, ends with "· 1 live", the email ends with the ellipsis', [...clipped].length <= 60 && /^OPENAI · ChatGPT Pro login · a-forty[^ ]*… · 1 live$/.test(clipped), clipped)
  check('a width the words already fit leaves them whole', pure.headingWords(heading, OPENAI, { live: 1 }, 120) === whole)
  const tiny = pure.headingWords(heading, OPENAI, { live: 1 }, 34)
  check('a width with no room for the account drops it rather than paint a lone ellipsis', tiny === 'OPENAI · ChatGPT Pro login · 1 live', tiny)
  const doorWhole = pure.doorWords({ door: LOGIN, account: EMAIL40, active: true }, { live: 3 })
  const doorClipped = pure.doorWords({ door: LOGIN, account: EMAIL40, active: true }, { live: 3 }, 50)
  check('the door words clip the account the same way and keep "· active"', doorWhole === `${LOGIN} · ${EMAIL40} · 3 live · active` && [...doorClipped].length <= 50 && /^Claude Max login · a-forty[^ ]*… · 3 live · active$/.test(doorClipped), doorClipped)
  const matched = pure.headingWords(heading, OPENAI, { live: 1, matched: 1, total: 2 }, 60)
  check('while filtering the match count stands past the clipped email', /· 1 of 2$/.test(matched) && [...matched].length <= 60, matched)
}

section('§3 the filter line: a filter longer than the line shows its tail — the newest characters, where the caret is — as the product\'s start-truncation does')
for (const [columns, rows] of SIZES) {
  const board = await mount({ columns, rows })
  const width = innerWidthAt(columns) - 2
  const text = `${'abcdefghij-'.repeat(Math.ceil(width / 11) + 1)}the-end`
  await board.key('/', '/')
  await board.type(text)
  save('q3-filter-tail', columns, rows, board.frame())
  const line = inner(lineWith(board.lines(), '/ ')).trim()
  check(`${columns}x${rows}: the filter line ends with the last characters typed ("the-end")`, line.endsWith('the-end'), line)
  check(`${columns}x${rows}: the cut is marked at the start, "/ …", and the slash keeps the line`, line.startsWith('/ …'), line)
  check(`${columns}x${rows}: the line fits its width`, [...line].length <= width + 2, `${[...line].length} > ${width + 2}`)
  check(`${columns}x${rows}: nothing crosses the border`, auditBox(`${columns}x${rows} filter`, board.lines(), columns).length === 0, auditBox(`${columns}x${rows} filter`, board.lines(), columns).join(' | '))
  await board.key('backspace')
  const shorter = inner(lineWith(board.lines(), '/ ')).trim()
  check(`${columns}x${rows}: ⌫ takes the last character and the tail follows ("the-en")`, shorter.endsWith('the-en') && shorter.startsWith('/ …'), shorter)
  await board.key('escape')
  await board.key('/', '/')
  await board.type('opus')
  const short = inner(lineWith(board.lines(), '/ ')).trim()
  check(`${columns}x${rows}: a filter that fits reads whole, untouched: "/ opus"`, short === '/ opus', short)
  board.close()
}

section('§4 the floor: ten rows hold every line the compact tier paints (the chrome, the effort row, a window of ↑ · pinned heading · cursor row · ↓); under ten the box paints the rows there are — the effort row gives way first, then the pinned heading, then the markers, the cursor row last — never one line more than the slot; at ten and above nothing changes')
type FloorRead = { box: string[]; effort: boolean; markers: number; pinned: boolean; windowLines: number; cursor: string }
const floorCase = async (columns: number, rows: number, slotRows: number | undefined, label: string): Promise<FloorRead> => {
  const board = await mount({ columns, rows, ...(slotRows !== undefined ? { slotRows } : {}) })
  const lines = board.lines()
  const box = boxLines(lines)
  const slot = slotRows ?? rows
  const hint = box.find(line => /esc (?:or click outside )?closes/.test(line)) ?? ''
  const effort = box.some(line => line.includes('e cycles'))
  const markers = box.filter(line => /[↑↓] \d+ more/.test(line)).length
  const aboveAt = box.findIndex(line => /↑ \d+ more/.test(line))
  const pinned = aboveAt >= 0 && /[▾▸] [A-Z]/.test(box[aboveAt + 1] ?? '')
  const windowLines = box.length - 2 - 1 - 1 - 1 - (effort ? 1 : 0)
  const read: FloorRead = { box, effort, markers, pinned, windowLines, cursor: cursorLine(lines) }
  check(`${label}: the box paints ${slot} lines at most — ${box.length}`, box.length > 0 && box.length <= slot, `${box.length} lines: ${box.map(inner).map(line => line.trim()).join(' | ')}`)
  check(`${label}: the title, the filter line, the hint row with the exit words and the cursor row all stand`, box.some(line => line.includes('Mercury · model')) && box.some(line => line.includes('/ filter by name or id')) && hint !== '' && read.cursor.startsWith('❯ '), box.map(inner).map(line => line.trim()).join(' | '))
  check(`${label}: nothing crosses the border`, auditBox(label, lines, columns).length === 0, auditBox(label, lines, columns).join(' | '))
  board.close()
  return read
}
const describe = (read: FloorRead): string => `${read.box.length} lines · effort ${read.effort} · markers ${read.markers} · pinned heading ${read.pinned} · window ${read.windowLines} · cursor "${read.cursor}"`
for (const [columns, rows] of SIZES) {
  const board = await mount({ columns, rows, slotRows: 8 })
  save('q4-floor-slot8', columns, rows, board.frame())
  board.close()
  const twelve = await floorCase(columns, rows, 12, `${columns}x${rows} in a 12-row slot`)
  check(`${columns}x${rows} in a 12-row slot: the compact tier as before — twelve lines, the effort row, a six-line window`, twelve.box.length === 12 && twelve.effort && twelve.windowLines === 6, describe(twelve))
  const ten = await floorCase(columns, rows, 10, `${columns}x${rows} in a 10-row slot`)
  check(`${columns}x${rows} in a 10-row slot: ten lines — the effort row, both markers, the pinned heading, the cursor row (the smallest slot that holds every line the tier paints)`, ten.box.length === 10 && ten.effort && ten.markers === 2 && ten.pinned && ten.windowLines === 4, describe(ten))
  const nine = await floorCase(columns, rows, 9, `${columns}x${rows} in a 9-row slot`)
  check(`${columns}x${rows} in a 9-row slot: the effort row gives way first; the window keeps its markers, the pinned heading and the cursor row`, nine.box.length === 9 && !nine.effort && nine.markers === 2 && nine.pinned && nine.windowLines === 4, describe(nine))
  const eight = await floorCase(columns, rows, 8, `${columns}x${rows} in an 8-row slot`)
  check(`${columns}x${rows} in an 8-row slot: no effort row; the pinned heading gives way; the markers and the cursor row stand`, eight.box.length === 8 && !eight.effort && eight.markers === 2 && !eight.pinned && eight.windowLines === 3, describe(eight))
  const seven = await floorCase(columns, rows, 7, `${columns}x${rows} in a 7-row slot`)
  check(`${columns}x${rows} in a 7-row slot: the markers give way; two rows paint, the cursor row among them`, seven.box.length === 7 && seven.markers === 0 && seven.windowLines === 2, describe(seven))
  const six = await floorCase(columns, rows, 6, `${columns}x${rows} in a 6-row slot`)
  check(`${columns}x${rows} in a 6-row slot: the cursor row alone between the title and the filter line`, six.box.length === 6 && six.windowLines === 1 && six.markers === 0 && !six.pinned, describe(six))
}
{
  const board = await mount({ columns: 60, rows: 8 })
  save('q4-floor', 60, 8, board.frame())
  board.close()
  const read = await floorCase(60, 8, undefined, '60x8 (the review\'s own size)')
  check('60x8: eight lines, the cursor row on screen', read.box.length === 8 && read.cursor.startsWith('❯ '), describe(read))
}

section('§5 the pending line: the product\'s pending glyph leads the pending clause, as the concourse\'s held note leads with it, never standing between the two names as a connector; the rows stay calm')
for (const [columns, rows] of SIZES) {
  const board = await mount({ columns, rows, pendingNext: 'claude-opus-5-5' })
  save('q5-pending-glyph', columns, rows, board.frame())
  const line = inner(lineWith(board.lines(), 'applies when the turn settles')).trim()
  check(`${columns}x${rows}: the line reads "current Fable 5.1 · ${GLYPH.pending} next Opus 5.5 · applies when the turn settles"`, line === `current Fable 5.1 · ${GLYPH.pending} next Opus 5.5 · applies when the turn settles`, line)
  check(`${columns}x${rows}: the glyph is the product's pending glyph and it leads the next clause after the picker's own separator, never standing between the two names`, line.includes(`· ${GLYPH.pending} next `) && !new RegExp(`[^·] ${GLYPH.pending} next `).test(line), line)
  const nextRow = board.lines().find(row => /\s{2}next\s{2}/.test(row)) ?? ''
  check(`${columns}x${rows}: the queued row still carries "next" in its calm state column`, nextRow.includes('claude-opus-5-5'), nextRow)
  check(`${columns}x${rows}: no row carries a glyph — the rows stay calm`, !board.lines().some(row => /│ (?:│ | {2})(?:❯ )?[○●⦿□]/.test(row)))
  board.close()
}
{
  const picker = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'MercuryModelPicker.tsx'), 'utf8')
  check('the picker paints the pending glyph from the one glyph table (GLYPH.pending), never a literal', picker.includes('GLYPH.pending') && !/'○'/.test(picker))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-model-picker-edges: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
