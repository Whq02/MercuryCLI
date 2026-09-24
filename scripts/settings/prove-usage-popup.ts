import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import type { DOMElement, DOMNode } from '../../src/ink/dom.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const localeString = Date.prototype.toLocaleString
Date.prototype.toLocaleString = function (_locales, options) { return localeString.call(this, 'en-US', { ...options, timeZone: 'UTC' }) }
const ROOT = join(import.meta.dir, '../..')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const counts = new Map<string, number>()
let heldRefresh: Promise<void> | undefined
let rich = false
let subscriber = false
const ids = ['anthropic', 'openai', 'gemini', 'moonshot', 'huggingface', 'deepseek', 'zai', 'openrouter', 'openai-compat', 'local']
const spend = { inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }
const windows = [
  { key: '5h', label: '5h', usedPct: 52, resetsAtMs: 1_800_010_000_000, source: 'endpoint', observedAtMs: 1_800_000_000_000, state: 'live' },
  { key: '7d', label: 'wk', usedPct: 49, resetsAtMs: 1_800_500_000_000, source: 'endpoint', observedAtMs: 1_800_000_000_000, state: 'live' },
]
const pools = [
  { ...windows[1], key: 'seven_day_fable', label: 'Fable', usedPct: 46 },
  { ...windows[1], key: 'seven_day_opus', label: 'Opus', usedPct: 12 },
]
const families = () => ids.map(id => ({ id, available: false, credentialed: rich && ['anthropic', 'openai', 'gemini', 'deepseek'].includes(id), credentialLabel: `${id} fixture key` }))
const entries = () => rich ? [
  { id: 'anthropic:oauth', provider: 'anthropic', kind: 'subscription-oauth', label: 'Claude subscription' },
  { id: 'openai:oauth', provider: 'openai', kind: 'subscription-oauth', label: 'ChatGPT subscription' },
  { id: 'gemini:oauth', provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' },
] : []
const owner = (id: string) => ({ provider: id, sourceKind: 'none', windows: [], figures: [], absence: undefined })
await stub('../../src/services/providers/providerUsage.js', () => ({
  providerFamilyPresences: families,
  providerSessionSpend: () => spend,
  providerUsageView: (id: string) => ({ entries: entries().filter(entry => entry.provider === id), activeEntry: entries().find(entry => entry.provider === id), sessionSpend: spend, limits: { kind: 'none' } }),
  refreshProviderUsage: async (id: string, options: { reason: string }) => { const key = `${id}:${options.reason}`; counts.set(key, (counts.get(key) ?? 0) + 1); if (id === 'anthropic') await heldRefresh },
  usageForProvider: owner,
  usageCreditsLine: () => undefined,
  anthropicWindowViews: () => subscriber ? windows : [],
  anthropicPoolWindowViews: () => subscriber ? pools : [],
  openaiObservedWindowViews: () => [],
}))
await stub('../../src/utils/auth.js', () => ({ isClaudeAISubscriber: () => subscriber }))
await stub('../../src/utils/model/computedDefault.js', () => ({ recentSignIns: () => ids.map(family => ({ family })) }))
await stub('../../src/services/wallet/wallet.js', () => ({ walletEntries: entries, activeWalletEntry: (id: string) => entries().find(entry => entry.provider === id) }))
await stub('../../src/services/providers/usageFreshness.js', () => ({ usageSourceWords: () => 'endpoint-fed · read 0 s ago' }))
await stub('../../src/services/providers/openai/openaiCatalogue.js', () => ({ getGptSeatAvailability: () => ({ state: 'ready', ids: ['fixture-model'] }) }))
await stub('../../src/services/providers/catalogueOnDemand.js', () => ({ readCatalogueIfPending: async () => undefined }))
await stub('../../src/hooks/useCatalogueEpoch.js', () => ({ useCatalogueEpoch: () => 0 }))
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined }))
await stub('../../src/services/providers/moonshot/moonshotAccounts.js', () => ({ resolveMoonshotAccount: () => undefined, resolveMoonshotApiKey: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceAccounts.js', () => ({ resolveHuggingfaceAccount: () => undefined }))
await stub('../../src/services/providers/huggingface/huggingfaceCatalogue.js', () => ({ getHuggingfaceAvailability: () => ({ state: 'absent', liveIds: [], reason: 'not connected' }) }))
await stub('../../src/services/providers/huggingface/huggingfaceCallModel.js', () => ({ HUGGINGFACE_UNVERIFIED_NOTE: 'not verified' }))
await stub('../../src/services/providers/local/localDiscovery.js', () => ({ getCachedLocalDiscovery: () => undefined }))
await stub('../../src/services/providers/local/localAccounts.js', () => ({ resolveLocalAccount: () => undefined }))
await stub('../../src/services/providers/local/localCatalogue.js', () => ({ LOCAL_SERVER_NAMES: {} }))
await stub('../../src/cost-tracker.js', () => ({ formatLaneSpend: () => '$0.00' }))
await stub('../../src/components/ConfigurableShortcutHint.js', () => ({ ConfigurableShortcutHint: () => null }))
await stub('../../src/components/Settings/Settings.js', () => ({ nextSettingsOpen: (() => { let n = 0; return () => ++n })() }))

const { Usage, usageColumns, usageWindow } = await import('../../src/components/Settings/Usage.js')
const { Box, render, flushPendingSyncWork, EventEmitter, InputEvent, elementScreenTop, elementScreenLeft, wrapText } = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { default: squashText } = await import('../../src/ink/squash-text-nodes.js')
let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
const settle = async () => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
function textRuns(node: DOMNode): string[] {
  if (node.nodeName === '#text') return []
  if (node.nodeName === 'ink-text') return [squashText(node)]
  return node.childNodes.flatMap(textRuns)
}
function sectionSizes(node: DOMNode): Array<{ title: string; width: number; height: number; x: number; y: number }> {
  if (node.nodeName === '#text') return []
  const first = node.childNodes[0]
  if (first?.nodeName === 'ink-text' && squashText(first).endsWith(' usage')) {
    return [{ title: squashText(first), width: node.layoutNode?.getComputedWidth() ?? 0, height: node.layoutNode?.getComputedHeight() ?? 0, x: elementScreenLeft(node), y: elementScreenTop(node) }]
  }
  return node.childNodes.flatMap(sectionSizes)
}
async function mount(width: number, rowBudget: number, columns: number, openToken: number) {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: columns === 178 ? 51 : 40 }) as unknown as NodeJS.WriteStream
  const root = React.createRef<DOMElement>()
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = (w: number, budget: number) => React.createElement(StdinContext.Provider, { value: context }, React.createElement(Box, { ref: root, flexDirection: 'column' }, React.createElement(Usage, { width: w, rowBudget: budget, openToken } as never)))
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(node(width, rowBudget), { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  return {
    frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, ''),
    sizes: () => root.current ? sectionSizes(root.current) : [],
    viewport: () => {
      const body = root.current?.childNodes[0] as DOMElement | undefined
      const area = body?.childNodes[0] as DOMElement | undefined
      const clip = area?.childNodes[0] as DOMElement | undefined
      return { height: body?.layoutNode?.getComputedHeight() ?? 0, clip: clip?.layoutNode?.getComputedHeight() ?? 0 }
    },
    runs: () => root.current ? textRuns(root.current).filter(run => run !== '' && !run.startsWith('↓ ') && !/^[ \u2580-\u259f]+$/u.test(run)) : [],
    meters: () => root.current ? textRuns(root.current).filter(run => /^[ \u2580-\u259f]+$/u.test(run)) : [],
    async key(name: string) {
      const event = new InputEvent({ name, sequence: '', ctrl: false, shift: false, fn: false, meta: false, option: false, super: false, isPasted: false } as never)
      emitter.emit('input', event)
      await settle()
      return event.didStopImmediatePropagation()
    },
    async resize(w: number, budget: number) { instance.rerender(node(w, budget)); await settle() },
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}

const src = readFileSync(join(ROOT, 'src/components/Settings/Usage.tsx'), 'utf8')
check('the body and meters never read terminal dimensions', !src.includes('useTerminalSize'))
check('146 gives three 46-cell columns, four-cell gaps and 42-cell bars', JSON.stringify(usageColumns(146, 10)) === JSON.stringify({ perRow: 3, colW: 46, meterW: 42, gap: 4 }))
check('116 keeps the stacked layout', usageColumns(116, 10).perRow === 1)
let token = 100
const frameDir = arg('--frames')
const record = arg('--record-words')
const sameWhen = (runs: string[]): string[] => runs.map(run => run.replace(/resets .+$/, 'resets <when>'))
const baseline = Object.fromEntries(Object.entries(JSON.parse(readFileSync(arg('--compare-words') ?? join(import.meta.dir, 'usage-popup-words.json'), 'utf8')) as Record<string, string[]>).map(([k, v]) => [k, sameWhen(v)]))
const wordRecords: Record<string, string[]> = {}
async function walk(board: Awaited<ReturnType<typeof mount>>, width: number, budget: number, label: string, save?: string): Promise<void> {
  const history: string[] = []
  const covered = board.sizes().map(() => new Set<number>())
  const expectedStops: number[] = []
  const sizes = board.sizes()
  const perRow = width >= 120 ? 3 : 1
  const capacity = budget - (budget > 1 ? 1 : 0)
  let bandTop = 0
  for (let index = 0; index < sizes.length; index += perRow) {
    const height = Math.max(...sizes.slice(index, index + perRow).map(section => section.height))
    for (let row = 0; row <= Math.max(0, height - capacity); row++) expectedStops.push(bandTop + row)
    bandTop += height + 1
  }
  let allBounds = true
  let allCounts = true
  let allSteps = true
  let consumed = true
  let reached = false
  for (let step = 0; step < expectedStops.length + 1; step++) {
    const frame = board.frame()
    history.push(frame)
    const sections = board.sizes()
    const viewport = board.viewport()
    const visible = sections.filter(section => section.y < viewport.clip && section.y + section.height > 0)
    const below = sections.filter(section => section.y >= viewport.clip)
    const more = below.length ? `↓ ${below.length} more · ${below.map(section => section.title.replace(/ usage$/, '')).join(' · ')}` : ''
    const lines = frame.split('\n')
    allBounds &&= lines.length <= budget && viewport.height <= budget && lines.every(line => stringWidth(line) <= width) && visible.length <= 6
    allCounts &&= (lines[budget - 1] ?? '').trimEnd() === wrapText(more, width, 'truncate-end')
    allSteps &&= sections[0]?.y === -expectedStops[step]
    sections.forEach((section, index) => {
      for (let row = 0; row < section.height; row++) if (section.y + row >= 0 && section.y + row < viewport.clip) covered[index]!.add(row)
    })
    const last = sections.at(-1)!
    reached = last.y >= 0 && last.y + last.height <= viewport.clip
    if (frameDir && save && step === 0) writeFileSync(join(frameDir, `${save}-top.txt`), frame + '\n')
    if (frameDir && save && step === 1) writeFileSync(join(frameDir, `${save}-mid.txt`), frame + '\n')
    if (reached) break
    consumed &&= await board.key('down')
  }
  check(`${label}: every down-step stays inside both budgets with at most six providers`, allBounds)
  check(`${label}: the more count and names are exact at every down-step`, allCounts)
  check(`${label}: arrows move by whole bands that fit, otherwise by content rows`, allSteps)
  check(`${label}: the tenth provider is fully on screen`, reached)
  check(`${label}: every content row of every provider was on screen`, covered.every((rows, index) => rows.size === sizes[index]!.height))
  if (frameDir && save) writeFileSync(join(frameDir, `${save}-bottom.txt`), board.frame() + '\n')
  consumed &&= await board.key('down')
  check(`${label}: the bottom clamps without shifting the last view`, board.frame() === history.at(-1))
  let reversed = true
  for (let index = history.length - 2; index >= 0; index--) {
    consumed &&= await board.key('up')
    reversed &&= board.frame() === history[index]
  }
  consumed &&= await board.key('up')
  check(`${label}: every up-step exactly reverses the down-step, including names`, reversed && board.frame() === history[0])
  check(`${label}: only scroll arrows are consumed`, consumed && !(await board.key('escape')) && !(await board.key('x')))
}
for (const fixture of ['absent', 'signed-in']) {
  rich = fixture === 'signed-in'
  subscriber = rich
  const before = counts.get('anthropic:operator') ?? 0
  const board = await mount(146, 22, 178, token++)
  wordRecords[fixture] = sameWhen(board.runs().sort())
  check(`${fixture}: every provider mounts without an error`, board.sizes().length === 10 && !board.frame().includes('RENDER ERROR'))
  check(`${fixture}: the section text runs equal the original tab byte for byte`, JSON.stringify(wordRecords[fixture]) === JSON.stringify(baseline[fixture]))
  const headings = board.frame().split('\n')[0] ?? ''
  check(`${fixture}: columns start at exactly 0, 50 and 100`, headings.indexOf('Anthropic usage') === 0 && headings.indexOf('OpenAI usage') === 50 && headings.indexOf('Gemini usage') === 100)
  if (rich) {
    const bars = board.meters()
    check('the painted meters are 42 cells, including both weekly pools', bars.length === 4 && bars.every(bar => stringWidth(bar) === 42 && board.frame().split('\n').some(line => line.slice(0, 42).padEnd(42) === bar)))
  } else {
    check('six providers at the top leave the exact four names from the design', board.frame().includes('↓ 4 more · Z.AI · OpenRouter · Custom endpoint · Local models'))
  }
  console.log(`${fixture} section sizes: ${JSON.stringify(board.sizes())}`)
  await walk(board, 146, 22, `${fixture} 178×51`, `${fixture}-178x51`)
  await board.resize(116, 22)
  check(`${fixture}: the clamped layout stacks at x=0`, board.sizes().every(section => section.x === 0 && section.width === 116))
  await walk(board, 116, 22, `${fixture} 120×40`, `${fixture}-120x40`)
  await board.resize(146, 8)
  await walk(board, 146, 8, `${fixture} short body`)
  await board.resize(40, 13)
  await walk(board, 40, 13, `${fixture} narrow body`)
  check(`${fixture}: resize and scrolling never repeat the operator ask`, (counts.get('anthropic:operator') ?? 0) - before === (rich ? 1 : 0))
  board.close()
}
if (record) writeFileSync(record, JSON.stringify(wordRecords, null, 2) + '\n')
rich = true
subscriber = true
let releaseRefresh = (): void => {}
heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve })
const delayed = await mount(146, 22, 178, token++)
check('a pending read keeps its loading words', delayed.frame().includes('loading usage…'))
releaseRefresh()
await settle()
heldRefresh = undefined
check('an asynchronously taller band updates clipping and the more names without a key', delayed.viewport().clip === 21 && delayed.frame().includes('↓ 7 more · DeepSeek · Moonshot · Hugging Face · Z.AI · OpenRouter · Custom endpoint · Local models'))
await walk(delayed, 146, 22, 'asynchronous band growth')
delayed.close()
for (const budget of [0, 1, 2, 3, 7, 13, 22]) {
  for (const width of [1, 19, 40, 116, 119, 120, 146]) {
    rich = false
    subscriber = false
    const board = await mount(width, budget, 178, token++)
    check(`width ${width}, budget ${budget}: bounds hold`, board.viewport().height <= budget && (budget === 0 ? board.frame().trim() === '' : board.frame().split('\n').length <= budget) && board.frame().split('\n').every(line => stringWidth(line) <= width))
    board.close()
  }
}
const math = [8, 4, 4, 5].map((height, index) => ({ height, count: index === 3 ? 1 : 3 }))
check('the six-provider window advances and retreats symmetrically', usageWindow(math, 21, 0).next === 9 && usageWindow(math, 21, 9).next === 14 && usageWindow(math, 21, 14).previous === 9 && usageWindow(math, 21, 14).next === 14)
const command = (await import('../../src/commands/usage/index.js')).default
check('/usage is ungated, private, screen-local and unavailable non-interactively', command.type === 'local' && command.seat === 'screen' && command.userPrivate === true && command.supportsNonInteractive === false && !('availability' in command))
const popup = await import('../../src/utils/cockpit/settingsPopup.js')
const { call } = await import('../../src/commands/usage/usage.js')
rich = true
subscriber = true
const result = await call('', {} as never)
const request = popup.settingsPopupRequest()
check('/usage opens only its 150×29 popup and returns skip', result.type === 'skip' && request?.view === 'usage' && request.width === 150 && request.rows === 29)
check('the context carries live figures in the design grammar', request?.line === '10 providers · 2 subscriptions signed in · Anthropic session 52% · week 49%')
check('the hint is exactly the design\'s words', request?.hint === '↑↓ scroll · esc or click outside closes')
const body = request?.body({ width: 120, inner: 116, rowBudget: 13 }) as React.ReactElement<{ width: number; rowBudget: number; openToken: number }>
check('the store geometry reaches the body unchanged', body?.props.width === 116 && body?.props.rowBudget === 13)
await call('', {} as never)
const reopened = popup.settingsPopupRequest()?.body({ width: 150, inner: 146, rowBudget: 22 }) as typeof body
check('each open mints a distinct token', reopened.props.openToken !== body.props.openToken)
rich = false
subscriber = false
await call('', {} as never)
check('no credential invents a subscription or a percentage', popup.settingsPopupRequest()?.line === '10 providers · 0 subscriptions signed in')
popup.closeSettingsPopup()
console.log(`usage popup: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
