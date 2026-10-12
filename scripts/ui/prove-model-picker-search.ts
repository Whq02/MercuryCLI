#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'picker-search-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'HF_TOKEN', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MERCURY_OAUTH_TOKEN',
  'MERCURY_CUSTOM_MODEL_OPTION', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'NODE_ENV',
]) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_XAI_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

const React = (await import('react')).default
const { Box, render, flushPendingSyncWork, EventEmitter, InputEvent } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.js')
const words = await import('../../src/utils/model/modelPickerGroups.js')
const { modelPickerFooter } = await import('../../src/utils/model/modelPickerFooter.js')
type ModelChoice = import('../../src/components/MercuryModelPicker.js').ModelChoice

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
const row = (id: string, name: string, ctx: string, group: string): ModelChoice => ({ id, name, tag: '', ctx, group })
const models: ModelChoice[] = [
  row('claude-fable-5-1', 'Fable 5.1', '1M ctx', ANTHROPIC),
  row('claude-opus-5-5', 'Opus 5.5', '1M ctx', ANTHROPIC),
  row('claude-sonnet-5', 'Sonnet 5', '1M ctx', ANTHROPIC),
  row('claude-haiku-4-5-20251001', 'Haiku 4.5', '200k ctx', ANTHROPIC),
  row('gpt-6-astra', 'GPT-6 Astra', '872k ctx', OPENAI),
  row('gpt-6-sol', 'GPT-6 Sol', '872k ctx', OPENAI),
  row('gpt-5.5', 'GPT-5.5', '272k ctx', OPENAI),
]
const headings = {
  [ANTHROPIC]: { name: 'ANTHROPIC', doors: [{ door: 'Claude Max login', account: 'operator@example.com', active: true }] },
  [OPENAI]: { name: 'OPENAI', doors: [{ door: 'ChatGPT Pro login', account: 'operator@example.com', active: true }] },
}

const selected: string[] = []
let closed = 0
async function mount(columns: number, height: number) {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: height }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = React.createElement(
    StdinContext.Provider,
    { value: context },
    React.createElement(Box, { flexDirection: 'column' }, React.createElement(MercuryModelPicker, {
      models,
      current: 'claude-fable-5-1',
      ctxPct: 22,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      effort: 'max',
      headings,
      topGroup: ANTHROPIC,
      onSelect: (id: string) => { selected.push(id) },
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
    async key(name: string, sequence = '', ctrl = false): Promise<boolean> {
      const event = new InputEvent({ name, sequence, ctrl, shift: false, fn: false, meta: false, option: false, super: false, isPasted: false } as never)
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
const title = (lines: string[]): string => inner(lineWith(lines, 'Mercury · model')).trim()
const legend = (lines: string[]): string => inner(lineWith(lines, '↑↓ select')).trim()
const box = (lines: string[]): string => inner(lineWith(lines, '/ ')).trim()
const cursorRow = (lines: string[]): string => {
  const at = lines.findIndex(line => /│ ╭/.test(line))
  return at >= 0 ? inner(lines[at + 1] ?? '').replace(/^│ /, '').trim() : ''
}

section('§1 the words: the owner’s hint, the box at rest and in focus, the legends')
{
  check('the rows’ hint names the chords and says tab to search', words.MODEL_PICKER_HINT === '↑↓ select · ↵ switch · ctrl+w context · → ← fold · tab to search · esc or click outside closes', words.MODEL_PICKER_HINT)
  check('the box at rest says to type', words.MODEL_PICKER_FILTER_PLACEHOLDER === 'type to search by name or id')
  check('the box in focus says what it searches', words.MODEL_PICKER_SEARCH_PLACEHOLDER === 'search by name or id')
  check('the more line says the search reaches every folded row', words.moreLineWords(38, true) === '↓ 38 more · → unfolds the rest · search reaches every one')
  check('the rows’ legend is the hint, whole, at width', modelPickerFooter({ gated: false }, 120) === words.MODEL_PICKER_HINT)
  check('the box’s legend: type to search · ↵ switch · tab back to the rows · esc or click outside closes', modelPickerFooter({ gated: false, filterFocus: true }, 120) === '↑↓ select · type to search · ↵ switch · tab back to the rows · esc or click outside closes')
  check('while a search stands the tail says esc clears it, on both sides', modelPickerFooter({ gated: false, filterFocus: true, filtering: true }, 120).endsWith('esc clears the search') && modelPickerFooter({ gated: false, filterFocus: false, filtering: true }, 120).endsWith('esc clears the search'))
  check('no legend names the old way in or the old leave word', ![modelPickerFooter({ gated: false }, 120), modelPickerFooter({ gated: false, filterFocus: true }, 120), modelPickerFooter({ gated: false, filterFocus: true, filtering: true }, 120)].some(line => line.includes('/ filter') || line.includes('type to filter') || line.includes('esc leaves')))
}

section('§2 the box sits at the top and the picker opens in the rows')
const board = await mount(120, 40)
{
  const lines = board.lines()
  const titleAt = lines.findIndex(line => line.includes('Mercury · model'))
  check('the title is the first line of the panel', titleAt === 1, `${titleAt}`)
  check('the search box is the line right under it, at rest', inner(lines[titleAt + 1] ?? '').trim() === '/ type to search by name or id', inner(lines[titleAt + 1] ?? '').trim())
  check('the box is the only slash line: nothing of it remains at the foot', lines.filter(line => /│ \/ /.test(line)).length === 1)
  check('the legend is the rows’ own', legend(lines) === words.MODEL_PICKER_HINT, legend(lines))
  check('the cursor sits on the current row', cursorRow(lines).includes('claude-fable-5-1'), cursorRow(lines))
}

section('§3 letters typed in the rows go to the search; the row keys are chords')
{
  await board.type('sonnet')
  check('typing in the rows lands in the box and the title counts the matches', box(board.lines()) === '/ sonnet' && title(board.lines()) === 'Mercury · model · 1 of 7 match' && legend(board.lines()).includes('type to search'), `${box(board.lines())} · ${title(board.lines())}`)
  check('no letter of sonnet fired a key: nothing selected, nothing closed, no window notice', selected.length === 0 && closed === 0 && !board.frame().includes('ctx ·'))
  await board.key('escape')
  await board.key('tab')
  check('esc clears the typed search and tab hands the rows back', box(board.lines()) === '/ type to search by name or id' && legend(board.lines()) === words.MODEL_PICKER_HINT, `${box(board.lines())} · ${legend(board.lines())}`)
  await board.key('w', 'w', true)
  check('ctrl+w in the rows answers for the focused row (the context law), not the box', board.frame().includes('ctx ·') && box(board.lines()) === '/ type to search by name or id', board.lines().filter(line => line.includes('ctx ·')).map(inner).join(' | '))
}

section('§4 tab moves into the box: typing searches, the counts follow every key, ↑↓ walk the matches')
{
  await board.key('tab')
  check('tab focuses the box: the placeholder swaps and the legend says type to search · tab back to the rows', box(board.lines()) === '/ search by name or id' && legend(board.lines()).includes('type to search') && legend(board.lines()).includes('tab back to the rows'), `${box(board.lines())} · ${legend(board.lines())}`)
  await board.type('s')
  check('one letter narrows at once: the title counts the matches', /^Mercury · model · \d+ of 7 match$/.test(title(board.lines())), title(board.lines()))
  const afterS = Number(/· (\d+) of 7 match$/.exec(title(board.lines()))?.[1] ?? -1)
  await board.type('o')
  const afterSo = Number(/· (\d+) of 7 match$/.exec(title(board.lines()))?.[1] ?? -1)
  check('the next letter narrows further (so: Sonnet 5 and GPT-6 Sol)', afterS > afterSo && afterSo === 2, `${afterS} → ${afterSo}`)
  check('each heading counts its own matches of its own rows', inner(lineWith(board.lines(), 'ANTHROPIC')).trim().endsWith('· 1 of 4') && inner(lineWith(board.lines(), 'OPENAI')).trim().endsWith('· 1 of 3'), `${inner(lineWith(board.lines(), 'ANTHROPIC')).trim()} | ${inner(lineWith(board.lines(), 'OPENAI')).trim()}`)
  check('the box shows the search and the cursor sits on the first match', box(board.lines()) === '/ so' && cursorRow(board.lines()).includes('claude-sonnet-5'), `${box(board.lines())} · ${cursorRow(board.lines())}`)
  check('the legend while searching ends esc clears the search', legend(board.lines()).endsWith('esc clears the search'), legend(board.lines()))
  await board.key('down')
  check('↓ walks on without leaving the box: the next stop is the OPENAI heading', board.lines().some(line => /❯ OPENAI ·/.test(line)) && legend(board.lines()).includes('type to search'), lineWith(board.lines(), 'OPENAI'))
  await board.key('down')
  check('↓ again reaches the next match', cursorRow(board.lines()).includes('gpt-6-sol'), cursorRow(board.lines()))
  await board.key('backspace')
  check('⌫ widens the search again', box(board.lines()) === '/ s' && Number(/· (\d+) of 7 match$/.exec(title(board.lines()))?.[1]) === afterS, `${box(board.lines())} · ${title(board.lines())}`)
  await board.type('o')
  check('/ typed in the box is search text, not a key', (await board.key('/', '/'), box(board.lines()) === '/ so/'), box(board.lines()))
  await board.key('backspace')
}

section('§5 tab again returns to the rows with the search kept')
{
  await board.key('tab')
  check('the legend is the rows’ own again, with esc clears the search as its tail', legend(board.lines()).includes('ctrl+w context') && !legend(board.lines()).includes('type to search') && legend(board.lines()).endsWith('esc clears the search'), legend(board.lines()))
  check('the search stands: the box shows it, the title counts, only the matches are listed', box(board.lines()) === '/ so' && title(board.lines()) === 'Mercury · model · 2 of 7 match' && !board.frame().includes('claude-fable-5-1'), `${box(board.lines())} · ${title(board.lines())}`)
  await board.type('x')
  check('a letter typed in the rows joins the kept search and hands the box focus', box(board.lines()) === '/ sox' && legend(board.lines()).includes('type to search'), `${box(board.lines())} · ${legend(board.lines())}`)
  await board.key('backspace')
  await board.key('tab')
  check('⌫ takes it back and tab returns to the rows with the search kept', box(board.lines()) === '/ so' && !legend(board.lines()).includes('type to search'), `${box(board.lines())} · ${legend(board.lines())}`)
  await board.key('down')
  await board.key('down')
  check('↑↓ still walk the matches from the rows', cursorRow(board.lines()).includes('gpt-6-sol'), cursorRow(board.lines()))
  await board.key('up')
  await board.key('up')
  check('and back', cursorRow(board.lines()).includes('claude-sonnet-5'), cursorRow(board.lines()))
  await board.key('return')
  check('↵ in the rows switches to the match', selected.length === 1 && selected[0] === 'claude-sonnet-5', selected.join(','))
}

section('§6 escape clears the search before it closes the picker, from either side; / is the second way in')
{
  await board.key('escape')
  check('esc in the rows with a search standing clears it and keeps the picker (the rows keep focus)', closed === 0 && box(board.lines()) === '/ type to search by name or id' && title(board.lines()) === 'Mercury · model' && legend(board.lines()) === words.MODEL_PICKER_HINT, `${box(board.lines())} · ${legend(board.lines())}`)
  check('the cleared search leaves the cursor on the row it focused', cursorRow(board.lines()).includes('claude-sonnet-5'), cursorRow(board.lines()))
  await board.key('/', '/')
  check('/ in the rows is the second way into the box', legend(board.lines()).includes('type to search') && box(board.lines()) === '/ search by name or id', legend(board.lines()))
  await board.type('gpt')
  check('the search narrows to the three GPT rows', title(board.lines()) === 'Mercury · model · 3 of 7 match', title(board.lines()))
  await board.key('escape')
  check('esc in the box with a search standing clears it and keeps the box focused', closed === 0 && box(board.lines()) === '/ search by name or id' && title(board.lines()) === 'Mercury · model' && legend(board.lines()).includes('type to search'), `${box(board.lines())} · ${legend(board.lines())}`)
  await board.key('escape')
  check('esc in the empty box closes the picker', closed === 1, `closed ${closed}`)
  board.close()
}

section('§7 esc in the rows with no search closes at once')
{
  const fresh = await mount(80, 24)
  await fresh.key('escape')
  check('one esc closes a picker with nothing searched', closed === 2, `closed ${closed}`)
  fresh.close()
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ the model picker’s search: type or tab in, tab back, esc clears then closes' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
