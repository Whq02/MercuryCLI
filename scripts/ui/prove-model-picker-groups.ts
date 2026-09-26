#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'picker-groups-'))
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
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

const React = (await import('react')).default
const { Box, render, flushPendingSyncWork, EventEmitter, InputEvent } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.js')
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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const ANTHROPIC = 'Mercury — Anthropic models'
const OPENAI = 'Mercury — OpenAI models'
const OPENROUTER = 'Mercury — OpenRouter models'
const MOONSHOT = 'Mercury — Moonshot models'
const GEMINI = 'Mercury — Gemini models'
const ZAI = 'Mercury — Z.AI models'
const DEEPSEEK = 'Mercury — DeepSeek models'
const LOGIN = 'Claude Max login'
const KEY = 'API key'
const EMAIL = 'operator@example.com'

const row = (id: string, name: string, ctx: string, group: string, extra: Partial<ModelChoice> = {}): ModelChoice => ({ id, name, tag: '', ctx, group, ...extra })
const anthropicLogin: ModelChoice[] = [
  row('claude-fable-5-1', 'Fable 5.1', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row('claude-fable-5', 'Fable 5', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row('claude-opus-5-5', 'Opus 5.5', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row('claude-opus-5', 'Opus 5', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row('claude-sonnet-5', 'Sonnet 5', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row('claude-haiku-4-5-20251001', 'Haiku 4.5', '200k ctx', ANTHROPIC, { door: LOGIN }),
  row('claude-fable-5-2-preview', 'claude-fable-5-2-preview', '1M ctx', ANTHROPIC, { door: LOGIN, tag: 'live · unknown to mercury' }),
]
const anthropicKey: ModelChoice[] = [
  row('claude-opus-5-5', 'Opus 5.5', '1M ctx', ANTHROPIC, { door: KEY }),
  row('claude-sonnet-5', 'Sonnet 5', '1M ctx', ANTHROPIC, { door: KEY }),
]
const openai: ModelChoice[] = [
  row('gpt-6-astra', 'GPT-6 Astra', '872k ctx', OPENAI),
  row('gpt-6-sol', 'GPT-6 Sol', '872k ctx', OPENAI),
  row('gpt-6-luna', 'GPT-6 Luna', '872k ctx', OPENAI),
  row('gpt-5.6-sol', 'GPT-5.6 Sol', '872k ctx', OPENAI),
  row('gpt-5.5', 'GPT-5.5', '272k ctx', OPENAI),
]
const OPENROUTER_TOTAL = 459
const openrouterListed: ModelChoice[] = [
  row('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', '1.05M ctx', OPENROUTER),
  row('z-ai/glm-5.3-flash', 'GLM 5.3 Flash', '1.31M ctx', OPENROUTER),
  row('moonshotai/kimi-k3', 'Kimi K3', '1.05M ctx', OPENROUTER),
  row('nvidia/nemotron-3-ultra:free', 'nvidia/nemotron-3-ultra:free', '1M ctx', OPENROUTER),
]
const openrouterDoor: ModelChoice = { id: '__mercury_openrouter_expand__', name: `OpenRouter — ${OPENROUTER_TOTAL} models live`, tag: '', ctx: '', group: OPENROUTER, action: true, expand: { group: OPENROUTER, family: 'OpenRouter', total: OPENROUTER_TOTAL } }
const openrouterFull: ModelChoice[] = [
  ...openrouterListed,
  row('anthropic/claude-opus-5.5', 'anthropic/claude-opus-5.5', '1M ctx', OPENROUTER),
  ...Array.from({ length: OPENROUTER_TOTAL - openrouterListed.length - 1 }, (_, k) => row(`vendor-${k}/model-${k}`, `Vendor ${k} Model ${k}`, '128k ctx', OPENROUTER)),
]
const moonshot: ModelChoice[] = [row('kimi-k3-0905', 'Kimi K3', '262k ctx', MOONSHOT), row('kimi-k2.5-thinking', 'Kimi K2.5', '262k ctx', MOONSHOT)]
const gemini: ModelChoice[] = Array.from({ length: 14 }, (_, k) => row(`gemini-3.${k}-pro`, `Gemini 3.${k} Pro`, '1M ctx', GEMINI))
const zai: ModelChoice[] = [
  row('glm-5.3', 'GLM 5.3', '200k ctx', ZAI),
  row('glm-5.3-air', 'GLM 5.3 Air', '128k ctx', ZAI),
  row('glm-5.3-vision', 'GLM 5.3 Vision', '64k ctx', ZAI, { gated: true, gatedReason: 'not offered on the Coding Plan' }),
]
const deepseek: ModelChoice[] = [row('deepseek-v4-pro', 'DeepSeek V4 Pro', '128k ctx', DEEPSEEK), row('deepseek-v4-flash', 'DeepSeek V4 Flash', '128k ctx', DEEPSEEK)]

type Heading = { name: string; doors: Array<{ door: string; account?: string; active?: boolean }>; reason?: string }
const headings: Record<string, Heading> = {
  [ANTHROPIC]: { name: 'ANTHROPIC', doors: [{ door: LOGIN, account: EMAIL, active: true }, { door: KEY, account: '…6f2a' }] },
  [OPENAI]: { name: 'OPENAI', doors: [{ door: 'ChatGPT Pro login', account: EMAIL, active: true }] },
  [OPENROUTER]: { name: 'OPENROUTER', doors: [{ door: 'OAuth key', account: '…9c1d', active: true }] },
  [MOONSHOT]: { name: 'MOONSHOT', doors: [{ door: 'Kimi login', account: 'kimi-operator', active: true }] },
  [GEMINI]: { name: 'GEMINI', doors: [{ door: 'Google account', account: EMAIL, active: true }] },
  [ZAI]: { name: 'Z.AI', doors: [{ door: 'Coding Plan key', account: '…41aa', active: true }] },
  [DEEPSEEK]: { name: 'DEEPSEEK', doors: [{ door: 'API key', account: '…07b3', active: true }] },
}

const groupsInTodaysOrder: Array<[string, ModelChoice[]]> = [
  [OPENAI, openai],
  [ANTHROPIC, [...anthropicLogin, ...anthropicKey]],
  [OPENROUTER, [...openrouterListed, openrouterDoor]],
  [GEMINI, gemini],
  [ZAI, zai],
  [MOONSHOT, moonshot],
  [DEEPSEEK, deepseek],
]
function orderedRows(top: string, recent: string[]): ModelChoice[] {
  const rank = (group: string): number => (group === top ? -1 : recent.indexOf(group) >= 0 ? recent.indexOf(group) : 100 + groupsInTodaysOrder.findIndex(([name]) => name === group))
  return [...groupsInTodaysOrder].sort((a, b) => rank(a[0]) - rank(b[0])).flatMap(([, rows]) => rows)
}

const selected: string[] = []
const selectedDoors: Array<string | undefined> = []
let closed = 0
async function mount(opts: { models: ModelChoice[]; current: string; top: string; columns: number; height: number }) {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: opts.columns, rows: opts.height }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = React.createElement(
    StdinContext.Provider,
    { value: context },
    React.createElement(Box, { flexDirection: 'column' }, React.createElement(MercuryModelPicker, {
      models: opts.models,
      current: opts.current,
      ctxPct: 22,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'supercode'],
      effort: 'max',
      headings,
      topGroup: opts.top,
      expandRows: (group: string) => (group === OPENROUTER ? openrouterFull : []),
      onSelect: (id: string, door?: string) => { selected.push(id); selectedDoors.push(door) },
      onClose: () => { closed++ },
    } as never)),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  return {
    frame: (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    lines: (): string[] => stripAnsi(instance.lastFrame()).replace(/\n$/, '').split('\n'),
    async key(name: string, sequence = ''): Promise<boolean> {
      const event = new InputEvent({ name, sequence, ctrl: false, shift: false, fn: false, meta: false, option: false, super: false, isPasted: false } as never)
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
const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const inner = (line: string): string => line.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '').replace(/^│ /, '')
const lineWith = (lines: string[], needle: string): string => lines.find(line => line.includes(needle)) ?? ''
const rowOf = (lines: string[], id: string, door?: string): string => {
  const at = door === undefined ? -1 : lines.findIndex(line => line.includes(door) && !line.includes('+'))
  return (at < 0 ? lines : lines.slice(at)).find(line => line.includes(id) && !line.includes('Mercury · model')) ?? ''
}
const save = (name: string, columns: number, rows: number, frame: string): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}-${columns}x${rows}.txt`), frame + '\n')
}

section('§1 the home state at 178x51: header · groups · doors · rows · order · calm · foot')
{
  const board = await mount({ models: orderedRows(ANTHROPIC, [OPENROUTER, MOONSHOT]), current: 'claude-fable-5-1', top: ANTHROPIC, columns: 178, height: 51 })
  const lines = board.lines()
  const frame = board.frame()
  save('home', 178, 51, frame)
  const title = lineWith(lines, 'Mercury · model')
  check('the header is the one plain line "Mercury · model"', title !== '' && inner(title).trim() === 'Mercury · model', title)
  check('no crab mark and no accent lockup on the header', !frame.includes('▟') && !frame.includes('▙'))
  check('the second line "CHOOSE A MODEL · … · model ids are real" is gone', !frame.includes('CHOOSE A MODEL') && !frame.includes('model IDs are real'))
  const anthropicHeading = lineWith(lines, 'ANTHROPIC')
  check('the top group is the seat\'s own provider, its heading first', lines.findIndex(line => line.includes('ANTHROPIC')) < lines.findIndex(line => line.includes('OPENROUTER')), anthropicHeading)
  check('two doors signed in ⇒ the provider heading names both doors and the distinct live count', inner(anthropicHeading).trim() === `▾ ANTHROPIC · ${LOGIN} + ${KEY} · 7 live`, inner(anthropicHeading).trim())
  const loginDoor = lines.find(line => line.includes(`${LOGIN} · ${EMAIL}`)) ?? ''
  const keyDoor = lines.find(line => line.includes(`${KEY} · …6f2a`)) ?? ''
  check('the login door is a sub-heading: door · account (the email) · N live · active', inner(loginDoor).trim() === `${LOGIN} · ${EMAIL} · 7 live · active`, inner(loginDoor).trim())
  check('the key door is a sub-heading: door · the key\'s tail · N live', inner(keyDoor).trim() === `${KEY} · …6f2a · 2 live`, inner(keyDoor).trim())
  const loginAt = lines.indexOf(loginDoor)
  const keyAt = lines.indexOf(keyDoor)
  check('the seat\'s own door comes first', loginAt >= 0 && keyAt >= 0 && loginAt < keyAt, `${loginAt} / ${keyAt}`)
  const others = [lineWith(lines, 'OPENROUTER'), lineWith(lines, 'MOONSHOT'), lineWith(lines, 'OPENAI'), lineWith(lines, 'GEMINI'), lineWith(lines, 'Z.AI'), lineWith(lines, 'DEEPSEEK')]
  check('the other providers follow by most recent use, then the never-used in today\'s order', others.every(line => line !== '') && others.map(line => lines.indexOf(line)).every((at, k, all) => k === 0 || at > all[k - 1]!), others.map(inner).join(' | '))
  check('a one-door heading reads PROVIDER · door · account · N live', inner(lineWith(lines, 'OPENAI')).trim() === `▾ OPENAI · ChatGPT Pro login · ${EMAIL} · 5 live`, inner(lineWith(lines, 'OPENAI')).trim())
  check('the OpenRouter heading counts the whole live list', inner(lineWith(lines, 'OPENROUTER')).trim() === `▸ OPENROUTER · OAuth key · …9c1d · ${OPENROUTER_TOTAL} live`, inner(lineWith(lines, 'OPENROUTER')).trim())
  const fable = rowOf(lines, 'claude-fable-5-1')
  check('the current row reads alias · raw id · current · ctx', /Fable 5\.1\s+claude-fable-5-1\s+current\s+1M ctx/.test(fable), fable)
  check('the current row sits in the red cursor box', lines[lines.indexOf(fable) - 1]?.includes('╭') === true && lines[lines.indexOf(fable) + 1]?.includes('╰') === true)
  const fable5 = rowOf(lines, 'claude-fable-5 ')
  check('every other row\'s state column is empty (no "switch")', /Fable 5\s+claude-fable-5\s+1M ctx/.test(fable5) && !frame.includes('switch  '), fable5)
  check('no ○ / ● glyph in front of any row', !frame.includes('○') && !frame.includes('●'))
  const preview = rowOf(lines, 'claude-fable-5-2-preview')
  check('an id Mercury has no alias for lands under its raw id with "new · no alias"', /—\s+claude-fable-5-2-preview\s+1M ctx\s+new · no alias/.test(preview), preview)
  check('a model both doors list is one row under each door', rowOf(lines, 'claude-opus-5-5', `${LOGIN} · ${EMAIL}`) !== '' && rowOf(lines, 'claude-opus-5-5', `${KEY} · …6f2a`) !== '')
  check('a provider with more than twelve rows opens folded: heading only, ▸', inner(lineWith(lines, 'GEMINI')).trim().startsWith('▸ GEMINI') && !frame.includes('gemini-3.0-pro') && inner(lineWith(lines, 'OPENROUTER')).trim().startsWith('▸ OPENROUTER') && !frame.includes('deepseek/deepseek-v4.1-flash'), inner(lineWith(lines, 'GEMINI')).trim())
  check('the door row itself is not a row any more', !frame.includes('OpenRouter — 459 models live'))
  const gated = rowOf(lines, 'glm-5.3-vision')
  check('a gated row says unavailable in the state column', /GLM 5\.3 Vision\s+glm-5\.3-vision\s+unavailable\s+64k ctx/.test(gated), gated)
  const tail = lines.filter(line => /[A-Za-z]/.test(inner(line))).slice(-4).map(line => inner(line).trim())
  check('the foot is the context bar, the effort row, the filter line, the hint row', tail[0]!.startsWith('context ') && tail[1]!.startsWith('effort  ') && tail[2] === '/ filter by name or id' && tail[3] === '↑↓ select · ↵ switch · c context · → ← fold · / filter · esc or click outside closes', tail.join(' | '))
  check('the effort row keeps the ladder and names its key', tail[1]!.includes('[max]') && tail[1]!.includes('supercode') && tail[1]!.endsWith('e cycles'), tail[1])
  check('the picker fits 178x51 whole', lines.length <= 51 && lines.every(line => line.length <= 178))

  section('§2 fold: ← walks to the heading and folds, → unfolds; ↵ on a heading toggles')
  await board.key('left')
  let now = board.lines()
  check('← on a row moves the cursor to its provider heading', inner(lineWith(now, 'ANTHROPIC')).trim().startsWith('❯ ANTHROPIC'), inner(lineWith(now, 'ANTHROPIC')).trim())
  await board.key('left')
  now = board.lines()
  save('folded', 178, 51, board.frame())
  check('← on the heading folds the provider: heading only, no rows', !board.frame().includes('claude-fable-5-1') && !board.frame().includes(LOGIN + ' · ' + EMAIL), lineWith(now, 'ANTHROPIC'))
  check('the hint follows the heading: ↵ unfold', lineWith(now, '↑↓ select').includes('↵ unfold'), inner(lineWith(now, '↑↓ select')).trim())
  await board.key('right')
  now = board.lines()
  check('→ on the folded heading unfolds it again', board.frame().includes('claude-fable-5-1') && inner(lineWith(now, 'ANTHROPIC')).trim().startsWith('❯ ANTHROPIC'))
  await board.key('return')
  check('↵ on the heading folds it', !board.frame().includes('claude-fable-5-1') && selected.length === 0)
  await board.key('return')
  check('↵ again unfolds it', board.frame().includes('claude-fable-5-1'))
  await board.key('right')
  now = board.lines()
  check('→ on an open heading steps into its first row', rowOf(now, 'claude-fable-5-1').includes('current') && now[now.indexOf(rowOf(now, 'claude-fable-5-1')) - 1]?.includes('╭') === true)
  for (let k = 0; k < 9; k++) await board.key('down')
  now = board.lines()
  check('↓ walks headings and rows alike: nine steps from the first row land on the folded OpenRouter heading', inner(lineWith(now, 'OPENROUTER')).trim().startsWith('❯ OPENROUTER'), inner(lineWith(now, 'OPENROUTER')).trim())
  await board.key('right')
  now = board.lines()
  const partly = board.frame()
  check('→ on a folded big list shows its listed rows and says how to unfold the rest', partly.includes('deepseek/deepseek-v4.1-flash') && partly.includes(`↓ ${OPENROUTER_TOTAL - openrouterListed.length} more · → unfolds the rest · / filter reaches every one`), now.filter(line => line.includes('more')).join(' | '))
  await board.key('down')
  await board.key('right')
  const unfolded = board.frame()
  check('→ on a row of the partly shown list unfolds the rest (the full live list behind the door)', !unfolded.includes('→ unfolds the rest') && unfolded.includes('anthropic/claude-opus-5.5'), unfolded.split('\n').filter(line => line.includes('more')).join(' | '))
  check('the cursor stays on the row it was on', board.lines()[board.lines().indexOf(rowOf(board.lines(), 'deepseek/deepseek-v4.1-flash')) - 1]?.includes('╭') === true)

  section('§3 the filter: / opens the line, typing narrows every group, empty groups drop, ↵ switches, esc clears then closes')
  await board.key('/', '/')
  now = board.lines()
  check('/ focuses the filter line (its slash lights up, the placeholder stays until typing)', lineWith(now, 'filter by name or id') !== '' && lineWith(now, '↑↓ select').includes('type to filter'), inner(lineWith(now, '↑↓ select')).trim())
  await board.type('opus')
  now = board.lines()
  save('filter', 178, 51, board.frame())
  const matchLine = lineWith(now, 'Mercury · model')
  check('the header line says N of M match', /Mercury · model · 4 of \d+ match$/.test(inner(matchLine).trim()), inner(matchLine).trim())
  check('every group narrows by alias or id: the login door keeps its two opus rows', /Opus 5\.5/.test(rowOf(now, 'claude-opus-5-5', `${LOGIN} · ${EMAIL}`)) && rowOf(now, 'claude-opus-5', `${LOGIN} · ${EMAIL}`) !== '' && !board.frame().includes('claude-fable-5-1'))
  check('the filter reaches the whole OpenRouter list', board.frame().includes('anthropic/claude-opus-5.5'))
  check('groups with no match drop away', !board.frame().includes('GEMINI') && !board.frame().includes('MOONSHOT') && !board.frame().includes('OPENAI ·') && !board.frame().includes('Z.AI'))
  check('the headings count matches: N of M', inner(lineWith(now, 'ANTHROPIC')).trim().endsWith('· 3 of 9') && inner(lineWith(now, 'OPENROUTER')).trim().endsWith(`· 1 of ${OPENROUTER_TOTAL}`), `${inner(lineWith(now, 'ANTHROPIC')).trim()} | ${inner(lineWith(now, 'OPENROUTER')).trim()}`)
  check('the filter line shows the typed text', lineWith(now, '/ opus') !== '')
  check('the cursor sits on the first match', now[now.indexOf(rowOf(now, 'claude-opus-5-5')) - 1]?.includes('╭') === true)
  await board.key('return')
  check('↵ switches the selected row and names the door it sits under', selected.length === 1 && selected[0] === 'claude-opus-5-5' && selectedDoors[0] === LOGIN, `${selected.join(',')} · ${selectedDoors.join(',')}`)
  await board.key('down')
  await board.key('down')
  await board.key('return')
  check('↵ on the same model under the other door names that door', selected.length === 2 && selected[1] === 'claude-opus-5-5' && selectedDoors[1] === KEY, `${selected.join(',')} · ${selectedDoors.join(',')}`)
  await board.key('escape')
  now = board.lines()
  check('the first esc clears the filter and keeps the picker open', closed === 0 && lineWith(now, 'filter by name or id') !== '' && board.frame().includes('claude-fable-5-1') && inner(lineWith(now, 'Mercury · model')).trim() === 'Mercury · model', `closed ${closed} · ${inner(lineWith(now, '/ ')).trim()} · ${inner(lineWith(now, 'Mercury · model')).trim()}`)
  await board.key('escape')
  check('the second esc closes', closed === 1)

  section('§4 c answers on a carrier row and never dies silent')
  for (let k = 0; k < 40; k++) await board.key('down')
  await board.key('c', 'c')
  check('c on a row with no toggle answers with the window law', board.frame().includes('not a toggle'), board.lines().filter(line => line.includes('ctx ·')).join(' | '))
  board.close()
}

section('§5 opened from a session on an OpenAI model: OPENAI on top')
{
  const board = await mount({ models: orderedRows(OPENAI, [ANTHROPIC, OPENROUTER]), current: 'gpt-6-astra', top: OPENAI, columns: 178, height: 51 })
  const lines = board.lines()
  save('openai-top', 178, 51, board.frame())
  check('the OPENAI heading comes first, its rows open', lines.findIndex(line => line.includes('OPENAI')) < lines.findIndex(line => line.includes('ANTHROPIC')) && board.frame().includes('gpt-6-astra'))
  check('the current mark moved to the OpenAI row', /GPT-6 Astra\s+gpt-6-astra\s+current\s+872k ctx/.test(rowOf(lines, 'gpt-6-astra')), rowOf(lines, 'gpt-6-astra'))
  check('ANTHROPIC (nine rows) still opens', board.frame().includes('claude-fable-5-1'))
  board.close()
}

section('§6 the frames at every size the brief names')
for (const [columns, rows] of [[120, 40], [200, 60], [269, 70]] as Array<[number, number]>) {
  const board = await mount({ models: orderedRows(ANTHROPIC, [OPENROUTER, MOONSHOT]), current: 'claude-fable-5-1', top: ANTHROPIC, columns, height: rows })
  const lines = board.lines()
  save('home', columns, rows, board.frame())
  check(`${columns}x${rows}: the picker fits the terminal`, lines.length <= rows && lines.every(line => line.length <= columns), `${lines.length} lines`)
  check(`${columns}x${rows}: the plain header and the ratified hint row`, lines.some(line => inner(line).trim() === 'Mercury · model') && lines.some(line => inner(line).trim().startsWith('↑↓ select · ↵ switch')))
  check(`${columns}x${rows}: the current row is on screen`, rowOf(lines, 'claude-fable-5-1').includes('current'))
  await board.key('left'); await board.key('left')
  save('folded', columns, rows, board.frame())
  await board.key('right')
  await board.key('/', '/'); await board.type('opus')
  save('filter', columns, rows, board.frame())
  board.close()
  const other = await mount({ models: orderedRows(OPENAI, [ANTHROPIC, OPENROUTER]), current: 'gpt-6-astra', top: OPENAI, columns, height: rows })
  save('openai-top', columns, rows, other.frame())
  other.close()
}

section('§7 the wrapper: a row under the door that is not the wire\'s active slot flips the slot before the switch, one receipt names both')
{
  const wrapper = await Bun.file(new URL('../../src/commands/model/mercuryModel.tsx', import.meta.url)).text()
  check('the select reads the row\'s door against the heading\'s active door', wrapper.includes("const otherDoor = door !== undefined && !isProviderActionRow(id) && headings[ANTHROPIC_MODEL_GROUP]?.doors.some(candidate => candidate.door === door && candidate.active !== true)"))
  check('the flip rides the one slot-switch owner (the same road as s)', wrapper.includes('const receipt = handleSlotSwitch(ANTHROPIC_MODEL_GROUP)') && wrapper.includes('const outcome = switchActiveSlot(family)'))
  check('the switch sentence carries the slot receipt on every apply road', (wrapper.match(/\$\{lossNote\}\$\{slotNote\}/g) ?? []).length === 4 && wrapper.includes('applySelection(held.value, held.id, held.pick)'))
  check('the use record lands on the apply roads, never on a turn', (wrapper.match(/noteModelUse\(/g) ?? []).length >= 3 && !wrapper.includes('noteModelUse(servedModel'))
}

section('§8 the pure composition (the module the picker derives its lines from)')
{
  const pure = await import('../../src/utils/model/modelPickerGroups.ts').catch(() => null)
  check('the pure module exists', pure !== null)
  if (pure !== null) {
    const rows = orderedRows(OPENAI, [])
    const groups = pure.groupPickerRows(rows)
    const ordered = pure.orderPickerGroups(groups, { top: ANTHROPIC, recentAt: group => ({ [MOONSHOT]: 300, [OPENROUTER]: 200, [OPENAI]: 100 } as Record<string, number>)[group] })
    check('the order rule: the seat first, then most recent use, then today\'s order', ordered.map(group => group.group).join(' > ') === [ANTHROPIC, MOONSHOT, OPENROUTER, OPENAI, GEMINI, ZAI, DEEPSEEK].join(' > '), ordered.map(group => group.group).join(' > '))
    const folds = pure.initialPickerFolds(ordered, ANTHROPIC, 'claude-fable-5-1@' + LOGIN)
    check('the fold rule: over twelve rows opens folded unless top; the rest open', folds[GEMINI] === 'folded' && folds[ANTHROPIC] === 'top' && folds[OPENROUTER] === 'folded' && folds[OPENAI] === 'top', JSON.stringify(folds))
    const lines = pure.composePickerLines(ordered, folds, '', group => (group === OPENROUTER ? openrouterFull : undefined))
    check('a folded group composes to its heading alone', lines.filter(line => line.kind !== 'heading' && 'group' in line && line.group === GEMINI).length === 0)
    check('the door row never composes as a row', !lines.some(line => line.kind === 'row' && line.row.expand !== undefined))
    const filtered = pure.composePickerLines(ordered, folds, 'opus', group => (group === OPENROUTER ? openrouterFull : undefined))
    check('the filter reaches the door group\'s full list and drops empty groups', filtered.some(line => line.kind === 'row' && line.row.id === 'anthropic/claude-opus-5.5') && !filtered.some(line => line.kind === 'heading' && line.group === GEMINI))
    check('the heading words: one door, two doors, a reason', pure.headingWords({ name: 'OPENAI', doors: [{ door: 'ChatGPT Pro login', account: 'a@b.c' }] }, OPENAI, { live: 7 }) === 'OPENAI · ChatGPT Pro login · a@b.c · 7 live' && pure.headingWords({ name: 'ANTHROPIC', doors: [{ door: 'Claude Max login' }, { door: 'API key' }] }, ANTHROPIC, { live: 10 }) === 'ANTHROPIC · Claude Max login + API key · 10 live' && pure.headingWords({ name: 'DEEPSEEK', doors: [], reason: 'not connected' }, DEEPSEEK, { live: 0 }) === 'DEEPSEEK · not connected')
    check('the columns at the ratified width: alias 22 · id 32 · state 13 · ctx 11 · tail 14 (each cell two spaces short of its width)', JSON.stringify(pure.pickerColumns(92)) === JSON.stringify({ alias: 22, id: 32, state: 13, ctx: 11, tail: 14 }), JSON.stringify(pure.pickerColumns(92)))
    check('the hint row is the owner\'s line', pure.MODEL_PICKER_HINT === '↑↓ select · ↵ switch · c context · → ← fold · / filter · esc or click outside closes')
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-model-picker-groups: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
