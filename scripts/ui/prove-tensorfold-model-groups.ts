#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import type { TensorFoldFit, TensorFoldHost, TensorFoldModelRow, TensorFoldServed, TensorFoldEngine, TensorFoldMachine } from '../../src/services/tensorfold/contracts.ts'

const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const FRAMES = argAfter('--frames')
const PNG = process.argv.includes('--png')
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })
const home = pinScratchHome('tensorfold-model-groups')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const GIB = 1024 ** 3
const RUNGS = [32_768, 65_536, 131_072, 262_144]
type Point = { repo: string; shortName: string; label: string; weights: number; download: number; kvPerToken: number; drafter?: { repo: string; weights: number; download: number }; promptCacheGib?: number; capGib?: number; qualified?: boolean }
const QWEN_27B: Point = { repo: 'TensorFold/Qwen3.8-27B-MLX-4bit', shortName: 'qwen3.8-27b', label: 'Qwen3.8 27B', weights: 16_054_541_349, download: 16_081_520_999, kvPerToken: 16 * 4 * 512 * 2, drafter: { repo: 'z-lab/Qwen3.8-27B-DFlash2', weights: 3_848_817_896, download: 3_849_113_002 }, capGib: 16 }
const LIGHTNING: Point = { repo: 'TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit', shortName: 'nemotron-lightning', label: 'Nemotron Lightning', weights: 18_527_064_363, download: 18_544_234_457, kvPerToken: 6 * 2 * 256 * 2, capGib: 16 }
const QWEN_2B: Point = { repo: 'mlx-community/Qwen3.5-2B-MLX-4bit', shortName: 'qwen3.5-2b', label: 'Qwen3.5 2B', weights: 1_749_081_964, download: 1_749_083_534, kvPerToken: 6 * 2 * 512 * 2, promptCacheGib: 1 }
const QWEN_9B: Point = { repo: 'mlx-community/Qwen3.5-9B-MLX-4bit', shortName: 'qwen3.5-9b', label: 'Qwen3.5 9B', weights: 5_950_221_072, download: 5_977_074_591, kvPerToken: 8 * 4 * 512 * 2, promptCacheGib: 1, qualified: false }
const ENGINE: TensorFoldEngine = { version: '1.2.2', binary: '/opt/homebrew/bin/tensorfold', chip: 'Apple M5 Pro', backends: ['metal'], families: [] }
const MAC_48: TensorFoldMachine = { chip: 'Apple M5 Pro', usableGib: 36 }
const MAC_32: TensorFoldMachine = { chip: 'Apple M4 Pro', usableGib: 24 }
const LIMIT_LINE = 'sudo sysctl iogpu.wired_limit_mb=28672'

function fitOf(point: Point, window: number, usable: number, limit = false): TensorFoldFit {
  const parts = {
    weightsGib: point.weights / GIB,
    ...(point.drafter !== undefined ? { drafterGib: point.drafter.weights / GIB } : {}),
    cacheGib: (point.kvPerToken * window) / GIB,
    ...(point.promptCacheGib !== undefined ? { promptCacheGib: point.promptCacheGib } : {}),
    ...(point.capGib !== undefined ? { promptCacheCapGib: point.capGib } : {}),
    runtimeGib: 2,
  }
  const needed = parts.weightsGib + (parts.drafterGib ?? 0) + parts.cacheGib + (parts.promptCacheGib ?? 0) + parts.runtimeGib
  if (limit) return { verdict: 'needs-gpu-limit', neededGib: needed, availableGib: usable, estimate: true, parts, remedy: LIMIT_LINE }
  return { verdict: needed <= usable ? 'fits' : 'too-big', neededGib: needed, availableGib: usable, estimate: true, parts }
}

function rowOf(point: Point, state: TensorFoldModelRow['state'], machine: TensorFoldMachine, extra: Partial<TensorFoldModelRow> = {}, limit = false): TensorFoldModelRow {
  const usable = machine.usableGib ?? 0
  const ladder = RUNGS.map(window => ({ window, fit: fitOf(point, window, usable, limit) }))
  const window = limit ? RUNGS[0]! : (ladder.filter(rung => rung.fit.verdict === 'fits').at(-1)?.window ?? RUNGS[0]!)
  return {
    repo: point.repo,
    shortName: point.shortName,
    label: point.label,
    family: '',
    state,
    fit: fitOf(point, window, usable, limit),
    window,
    qualified: point.qualified !== false,
    ladder,
    downloadBytes: point.download + (point.drafter?.download ?? 0),
    ...(point.drafter !== undefined ? { drafter: point.drafter.repo } : {}),
    ...(point.promptCacheGib !== undefined ? { promptCacheGib: point.promptCacheGib } : {}),
    ...extra,
  }
}

function willRunOf(row: TensorFoldModelRow, window: number): string[] {
  return [
    ...(row.state === 'not-pulled' ? [`tensorfold pull ${row.repo}`, ...(row.drafter !== undefined ? [`tensorfold pull ${row.drafter}`] : [])] : []),
    ['tensorfold serve', row.repo, ...(row.drafter !== undefined ? ['--drafter', row.drafter] : []), '--name', row.shortName, '--context', String(window), ...(row.promptCacheGib !== undefined ? ['--prompt-cache-gib', String(row.promptCacheGib)] : []), '--port', String(row.port ?? 8080)].join(' '),
  ]
}

type Seam = { engine: TensorFoldEngine | null; machine: TensorFoldMachine; inventory: TensorFoldModelRow[]; best: string | null; served: TensorFoldServed[]; hosts: TensorFoldHost[]; discovered: unknown[]; app?: { running: boolean; engine?: { pid: number; model?: string; port?: number } }; helper?: string }
let seam: Seam = { engine: ENGINE, machine: MAC_48, inventory: [], best: null, served: [], hosts: [], discovered: [] }
const supportCalls: unknown[] = []
const roadCalls: unknown[] = []

mock.module('../../src/services/tensorfold/engine.js', () => ({
  findTensorFoldEngine: async () => seam.engine,
  tensorFoldMachine: () => seam.machine,
  cachedTensorFoldMachineTruth: async () => ({ platform: 'darwin', ramBytes: 48 * GIB, usableBytes: 36 * GIB, usableSource: 'metal', chip: 'Apple M5 Pro', wiredLimitMib: 0, osVersion: '27.0' }),
}))
mock.module('../../src/services/tensorfold/install.js', () => ({
  tensorFoldInstallPlan: () => ({ kind: 'brew', commands: ['brew install ashhart/tensorfold/tensorfold'], words: 'Homebrew · ashhart/tensorfold', found: 'Homebrew found at /opt/homebrew/bin/brew' }),
  installTensorFold: async (_plan: unknown, onLine: (line: string) => void) => { onLine('==> Downloading'); return { ok: true, line: '' } },
}))
mock.module('../../src/commands/tensorfold/road.js', () => ({
  installTensorFoldThen: async (plan: unknown, io: { install?: (plan: unknown, onLine: (line: string) => void) => Promise<{ ok: boolean }> }) => { roadCalls.push(['install', plan]); const outcome = await io.install?.(plan, () => undefined); return outcome?.ok ?? true },
  readOtherCheckpoint: async (repo: string) => { roadCalls.push(['read', repo]) },
  tensorFoldRoadState: () => ({ acts: {}, other: { input: 'org/m', refused: 'fixture refusal' } }),
}))
mock.module('../../src/services/tensorfold/inventory.js', () => ({
  readTensorFoldInventory: async (engine: TensorFoldEngine | null) => (engine === null ? seam.inventory.map(row => ({ ...row, state: 'not-pulled' as const })) : seam.inventory),
  bestTensorFoldFit: (rows: readonly TensorFoldModelRow[]) => rows.find(row => row.repo === seam.best) ?? null,
}))
mock.module('../../src/services/tensorfold/serve.js', () => ({
  startTensorFold: async (request: { repo: string; name?: string; window: number; port?: number; share?: boolean }) => { roadCalls.push(['start', request]); return { repo: request.repo, name: request.name ?? request.repo, port: request.port ?? 8080, window: request.window, pid: 1, startedAt: 't' } },
  stopTensorFold: async (name: string) => { roadCalls.push(['stop', name]) },
  pullTensorFold: async (repo: string) => { roadCalls.push(['pull', repo]) },
  servedTensorFold: () => seam.served,
  tensorFoldWillRun: willRunOf,
  tensorFoldPairingCode: () => (roadCalls.some(call => Array.isArray(call) && call[0] === 'start' && (call[1] as { share?: boolean }).share === true) ? '246810' : null),
}))
const realHosts = await import('../../src/services/providers/local/tensorfoldHosts.ts')
mock.module('../../src/services/providers/local/tensorfoldHosts.js', () => ({
  ...realHosts,
  rememberTensorFoldHost: async () => undefined,
  forgetTensorFoldHost: async () => undefined,
  tensorFoldHosts: () => seam.hosts,
}))
mock.module('../../src/services/providers/local/tensorfoldHelper.js', () => ({
  helperHeadingWords: () => seam.helper,
}))
mock.module('../../src/services/providers/local/tensorfoldApp.js', () => ({
  detectTensorFoldApp: async () => seam.app ?? { running: false },
}))
mock.module('../../src/services/providers/local/tensorfoldSupport.js', () => ({
  tensorFoldSupportLine: () => 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture',
  readTensorFoldSupportLine: async (focus?: unknown) => {
    supportCalls.push(focus)
    return 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture'
  },
}))
const realDiscovery = await import('../../src/services/providers/local/localDiscovery.ts')
mock.module('../../src/services/providers/local/localDiscovery.js', () => ({
  ...realDiscovery,
  getCachedLocalDiscovery: () => (seam.discovered.length === 0 ? null : { probedAtMs: Date.now(), targetCount: 1, servers: seam.discovered }),
}))

const React = await import('react')
const h = React.createElement
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { Box } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.tsx')
const { ANTHROPIC_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
const { readTensorFoldPickerFacts, refreshTensorFoldPickerFacts, tensorFoldPickerFactsNow, huggingFaceCacheFacts, tensorFoldCapableMachine } = await import('../../src/components/tensorfold/tensorfoldFacts.ts')
const { OPENAI_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
const { gridToPng } = await import('./gridToPng.ts')
type Facts = Awaited<ReturnType<typeof readTensorFoldPickerFacts>>
type Act = import('../../src/components/tensorfold/tensorfoldRows.ts').TensorFoldAct

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

const SIZES: Array<[number, number]> = [[160, 48], [110, 34], [96, 30]]
const DISK = { into: '~/.cache/huggingface/hub', freeBytes: 37_578_240_000 }
const CLOUD = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', tag: '', ctx: '1M ctx', group: ANTHROPIC_MODEL_GROUP, door: 'Claude Max login' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', tag: '', ctx: '1M ctx', group: ANTHROPIC_MODEL_GROUP, door: 'Claude Max login' },
]
const OPENAI = { id: 'gpt-6-astra', name: 'GPT-6 Astra', tag: '', ctx: '872k ctx', group: OPENAI_MODEL_GROUP }
const HEADINGS = {
  [ANTHROPIC_MODEL_GROUP]: { name: 'ANTHROPIC', doors: [{ door: 'Claude Max login', active: true }] },
  [OPENAI_MODEL_GROUP]: { name: 'OPENAI', doors: [{ door: 'ChatGPT Pro login', active: true }] },
}
type Order = { fresh: boolean; uses: Record<string, number> }
const FRESH: Order = { fresh: true, uses: {} }
const HISTORY: Order = { fresh: false, uses: { [ANTHROPIC_MODEL_GROUP]: 100 } }
const STUDIO: TensorFoldHost = { name: 'studio.local', baseUrl: 'http://studio.local:8080', origin: 'typed', keyRef: 'studio.local', serving: 'qwen3.8-27b', version: '1.2.2', chip: 'Apple M3 Ultra', window: 131_072, lastReply: { tokensPerSecond: 38 } }
const APP = { running: true, engine: { pid: 4242, model: 'qwen3.5-2b', port: 52817 } }

function installed(machine: TensorFoldMachine = MAC_48): TensorFoldModelRow[] {
  return [rowOf(QWEN_27B, 'not-pulled', machine), rowOf(LIGHTNING, 'not-pulled', machine), rowOf(QWEN_2B, 'on-disk', machine, { bytesOnDisk: QWEN_2B.download }), rowOf(QWEN_9B, 'on-disk', machine)]
}

async function factsFor(next: Partial<Seam>, platform?: NodeJS.Platform): Promise<Facts> {
  seam = { engine: ENGINE, machine: MAC_48, inventory: installed(), best: QWEN_27B.repo, served: [], hosts: [], discovered: [], ...next }
  const real = process.platform
  if (platform !== undefined) Object.defineProperty(process, 'platform', { value: platform })
  try {
    await refreshTensorFoldPickerFacts()
    return { ...tensorFoldPickerFactsNow(), disk: DISK }
  } finally {
    Object.defineProperty(process, 'platform', { value: real })
  }
}

type Run = { m: Mounted; acts: Act[]; selected: string[]; closed: () => number; columns: number; rows: number }

async function open(facts: Facts, current: string, columns: number, rows: number, order: Order = FRESH): Promise<Run> {
  const acts: Act[] = []
  const selected: string[] = []
  let closed = 0
  const picker = h(MercuryModelPicker as never, {
    models: order.fresh ? CLOUD : [...CLOUD, OPENAI],
    recentAt: (group: string) => order.uses[group] ?? (group.includes('TensorFold') ? order.uses.tensorfold : undefined),
    tensorFoldFirst: order.fresh,
    current,
    ctxPct: 4,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    effort: 'high',
    headings: HEADINGS,
    topGroup: ANTHROPIC_MODEL_GROUP,
    tensorfold: facts,
    onTensorFold: (act: Act) => { acts.push(act) },
    onSelect: (id: string) => { selected.push(id) },
    onClose: () => { closed++ },
  } as never)
  const shell = h(AppStateProvider as never, {} as never, h(ThemeProvider as never, {} as never, h(Box, { flexDirection: 'column', width: columns, height: rows, justifyContent: 'center' }, picker)))
  const m = await mountOffscreen(shell, columns, rows)
  await waitFor(() => m.screen().includes('Mercury · model'), 8000)
  await settle(250)
  return { m, acts, selected, closed: () => closed, columns, rows }
}

async function press(run: Run, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    run.m.push(key)
    await settle(140)
  }
  await settle(160)
}

const inner = (line: string): string => line.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '')
const flat = (run: Run): string[] => run.m.lines().map(line => inner(inner(line)).replace(/\s+$/, ''))
const has = (run: Run, words: string): boolean => flat(run).some(line => line.includes(words))
const cells = (run: Run, ...parts: string[]): boolean => flat(run).some(line => new RegExp(parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s{2,}')).test(line))
const lineOf = (run: Run, words: string): number => flat(run).findIndex(line => line.includes(words))

const NAMED: Record<string, string> = { '30': 'black', '31': 'red', '32': 'green', '33': 'yellow', '34': 'blue', '35': 'magenta', '36': 'cyan', '37': 'white', '90': 'brightblack', '91': 'brightred', '92': 'brightgreen', '93': 'brightyellow', '94': 'brightblue', '95': 'brightmagenta', '96': 'brightcyan', '97': 'brightwhite' }
const hex2 = (n: number): string => n.toString(16).padStart(2, '0')
function colourOf(sgr: string | undefined): string {
  if (sgr === undefined || sgr === 'default' || sgr === '') return 'default'
  const rgb = /^(?:38|48);2;(\d+);(\d+);(\d+)$/.exec(sgr)
  if (rgb) return hex2(Number(rgb[1])) + hex2(Number(rgb[2])) + hex2(Number(rgb[3]))
  const n = Number(sgr)
  const base = n >= 100 ? String(n - 10) : n >= 90 ? String(n) : n >= 40 ? String(n - 10) : String(n)
  return NAMED[base] ?? 'default'
}

async function save(name: string, run: Run): Promise<void> {
  if (FRAMES === undefined) return
  const file = `${name}-${run.columns}x${run.rows}`
  const lines = run.m.lines()
  writeFileSync(join(FRAMES, `${file}.txt`), lines.join('\n') + '\n')
  if (!PNG) return
  const grid = Array.from({ length: run.rows }, (_, y) => {
    const text = [...(lines[y] ?? '')]
    return Array.from({ length: run.columns }, (_, x) => {
      const style = text[x] !== undefined && text[x] !== ' ' ? run.m.styleAt(x, y) : null
      return { c: text[x] ?? ' ', fg: colourOf(style?.fg), bg: colourOf(style?.bg), bold: style?.bold === true, rev: style?.inverse === true }
    })
  })
  const gridPath = join(FRAMES, `.${file}.json`)
  writeFileSync(gridPath, JSON.stringify({ cols: run.columns, rows: run.rows, grid }))
  await gridToPng(gridPath, join(FRAMES, `${file}.png`))
}

const LEGEND_PICKER = '↑↓ select · ↵ switch · ctrl+w context · → ← fold'
const UP = KEY.up
const RIGHT = KEY.right

console.log('§1 the frames m01–m05, m03b and the app, win32, 32 GB and outside-server states at 160×48, 110×34 and 96×30, against DESIGN §2–§4 and the frames')
for (const [columns, rows] of SIZES) {
  const at = `${columns}x${rows}`
  {
    const run = await open(await factsFor({}), 'claude-opus-5-5', columns, rows)
    await save('m01-model-first-open', run)
    check(`${at} m01: TENSORFOLD pinned first, folded, with its status words`, has(run, '▸ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served'), flat(run).filter(l => l.includes('TENSORFOLD')).join(' | '))
    check(`${at} m01: TENSORFOLD HOST beneath it, folded`, has(run, '▸ TENSORFOLD HOST · no host · a server on your network or a rented GPU pod') && lineOf(run, '▸ TENSORFOLD HOST') === lineOf(run, '▸ TENSORFOLD ·') + 1)
    check(`${at} m01: both above the cloud provider, which keeps its own heading and current row`, lineOf(run, '▸ TENSORFOLD HOST') < lineOf(run, '▾ ANTHROPIC · Claude Max login · 2 live') && cells(run, 'Opus 5.5', 'claude-opus-5-5', 'current', '1M ctx'))
    check(`${at} m01: no live count on the TensorFold headings`, !flat(run).some(l => /TENSORFOLD.*\d+ live/.test(l)))
    check(`${at} m01: the legend is the picker's own`, has(run, LEGEND_PICKER), flat(run).find(l => l.includes('↑↓ select')) ?? '')
    run.m.unmount()
    await settle(60)
  }
  {
    const run = await open(await factsFor({}), 'claude-opus-5-5', columns, rows, HISTORY)
    await save('m01b-model-first-open-history', run)
    check(`${at} m01b: with cloud history the picker's own order holds — the current provider first, then by use, TensorFold where its recency puts it`, lineOf(run, '▾ ANTHROPIC') < lineOf(run, '▾ OPENAI') && lineOf(run, '▾ OPENAI') < lineOf(run, '▸ TENSORFOLD ·'), flat(run).filter(l => /[▾▸❯] [A-Z]/.test(l)).join(' | '))
    check(`${at} m01b: the pair stays adjacent and folded`, lineOf(run, '▸ TENSORFOLD HOST') === lineOf(run, '▸ TENSORFOLD ·') + 1 && has(run, '▸ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served'))
    run.m.unmount()
    await settle(60)
  }
  {
    const run = await open(await factsFor({}), 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, UP, RIGHT])
    await save('m02-model-tensorfold-top', run)
    check(`${at} m02: → on TENSORFOLD unfolds its top rows and frames the best fit`, has(run, '▾ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served') && cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', '↓ 20 GB', '128k ctx', '28.5 GiB') && has(run, '╭'))
    check(`${at} m02: the card's keyed lines: window strip, memory, pull, will run`, has(run, 'window    32k 64k [128k] 256k · ←→ changes it') && has(run, 'memory    weights 15 + drafter 3.6 + cache 8 + runtime 2 GiB · prompt cache ≤16 GiB') && has(run, 'pull      into ~/.cache/huggingface/hub · 38 GB free on this disk') && has(run, 'will run  tensorfold pull TensorFold/Qwen3.8-27B-MLX-4bit') && has(run, 'tensorfold pull z-lab/Qwen3.8-27B-DFlash2') && has(run, 'tensorfold serve TensorFold/Qwen3.8-27B-MLX-4bit --drafter'), flat(run).slice(4, 18).join(' | '))
    check(`${at} m02: what is on disk next, the rest behind the more-line`, cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'on disk', '256k ctx', '7.6 GiB') && has(run, '↓ 2 more · → unfolds the rest'))
    check(`${at} m02: the 9B is never offered`, !flat(run).some(l => l.includes('qwen3.5-9b')))
    check(`${at} m02: the legend says what ↵ does here, the window keys and c`, has(run, '↑↓ select · ↵ pull, serve and switch · ←→ window · c copies the support line'), flat(run).find(l => l.includes('↑↓ select')) ?? '')
    run.m.unmount()
    await settle(60)
  }
  {
    const run = await open(await factsFor({}), 'claude-opus-5-5', columns, rows, HISTORY)
    await press(run, [KEY.down, KEY.down, KEY.down, KEY.down, RIGHT])
    await save('m02b-model-tensorfold-top-history', run)
    check(`${at} m02b: → on TENSORFOLD where recency put it unfolds the same rows and frames the best fit`, has(run, '▾ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served') && cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', '↓ 20 GB', '128k ctx', '28.5 GiB') && lineOf(run, '▾ OPENAI') < lineOf(run, '▾ TENSORFOLD ·'), flat(run).filter(l => /[▾▸❯] [A-Z]/.test(l)).join(' | '))
    run.m.unmount()
    await settle(60)
  }
  {
    const run = await open(await factsFor({}), 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, UP, RIGHT, UP, RIGHT])
    await save('m03-model-tensorfold-full', run)
    check(`${at} m03: → again shows every starting point and other checkpoint, Lightning framed`, cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', '↓ 20 GB', '128k ctx', '28.5 GiB') && cells(run, 'Nemotron Lightning', 'local/nemotron-lightning', '↓ 19 GB', '256k ctx', '20.8 GiB') && has(run, 'other checkpoint — a Hugging Face repository id') && !has(run, '↓ 2 more'))
    check(`${at} m03: Lightning's card`, has(run, 'window    32k 64k 128k [256k] · ←→ changes it') && has(run, 'memory    weights 17.3 + cache 1.5 + runtime 2 GiB · prompt cache ≤16 GiB') && has(run, 'tensorfold pull TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit'), flat(run).slice(4, 18).join(' | '))
    check(`${at} m03: c copies the support line is in the legend`, has(run, 'c copies the support line'), flat(run).find(l => l.includes('↑↓ select')) ?? '')
    run.m.unmount()
    await settle(60)
  }
  {
    const run = await open(await factsFor({ hosts: [STUDIO] }), 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, RIGHT])
    await save('m03b-model-host', run)
    check(`${at} m03b: TENSORFOLD HOST unfolded with the host's name and its server framed`, has(run, '▾ TENSORFOLD HOST · studio.local · 1 serving') && cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'serving', '128k ctx', 'studio.local'))
    check(`${at} m03b: the host card`, has(run, 'host      studio.local:8080 · Apple M3 Ultra · TensorFold 1.2.2 · keyed') && has(run, 'serving   ~38 tok/s on its last reply') && has(run, 'window    128k · set when it started outside Mercury, which does not stop or') && has(run, 'plain HTTP on your home or office network, not across the internet'), flat(run).slice(4, 18).join(' | '))
    check(`${at} m03b: the rent and address rows`, has(run, 'rent a GPU pod — Runpod, through /llmhost') && has(run, 'a server on your network — its address'))
    check(`${at} m03b: ↵ switches`, has(run, '↑↓ select · ↵ switch'), flat(run).find(l => l.includes('↑↓ select')) ?? '')
    run.m.unmount()
    await settle(60)
  }
  {
    const served = rowOf(QWEN_2B, 'serving', MAC_48, { port: 8080, startedBy: 'mercury', inUseBytes: 2_965_982_016, lastReply: { firstTokenMs: 40, tokensPerSecond: 110 } })
    const run = await open(await factsFor({ inventory: [rowOf(QWEN_27B, 'not-pulled', MAC_48), rowOf(LIGHTNING, 'not-pulled', MAC_48), served] }), 'local/qwen3.5-2b', columns, rows, HISTORY)
    await save('m04-model-current', run)
    check(`${at} m04: TensorFold current → its group first, ahead of the provider with more recent use`, lineOf(run, '▾ TENSORFOLD ·') < lineOf(run, '▾ ANTHROPIC') && lineOf(run, '▸ TENSORFOLD HOST') < lineOf(run, '▾ ANTHROPIC'), flat(run).filter(l => /[▾▸❯] [A-Z]/.test(l)).join(' | '))
    check(`${at} m04: the session's model framed in TENSORFOLD, unfolded, 1 serving`, has(run, '▾ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · 1 serving') && cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'current', '256k ctx', '2.8 GiB in use'))
    check(`${at} m04: the served card`, has(run, 'serving   on 127.0.0.1:8080 · first reply in 40 ms · ~110 tok/s') && has(run, 'window    32k 64k 128k [256k] · ←→ restarts it at another window') && has(run, 'service   tensorfold · started by Mercury · prompt cache 1 GiB'), flat(run).slice(4, 14).join(' | '))
    check(`${at} m04: the best fit next and the rest behind the more-line; HOST folded; the cloud row no longer current`, cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', '↓ 20 GB', '128k ctx', '28.5 GiB') && has(run, '↓ 2 more · → unfolds the rest') && has(run, '▸ TENSORFOLD HOST') && !cells(run, 'Opus 5.5', 'claude-opus-5-5', 'current'))
    check(`${at} m04: sharing on the network is an explicit step on the card, off until asked`, has(run, 'network   not shared · n shares it on this network'), flat(run).slice(4, 14).join(' | '))
    check(`${at} m04: s stops, the window, n and c in the legend`, has(run, '↑↓ select · s stops · ←→ window · n shares it · c copies the support line'), flat(run).find(l => l.includes('↑↓ select')) ?? '')
    run.m.unmount()
    await settle(60)
  }
  {
    const run = await open(await factsFor({ engine: null, inventory: [rowOf(QWEN_27B, 'not-pulled', MAC_48), rowOf(LIGHTNING, 'not-pulled', MAC_48), rowOf(QWEN_2B, 'not-pulled', MAC_48)] }), 'claude-opus-5-5', columns, rows)
    await save('m05-model-not-installed', run)
    check(`${at} m05: not installed, still first, folded`, has(run, '▸ TENSORFOLD · not installed · Apple M5 Pro · 36.0 GiB usable') && lineOf(run, '▸ TENSORFOLD ·') < lineOf(run, '▾ ANTHROPIC'))
    run.m.unmount()
    await settle(60)
  }
  {
    const run = await open(await factsFor({ app: APP }), 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, UP, RIGHT])
    await save('m06-model-app-serving', run)
    check(`${at} app: the app's engine is a row in TENSORFOLD, never a host`, has(run, 'the app is serving qwen3.5-2b — paste from its API tab') && !has(run, 'TensorFold app') && has(run, '▸ TENSORFOLD HOST · no host'))
    check(`${at} app: s serves it with Mercury instead, two copies refused`, has(run, "s serves it with Mercury · quit the app first — two copies won't fit") && has(run, 's serve with Mercury instead'), flat(run).slice(4, 12).join(' | '))
    run.m.unmount()
    await settle(60)
  }
  {
    const run = await open(await factsFor({}, 'win32'), 'claude-opus-5-5', columns, rows)
    await save('m07-model-win32', run)
    check(`${at} win32: TENSORFOLD reads no Windows release yet, folded`, has(run, '▸ TENSORFOLD · no Windows release yet'))
    check(`${at} win32: TENSORFOLD HOST unfolded and holds the road`, has(run, '▾ TENSORFOLD HOST · no host · a server on your network or a rented GPU pod') && has(run, 'rent a GPU pod — Runpod, through /llmhost') && has(run, 'a server on your network — its address'))
    run.m.unmount()
    await settle(60)
  }
  {
    const inventory = [rowOf(QWEN_27B, 'not-pulled', MAC_32, {}, true), rowOf(LIGHTNING, 'not-pulled', MAC_32), rowOf(QWEN_2B, 'on-disk', MAC_32)]
    const run = await open(await factsFor({ machine: MAC_32, engine: { ...ENGINE, chip: 'Apple M4 Pro' }, inventory, best: LIGHTNING.repo }), 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, UP, RIGHT, UP, RIGHT])
    await save('m08-model-gpu-limit', run)
    check(`${at} 32 GB: Lightning is the best fit on top; the 27B says it needs the GPU limit raised, an estimate`, lineOf(run, 'Nemotron Lightning') < lineOf(run, 'Qwen3.8 27B') && has(run, 'fit       needs the GPU limit raised · w · an estimate'), flat(run).slice(4, 16).join(' | '))
    check(`${at} 32 GB: w raises the limit in the legend, no ↵ there`, has(run, '↑↓ select · w raise the limit') && !has(run, '↵ pull, serve and switch'), flat(run).find(l => l.includes('↑↓ select')) ?? '')
    run.m.unmount()
    await settle(60)
  }
  {
    const discovered = [{ kind: 'tensorfold', root: 'http://127.0.0.1:8087', baseUrl: 'http://127.0.0.1:8087/v1', label: 'TensorFold 1.2.2', version: '1.2.2', models: [{ id: 'qwen3.5-2b', server: 'tensorfold', baseUrl: 'http://127.0.0.1:8087/v1', contextWindow: { tokens: 32_768, source: 'served' }, servedBytes: 2_965_982_016 }] }]
    const run = await open(await factsFor({ inventory: [rowOf(QWEN_27B, 'not-pulled', MAC_48), rowOf(LIGHTNING, 'not-pulled', MAC_48)], discovered }), 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, UP, RIGHT])
    await save('m09-model-served-outside', run)
    check(`${at} outside: a server started by hand is a serving row in TENSORFOLD with its window set outside`, cells(run, 'qwen3.5-2b', 'local/qwen3.5-2b', 'serving', '32k ctx', '2.8 GiB in use') && has(run, 'window    32k · set when it started outside Mercury, which does not stop or restart it') && has(run, '1 serving'), flat(run).slice(4, 14).join(' | '))
    check(`${at} outside: s is never offered on it; ↵ switches`, !has(run, 's stops') && has(run, '↑↓ select · ↵ switch'), flat(run).find(l => l.includes('↑↓ select')) ?? '')
    run.m.unmount()
    await settle(60)
  }
}

console.log('\n§2 the keys on a TensorFold row: ←→ and ctrl+w the window, ↵ hands the row on, c and w, s twice on the session\'s model, the typed rows')
{
  const run = await open(await factsFor({}), 'claude-opus-5-5', 160, 48)
  await press(run, [UP, UP, UP, RIGHT, RIGHT])
  check('→ on a TensorFold row moves the window, the row and the strip say it does not fit, ↵ leaves the legend', cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'does not fit', '256k ctx', '36.5 GiB') && has(run, 'window    32k 64k 128k [256k] · 256k needs 36.5 GiB, 36.0 GiB usable · ← 128k fits') && !has(run, '↵ pull, serve and switch'), flat(run).slice(4, 12).join(' | '))
  await press(run, [KEY.left])
  check('← brings it back to 128k', cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', '↓ 20 GB', '128k ctx', '28.5 GiB'))
  await press(run, ['\x17'])
  check('ctrl+w is a silent alias for →', cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'does not fit', '256k ctx') && !has(run, 'not a toggle'))
  await press(run, [KEY.left, KEY.enter])
  const serve = run.acts.at(-1)
  check('↵ on an unserved row hands the row and its window to the serve road', serve?.kind === 'serve' && serve.row.repo === QWEN_27B.repo && serve.window === 131_072 && run.selected.length === 0, JSON.stringify(serve ?? null).slice(0, 200))
  await press(run, ['c'])
  const support = run.acts.at(-1)
  check('c hands the framed row and its window to the support line', support?.kind === 'support' && support.row?.repo === QWEN_27B.repo && support.window === 131_072, JSON.stringify(support ?? null).slice(0, 200))
  await press(run, [UP, RIGHT, KEY.down, KEY.down])
  check('the cursor reaches other checkpoint', has(run, 'reads     Hugging Face · MLX, NVFP4 or EXL3 checkpoints, not GGUF'), flat(run).slice(4, 16).join(' | '))
  await press(run, [KEY.enter, 'o', 'r', 'g', '/', 'm'])
  check('↵ on other checkpoint opens the typed repo line and its legend', has(run, 'repo      org/m▌') && has(run, 'type a repository id · ↵ read it · esc back'), flat(run).slice(4, 18).join(' | '))
  await press(run, [KEY.enter])
  const read = run.acts.at(-1)
  check('↵ reads the typed id', read?.kind === 'read' && read.repo === 'org/m', JSON.stringify(read ?? null))
  check('nothing closed the picker', run.closed() === 0)
  run.m.unmount()
  await settle(60)
}
{
  const served = rowOf(QWEN_2B, 'serving', MAC_48, { port: 8080, startedBy: 'mercury', inUseBytes: 2_965_982_016 })
  const run = await open(await factsFor({ inventory: [rowOf(QWEN_27B, 'not-pulled', MAC_48), served] }), 'local/qwen3.5-2b', 160, 48)
  await press(run, ['s'])
  check("s on the session's own model asks once more", has(run, 'stop      s again stops it · this session uses it') && has(run, 's again stops · esc keeps it') && run.acts.length === 0, flat(run).slice(4, 14).join(' | '))
  await press(run, [KEY.esc])
  check('esc keeps it and keeps the picker', !has(run, 's again stops it') && run.closed() === 0 && run.acts.length === 0)
  await press(run, ['s', 's'])
  const stop = run.acts.at(-1)
  check('s, s stops it', stop?.kind === 'stop' && stop.row.repo === QWEN_2B.repo, JSON.stringify(stop ?? null).slice(0, 160))
  await press(run, ['n'])
  const share = run.acts.at(-1)
  check('n shares a Mercury-started server', share?.kind === 'share' && share.row.repo === QWEN_2B.repo, JSON.stringify(share ?? null).slice(0, 160))
  await press(run, [RIGHT])
  check('→ on the served row shows the restart at the new window', has(run, '· ↵ restarts it at 256k') || has(run, '[256k]'), flat(run).slice(4, 14).join(' | '))
  run.m.unmount()
  await settle(60)
}
{
  const run = await open(await factsFor({ hosts: [STUDIO] }), 'claude-opus-5-5', 160, 48)
  await press(run, [UP, UP, RIGHT, KEY.enter])
  check('↵ on a host row switches through the picker\'s own road', run.selected.at(-1) === 'local/qwen3.8-27b', run.selected.join(','))
  await press(run, [KEY.down, KEY.down, KEY.enter, 'a', 'i', 'r', '.', 'l', 'o', 'c', 'a', 'l', ':', '8', '0', '8', '0', KEY.enter])
  const address = run.acts.at(-1)
  check('the address row takes host:port and hands it on', address?.kind === 'address' && address.address === 'air.local:8080', JSON.stringify(address ?? null))
  run.m.unmount()
  await settle(60)
}
{
  const inventory = [rowOf(QWEN_27B, 'not-pulled', MAC_32, {}, true), rowOf(LIGHTNING, 'not-pulled', MAC_32), rowOf(QWEN_2B, 'on-disk', MAC_32)]
  const run = await open(await factsFor({ machine: MAC_32, inventory, best: LIGHTNING.repo }), 'claude-opus-5-5', 160, 48)
  await press(run, [UP, UP, UP, RIGHT, UP, RIGHT, 'w'])
  const limit = run.acts.at(-1)
  check('w hands the printed sysctl line on (Mercury never runs it)', limit?.kind === 'limit' && limit.line === LIMIT_LINE, JSON.stringify(limit ?? null).slice(0, 160))
  run.m.unmount()
  await settle(60)
}

console.log('\n§3 the order rule and the facts the /model group reads')
{
  const used = await open(await factsFor({}), 'claude-opus-5-5', 160, 48, { fresh: false, uses: { [ANTHROPIC_MODEL_GROUP]: 100, tensorfold: 50 } })
  check('TensorFold used before the cloud provider: after the current provider, ahead of the never-used one, the pair adjacent', lineOf(used, '▾ ANTHROPIC') < lineOf(used, '▸ TENSORFOLD ·') && lineOf(used, '▸ TENSORFOLD HOST') === lineOf(used, '▸ TENSORFOLD ·') + 1 && lineOf(used, '▸ TENSORFOLD HOST') < lineOf(used, '▾ OPENAI'), flat(used).filter(l => /[▾▸❯] [A-Z]/.test(l)).join(' | '))
  used.m.unmount()
  await settle(60)
  check('a machine that can run TensorFold: Apple silicon, or Linux with the R580+ NVIDIA driver loaded', tensorFoldCapableMachine('darwin', 'arm64') && !tensorFoldCapableMachine('darwin', 'x64') && tensorFoldCapableMachine('linux', 'x64', () => 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.95.05') && !tensorFoldCapableMachine('linux', 'x64', () => undefined) && !tensorFoldCapableMachine('win32', 'x64', () => 'Kernel Module  580.95.05'))
  void readTensorFoldPickerFacts
  const facts = await factsFor({ hosts: [STUDIO], app: APP })
  check("the app's engine, detected by process (tf-engine-106's reader), becomes the app row and never a host row", facts.app?.serving === 'qwen3.5-2b' && facts.hosts?.length === 1)
  const helped = await factsFor({ helper: '· helper 2B' })
  check('the helper suffix comes from the one heading reader (tf-engine-106\'s helperHeadingWords)', helped.helper === '· helper 2B')
  const POD: TensorFoldHost = { name: 'pod-7f3a', baseUrl: 'http://127.0.0.1:41234', origin: 'pod', keyRef: 'pod-7f3a', serving: 'qwen3.8-27b', version: '1.2.2', chip: 'RTX 5090', window: 131_072 }
  const tunnel = [{ kind: 'tensorfold', root: 'http://127.0.0.1:41234', baseUrl: 'http://127.0.0.1:41234/v1', label: 'TensorFold 1.2.2', version: '1.2.2', models: [{ id: 'qwen3.8-27b', server: 'tensorfold', baseUrl: 'http://127.0.0.1:41234/v1' }] }]
  const pod = await open(await factsFor({ hosts: [POD], discovered: tunnel }), 'claude-opus-5-5', 160, 48)
  await press(pod, [UP, UP, RIGHT])
  check("a rented pod's loopback tunnel is a TENSORFOLD HOST row, never a served row on this machine", cells(pod, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'serving', '128k ctx', 'pod-7f3a') === false && has(pod, 'pod-7f3a · 1 serving') && has(pod, '▸ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served'), flat(pod).filter(l => /TENSORFOLD|pod-7f3a/.test(l)).join(' | '))
  await press(pod, [KEY.enter])
  check('↵ on the pod row switches to the pod through its compat road', pod.selected.at(-1) === 'compat/pod-7f3a/qwen3.8-27b', pod.selected.join(','))
  pod.m.unmount()
  await settle(60)
  const disk = huggingFaceCacheFacts({ HF_HOME: '/srv/hf' }, '/home/someone')
  check('the pull line names the Hugging Face cache (HF_HOME honoured, home shortened)', disk.into === '/srv/hf/hub' && huggingFaceCacheFacts({}, '/home/someone').into === '~/.cache/huggingface/hub', JSON.stringify(disk))
}

console.log("\n§4 /model's own road for the keys: share, unshare, install, other checkpoint and the app row go straight through the panel lane's functions (tf-panel-106), never by handing to /tensorfold")
{
  const { runTensorFoldAct } = await import('../../src/commands/model/mercuryModel.tsx')
  type HostIo = import('../../src/commands/model/mercuryModel.tsx').TensorFoldHostIo
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 80))
  const notices: string[] = []
  const installs: unknown[] = []
  const others: unknown[] = []
  const switches: string[] = []
  const served = rowOf(QWEN_2B, 'serving', MAC_48, { port: 8080, startedBy: 'mercury' })
  const facts = await factsFor({ inventory: [rowOf(QWEN_27B, 'not-pulled', MAC_48), served], served: [{ repo: QWEN_2B.repo, name: 'qwen3.5-2b', port: 8080, window: 262_144, pid: 1, startedAt: 't' }] })
  const io: HostIo = { facts, setAct: () => undefined, setInstall: install => installs.push(install), setOther: other => others.push(other), setNotice: words => notices.push(words), open: () => true, switchTo: id => switches.push(id), rent: () => undefined }
  roadCalls.length = 0
  runTensorFoldAct({ kind: 'share', row: served }, io)
  await settle()
  const shareStart = roadCalls.find(call => Array.isArray(call) && call[0] === 'start') as [string, { share?: boolean; port?: number; window: number }] | undefined
  check('n on a served row restarts it through startTensorFold({ share: true }) on its port and window, the session not switched, the pairing code shown', roadCalls.some(call => Array.isArray(call) && call[0] === 'stop') && shareStart?.[1].share === true && shareStart[1].port === 8080 && shareStart[1].window === 262_144 && switches.length === 0 && notices.at(-1)?.startsWith('pairing code 246810 · ') === true, JSON.stringify({ roadCalls, notices }))
  roadCalls.length = 0
  runTensorFoldAct({ kind: 'unshare', row: served }, io)
  await settle()
  const unshareStart = roadCalls.find(call => Array.isArray(call) && call[0] === 'start') as [string, { share?: boolean }] | undefined
  check('n again restarts it with share: false', unshareStart?.[1].share === false, JSON.stringify(roadCalls))
  roadCalls.length = 0
  runTensorFoldAct({ kind: 'install' }, io)
  await settle()
  check("↵ on the install row installs through the panel lane's installTensorFoldThen, the row reading installing with the brew line meanwhile, then clears", roadCalls.some(call => Array.isArray(call) && call[0] === 'install') && JSON.stringify(installs[0]) === JSON.stringify({ road: 'brew', state: 'installing', commands: ['brew install ashhart/tensorfold/tensorfold'] }) && installs.some(install => (install as { progress?: string } | undefined)?.progress === '==> Downloading') && installs.at(-1) === undefined, JSON.stringify({ roadCalls, installs }))
  roadCalls.length = 0
  const notInstalled = { ...io, facts: { ...facts, engine: null } }
  runTensorFoldAct({ kind: 'serve', row: rowOf(QWEN_27B, 'not-pulled', MAC_48), window: 131_072 }, notInstalled)
  await settle()
  check('↵ on a row when TensorFold is not installed: install, pull (the checkpoint and its drafter), serve and switch', roadCalls.map(call => (Array.isArray(call) ? call[0] : '')).join(',') === 'install,pull,pull,start' && switches.at(-1) === 'local/qwen3.8-27b', JSON.stringify({ roadCalls, switches }))
  roadCalls.length = 0
  runTensorFoldAct({ kind: 'read', repo: 'org/m' }, io)
  await settle()
  check("a typed repository id is read through the panel lane's readOtherCheckpoint and the road's answer lands in /model's facts", JSON.stringify(roadCalls) === JSON.stringify([['read', 'org/m']]) && JSON.stringify(others.at(-1)) === JSON.stringify({ input: 'org/m', refused: 'fixture refusal' }), JSON.stringify({ roadCalls, others }))
  runTensorFoldAct({ kind: 'app', serving: 'qwen3.5-2b' }, io)
  check("s on the app row says what to do, in the panel's words", notices.at(-1) === 'the app is serving qwen3.5-2b · paste from its API tab · quit the app first to serve with Mercury instead', String(notices.at(-1)))
}

await releaseScratchHome(home)
console.log(failures === 0 ? '\nprove-tensorfold-model-groups: ALL GREEN' : `\nprove-tensorfold-model-groups: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
