#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'picker-anthropic-section-'))
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
  'MERCURY_MOONSHOT_API_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_ZAI_API_BASE',
]) {
  process.env[base] = 'http://127.0.0.1:1'
}
const FIXTURE_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_API_KEY = FIXTURE_KEY
;(await import('../../src/utils/config.js')).enableConfigs()

const React = (await import('react')).default
const { render } = await import('../../src/ink.ts')
const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.tsx')
const { createStore } = await import('../../src/state/store.ts')
const { call } = await import('../../src/commands/model/mercuryModel.tsx')
const { ANTHROPIC_CONNECT_OPTION_VALUE, getModelOptions, isProviderActionRow, stripContext1m } = await import('../../src/utils/model/modelOptions.ts')
type ModelOption = import('../../src/utils/model/modelOptions.ts').ModelOption
const { FAMILY_GENERATIONS, parseFirstPartyGeneration } = await import('../../src/utils/model/configs.ts')
const { getModelStrings } = await import('../../src/utils/model/modelStrings.ts')
const { parseUserSpecifiedModel, renderModelName } = await import('../../src/utils/model/model.ts')
const { clearOAuthTokenCache, isClaudeAISubscriber, isMaxSubscriber } = await import('../../src/utils/auth.ts')
const anthropicCatalogue = await import('../../src/services/providers/anthropic/anthropicCatalogue.ts')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
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

const strings = getModelStrings()
const OPUS_BLOCK = FAMILY_GENERATIONS.opus.map(key => strings[key])
const DEFAULT_OPUS = OPUS_BLOCK[0]!
const PREVIOUS_OPUS = OPUS_BLOCK[1]!
const OLDEST_OPUS = OPUS_BLOCK.at(-1)!
const SONNET = strings[FAMILY_GENERATIONS.sonnet[0]]
const HAIKU = strings[FAMILY_GENERATIONS.haiku[0]]
const LAST_FABLE = strings[FAMILY_GENERATIONS.fable.at(-1)!]
const RAW = 'claude-opus-5-7'
const ANTHROPIC_TITLE = 'MERCURY — ANTHROPIC MODELS'

const anthropicRows = (options: ModelOption[]): ModelOption[] =>
  options.filter(o => o.group === undefined && !isProviderActionRow(o.value) && !o.value.startsWith('__'))
const resolvedIds = (options: ModelOption[]): string[] => anthropicRows(options).map(o => parseUserSpecifiedModel(stripContext1m(o.value)))
const familyOf = (id: string): string => parseFirstPartyGeneration(id)?.family ?? 'unknown'
const blocksOf = (ids: string[]): string[] => ids.map(familyOf).filter((family, index, all) => index === 0 || all[index - 1] !== family)
const show = (ids: string[]): string => ids.map(id => renderModelName(id)).join(' · ')

function pinSection(tag: string, options: ModelOption[], shape: 'standard' | 'premium'): void {
  const ids = resolvedIds(options)
  const at = (id: string): number => ids.indexOf(id)
  const opus = ids.filter(id => familyOf(id) === 'opus')
  check(`[${tag}] the default Opus leads the opus block: ${renderModelName(DEFAULT_OPUS)} is the first opus row, ${renderModelName(PREVIOUS_OPUS)} right after it`, opus[0] === DEFAULT_OPUS && at(PREVIOUS_OPUS) === at(DEFAULT_OPUS) + 1, show(ids))
  check(`[${tag}] the opus block reads the generation table newest first: ${show(OPUS_BLOCK)}`, opus.join(',') === OPUS_BLOCK.join(','), show(opus))
  const blocks = blocksOf(ids)
  check(`[${tag}] every family's rows form one block (fable · sonnet · opus · haiku each contiguous)`, new Set(blocks).size === blocks.length && ['fable', 'sonnet', 'opus', 'haiku'].every(family => blocks.includes(family)), blocks.join(' → '))
  check(`[${tag}] the section ends on the small family's row, never on the default Opus`, ids.at(-1) === HAIKU && at(DEFAULT_OPUS) < ids.length - 1, show(ids))
  if (shape === 'standard') {
    check(`[${tag}] Sonnet 5 keeps the standard tier's place: after the fable block, right before the default Opus`, at(SONNET) === at(LAST_FABLE) + 1 && at(DEFAULT_OPUS) === at(SONNET) + 1, show(ids))
  } else {
    check(`[${tag}] Sonnet 5 keeps the premium tier's place: right after the opus block, before Haiku`, at(SONNET) === at(OLDEST_OPUS) + 1 && at(HAIKU) === at(SONNET) + 1, show(ids))
  }
  const rows = anthropicRows(options)
  const values = rows.map(o => o.value)
  const explicit = rows.find(o => o.value === DEFAULT_OPUS)
  check(`[${tag}] the family words still fold onto the explicit rows: no 'opus' or 'sonnet' value; the literal ids carry the labels ${renderModelName(DEFAULT_OPUS)} and ${renderModelName(SONNET)}, selectable`, !values.includes('opus') && !values.includes('sonnet') && explicit !== undefined && explicit.label === renderModelName(DEFAULT_OPUS) && explicit.unavailable === undefined && rows.find(o => o.value === SONNET)?.label === renderModelName(SONNET), values.join(','))
  check(`[${tag}] one row per model`, new Set(ids).size === ids.length, ids.join(','))
}

section('§1 the standard shape (an API key): the default Opus leads its block; the section runs in family blocks, newest first')
pinSection('api key', getModelOptions({ anthropicCredentialed: () => true }), 'standard')

section('§2 a live undeclared opus generation lands at the end of the opus block, never at the end of the section')
{
  const options = getModelOptions({ anthropicCredentialed: () => true, anthropicLiveRows: () => [{ id: RAW, doors: ['Anthropic API key'] }] })
  const ids = resolvedIds(options)
  const at = (id: string): number => ids.indexOf(id)
  check(`the raw row follows the last declared opus row (${renderModelName(OLDEST_OPUS)}), inside the opus block`, at(RAW) === at(OLDEST_OPUS) + 1, show(ids))
  check('the default Opus still leads the block and the section still ends on the small family', ids.filter(id => familyOf(id) === 'opus')[0] === DEFAULT_OPUS && ids.at(-1) === HAIKU, show(ids))
  const signedOut = getModelOptions({ anthropicCredentialed: () => false })
  check('the not-signed-in projection keeps the same order behind the sign-in row', signedOut.find(o => o.group === undefined)?.value === ANTHROPIC_CONNECT_OPTION_VALUE && resolvedIds(signedOut).join(',') === resolvedIds(getModelOptions({ anthropicCredentialed: () => true })).join(','), show(resolvedIds(signedOut)))
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
function signInMax(): void {
  delete process.env.ANTHROPIC_API_KEY
  writeFileSync(join(home, '.credentials.json'), JSON.stringify(MAX_CREDENTIAL), { mode: 0o600 })
  clearOAuthTokenCache()
}
function signOutMax(): void {
  rmSync(join(home, '.credentials.json'), { force: true })
  clearOAuthTokenCache()
  process.env.ANTHROPIC_API_KEY = FIXTURE_KEY
}

section('§3 the premium shape (a Max subscription): the same block law under the premium tier order')
{
  signInMax()
  check('the staged credential reads as a Max subscription (the premium tier composes)', isClaudeAISubscriber() && isMaxSubscriber())
  pinSection('max subscription', getModelOptions({ anthropicCredentialed: () => true }), 'premium')
  signOutMax()
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 150))
const lineUnder = (lines: string[], title: string): string => {
  const at = lines.findIndex(l => l.includes(title))
  if (at < 0) return ''
  const col = lines[at]!.indexOf(title)
  const right = lines[at]!.indexOf('│', col)
  return (lines[at + 1] ?? '').slice(col, right > col ? right : undefined).trim()
}
const rowAt = (lines: string[], name: string): number => lines.findIndex(l => l.includes(`${name} `) && /\b(current|switch|unavail|next|gated)\b/.test(l))
type Band = { columns: number; rows: number; pendingNext?: string }
async function mountModel(model: string, band: Band = { columns: 178, rows: 51 }): Promise<{ frame: () => string; press: (keys: string, expectChange?: boolean) => Promise<boolean>; unmount: () => void }> {
  const stdout = Object.assign(new PassThrough(), { columns: band.columns, rows: band.rows })
  stdout.resume()
  const input: string[] = []
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return input.shift() ?? null }, readableLength: 0, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } })
  const store = createStore({ ...getDefaultAppState(), mainLoopModel: model, ...(band.pendingNext === undefined ? {} : { pendingModelSwitch: { setting: band.pendingNext } }) }, () => {})
  const picker = await call(() => {}, { messages: [] } as never, '')
  const instance = await render(React.createElement(AppStoreContext.Provider, { value: store }, picker), { stdout: stdout as never, stdin: stdin as never, patchConsole: false })
  const frame = (): string => stripAnsi(instance.lastFrame()).replace(/\n$/, '')
  const settled = (): boolean => {
    const lines = frame().split('\n')
    return rowAt(lines, renderModelName(DEFAULT_OPUS)) >= 0 && /^\s*╰/.test(lines.at(-1) ?? '')
  }
  const until = Date.now() + 5000
  while (Date.now() < until && !settled()) await flush()
  await flush()
  await flush()
  const press = async (keys: string, expectChange = true): Promise<boolean> => {
    const before = frame()
    input.push(keys)
    stdin.emit('readable')
    const deadline = Date.now() + (expectChange ? 2000 : 150)
    while (Date.now() < deadline && frame() === before) await new Promise<void>(resolve => setTimeout(resolve, 20))
    await new Promise<void>(resolve => setTimeout(resolve, 40))
    return frame() !== before
  }
  return { frame, press, unmount: () => instance.unmount() }
}

section('§4 the /model surface at 178x51 with a signed-in Anthropic fixture: the header word and the painted order')
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request) => {
  const spelled = String(url instanceof Request ? url.url : url)
  if (spelled.includes('/v1/models')) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fixture: no list here' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected request: ${spelled}`)
}) as typeof fetch
for (const fixture of ['anthropic-key', 'claude-max'] as const) {
  if (fixture === 'claude-max') signInMax()
  anthropicCatalogue.__resetAnthropicCatalogueForTest()
  const expected = resolvedIds(getModelOptions({ anthropicCredentialed: () => true })).map(id => renderModelName(id))
  const mounted = await mountModel(DEFAULT_OPUS)
  const frame = mounted.frame()
  const lines = frame.split('\n')
  if (frameDir !== undefined) writeFileSync(join(frameDir, `model-178x51-${fixture}.txt`), frame + '\n')
  const painted = expected.map(name => rowAt(lines, name))
  console.log(`  [record] ${fixture}: under the title "${lineUnder(lines, ANTHROPIC_TITLE)}" · rows top to bottom: ${[...expected.keys()].sort((a, b) => painted[a]! - painted[b]!).map(index => expected[index]).join(' · ')}`)
  check(`[${fixture}] the frame fits 178x51`, lines.length <= 51 && lines.every(line => stringWidth(line) <= 178), `${lines.length} lines · widest ${Math.max(...lines.map(line => stringWidth(line)))}`)
  check(`[${fixture}] the Anthropic section is on screen whole: its title and every row`, lines.some(l => l.includes(ANTHROPIC_TITLE)) && painted.every(index => index >= 0), expected.filter((_, index) => painted[index]! < 0).join(' · ') || 'all painted')
  check(`[${fixture}] the line under the Anthropic title reads signed in alone`, lineUnder(lines, ANTHROPIC_TITLE) === 'signed in', lineUnder(lines, ANTHROPIC_TITLE))
  const opusLines = OPUS_BLOCK.map(id => rowAt(lines, renderModelName(id)))
  check(`[${fixture}] the painted opus rows run ${show(OPUS_BLOCK)}, top to bottom`, opusLines.every((index, position) => index >= 0 && (position === 0 || index > opusLines[position - 1]!)), opusLines.join(','))
  const first = Math.min(...opusLines)
  const last = Math.max(...opusLines)
  const between = lines.slice(first, last + 1)
  const others = expected.filter(name => !OPUS_BLOCK.some(id => renderModelName(id) === name))
  check(`[${fixture}] no row of another family paints inside the opus block`, first >= 0 && !between.some(l => others.some(name => l.includes(`${name} `))), between.map(l => l.trim()).join(' | '))
  check(`[${fixture}] the painted order is the row source's order`, painted.every((index, position) => index >= 0 && (position === 0 || index > painted[position - 1]!)), painted.join(','))
  check(`[${fixture}] the current mark sits on the default Opus row`, (lines[rowAt(lines, renderModelName(DEFAULT_OPUS))] ?? '').includes('current'), lines[rowAt(lines, renderModelName(DEFAULT_OPUS))])
  mounted.unmount()
  if (fixture === 'claude-max') signOutMax()
}

section('§5 the box spans its band whatever the cursor\'s row: from the first row to the last the bottom border is one row, and the more marker keeps the bottom edge of the rows')
{
  anthropicCatalogue.__resetAnthropicCatalogueForTest()
  const total = getModelOptions().length
  const mounted = await mountModel(DEFAULT_OPUS)
  const bottomOf = (lines: string[]): number => lines.map(l => l.includes('╰')).lastIndexOf(true)
  const meterOf = (lines: string[]): number => lines.findIndex(l => /^\s*│ context /.test(l))
  const markerOf = (lines: string[]): number => lines.findIndex(l => /│\s+↓ \d+ more/.test(l))
  const aboveOf = (lines: string[]): number => lines.findIndex(l => /│\s+↑ \d+ more/.test(l))
  const focusOf = (lines: string[]): string => (lines.find(l => l.includes('│ │ ')) ?? '').split('│ │ ')[1]?.replace(/\s+│.*$/, '').trim() ?? ''
  type Stop = { row: number; lines: number; bottom: number; marker: number; above: number; meter: number; focus: string }
  const walk: Stop[] = []
  const record = (row: number): void => {
    const lines = mounted.frame().split('\n')
    walk.push({ row, lines: lines.length, bottom: bottomOf(lines), marker: markerOf(lines), above: aboveOf(lines), meter: meterOf(lines), focus: focusOf(lines) })
  }
  record(-1)
  check('Home moves the cursor to the first row (the frame repaints)', await mounted.press('\x1b[H'))
  record(0)
  let delivered = true
  for (let row = 1; row < total; row++) {
    delivered = (await mounted.press('\x1b[B')) && delivered
    record(row)
  }
  check(`every ↓ of the ${total - 1} moved the focus (each keypress repainted)`, delivered)
  check('End on the last row changes nothing: the walk reached the end of the list', !(await mounted.press('\x1b[F', false)))
  const first = walk.find(stop => stop.row === 0)!
  const last = walk.at(-1)!
  const served = walk[0]!
  console.log(`  [record] rows ${total} · bottom border rows over the walk: ${[...new Set(walk.map(stop => stop.bottom))].join(',')} · heights: ${[...new Set(walk.map(stop => stop.lines))].join(',')} · first focus "${first.focus}" · last focus "${last.focus}"`)
  check('the first frame has rows below and none above; the last has rows above and none below (the list overflows both ways)', first.marker >= 0 && first.above === -1 && last.above >= 0 && last.marker === -1, `first ${first.marker}/${first.above} · last ${last.marker}/${last.above}`)
  check('the bottom border is one row on the served row, on the first row, on the first available row and on the last', new Set(walk.map(stop => stop.bottom)).size === 1, walk.map(stop => `${stop.row}:${stop.bottom}`).join(' '))
  check('the box spans the 51 rows at every cursor position', walk.every(stop => stop.lines === 51 && stop.bottom === 50), walk.filter(stop => stop.lines !== 51 || stop.bottom !== 50).map(stop => `${stop.row}:${stop.lines}/${stop.bottom}`).join(' '))
  check('wherever the ↓ marker paints it sits on the bottom edge of the rows, right above the meter block', walk.every(stop => stop.meter >= 0 && (stop.marker === -1 || stop.marker === stop.meter - 2)), walk.filter(stop => stop.meter < 0 || (stop.marker !== -1 && stop.marker !== stop.meter - 2)).map(stop => `${stop.row}:${stop.marker}/${stop.meter}`).join(' '))
  check('the walk started on the served default Opus, stopped once per row and ended on a different row', served.focus.startsWith(renderModelName(DEFAULT_OPUS)) && walk.length === total + 1 && last.focus !== first.focus && last.focus !== served.focus, `${served.focus} · ${walk.length - 1} of ${total} · last "${last.focus}"`)
  mounted.unmount()
}

section('§6 the chrome lines that wrap are paid for: a queued switch, a narrow panel, a long next name and the compact tier all keep the bottom border inside the band')
{
  const LONG_NEXT = 'claude-opus-5-7-extended-thinking-long-context-preview'
  const bands: Array<Band & { label: string }> = [
    { label: 'queued-178x51', columns: 178, rows: 51, pendingNext: SONNET },
    { label: 'narrow-50x30', columns: 50, rows: 30 },
    { label: 'long-next-178x51', columns: 178, rows: 51, pendingNext: LONG_NEXT },
    { label: 'compact-queued-50x18', columns: 50, rows: 18, pendingNext: SONNET },
  ]
  for (const band of bands) {
    anthropicCatalogue.__resetAnthropicCatalogueForTest()
    const mounted = await mountModel(DEFAULT_OPUS, band)
    const frame = mounted.frame()
    const lines = frame.split('\n')
    if (frameDir !== undefined) writeFileSync(join(frameDir, `model-${band.label}.txt`), frame + '\n')
    const bottom = lines.map(l => /^\s*╰/.test(l)).lastIndexOf(true)
    const widest = Math.max(...lines.map(line => stringWidth(line)))
    console.log(`  [record] ${band.label}: ${lines.length} lines · bottom border on row ${bottom} · widest ${widest} · band ${band.columns}x${band.rows}`)
    check(`[${band.label}] the frame fits the band: at most ${band.rows} rows, no line wider than ${band.columns}`, lines.length <= band.rows && widest <= band.columns, `${lines.length} lines · widest ${widest}`)
    check(`[${band.label}] the bottom border is the last row and sits inside the band`, bottom >= 0 && bottom === lines.length - 1 && bottom < band.rows, `bottom ${bottom} of ${lines.length}`)
    check(`[${band.label}] the footer keeps its exit word right above the border`, (lines[bottom - 1] ?? '').includes('esc close'), lines[bottom - 1] ?? '')
    check(`[${band.label}] the current row is on screen`, rowAt(lines, renderModelName(DEFAULT_OPUS)) >= 0)
    if (band.pendingNext !== undefined) {
      const nextName = band.pendingNext === LONG_NEXT ? LONG_NEXT : renderModelName(band.pendingNext)
      const inner = (line: string): string => (/^\s*│(.*)│\s*$/.exec(line)?.[1] ?? line).trim()
      const head = lines.findIndex(l => l.includes(`current ${renderModelName(DEFAULT_OPUS)} `))
      const spoken = lines.slice(Math.max(0, head), head + 4).map(inner).join(' ')
      check(`[${band.label}] the queued switch reads whole across its wrapped lines: current, the next name and the settle note, nothing cut`, head >= 0 && spoken.includes(`next ${nextName} · applies when the turn settles`), spoken)
    }
    mounted.unmount()
  }
}
globalThis.fetch = realFetch

section('§7 the seam: the header composer\'s credentialed arm')
{
  const builder = readFileSync(join(import.meta.dir, '..', '..', 'src/commands/model/mercuryModel.tsx'), 'utf8')
  check("groupDetailsOf answers 'signed in' on the credentialed arm and 'credential present' nowhere", builder.includes("anthropicPresence.credentialed\n          ? 'signed in'\n          : anthropicNotSignedInReason()") && !builder.includes("'credential present'"))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-picker-anthropic-section: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
