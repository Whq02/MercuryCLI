#!/usr/bin/env bun
import { mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
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
const PROBING_OFF = 'none'
const PROBING_ON = 'llamacpp=http://127.0.0.1:9'
process.env.MERCURY_LOCAL_PROBE_TARGETS = PROBING_OFF
const SOMEONE = join(home, 'someone')
const HUB = join(SOMEONE, '.cache', 'huggingface', 'hub')
process.env.HF_HUB_CACHE = HUB

const GIB = 1024 ** 3
const RUNGS = [32_768, 65_536, 131_072, 262_144]
type Point = { repo: string; shortName: string; label: string; family: string; weights: number; download: number; kvPerToken: number; drafter?: { repo: string; weights: number; download: number }; promptCacheGib?: number; capGib?: number; qualified?: boolean }
const QWEN_27B: Point = { repo: 'TensorFold/Qwen3.8-27B-MLX-4bit', shortName: 'qwen3.8-27b', label: 'Qwen3.8 27B', family: 'qwen3_5', weights: 16_054_541_349, download: 16_081_520_999, kvPerToken: 16 * 4 * 512 * 2, drafter: { repo: 'z-lab/Qwen3.8-27B-DFlash2', weights: 3_848_817_896, download: 3_849_113_002 }, capGib: 16 }
const LIGHTNING: Point = { repo: 'TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit', shortName: 'nemotron-lightning', label: 'Nemotron Lightning', family: 'nemotron_h', weights: 18_527_064_363, download: 18_544_234_457, kvPerToken: 6 * 2 * 256 * 2, capGib: 16 }
const QWEN_2B: Point = { repo: 'mlx-community/Qwen3.5-2B-MLX-4bit', shortName: 'qwen3.5-2b', label: 'Qwen3.5 2B', family: 'qwen3_5', weights: 1_749_081_964, download: 1_749_083_534, kvPerToken: 6 * 2 * 512 * 2, promptCacheGib: 1 }
const LLAMA: Point = { repo: 'mlx-community/Llama-3.3-8B-Instruct-4bit', shortName: 'llama-3.3-8b-instruct-4bit', label: 'Llama 3.3 8B', family: 'llama', weights: 4_517_000_000, download: 4_517_000_000, kvPerToken: 32 * 8 * 128 * 2 * 2, qualified: false }
const ENGINE: TensorFoldEngine = {
  version: '1.2.2',
  binary: '/opt/homebrew/bin/tensorfold',
  chip: 'Apple M5 Pro',
  backends: ['metal'],
  families: [
    { id: 'qwen3_5', repos: [QWEN_27B.repo, QWEN_2B.repo], quantisations: ['4-bit'], qualified: true },
    { id: 'nemotron_h', repos: [LIGHTNING.repo], quantisations: ['4-bit'], qualified: true },
  ],
}
const MAC_48: TensorFoldMachine = { chip: 'Apple M5 Pro', usableGib: 36 }
const MAC_32: TensorFoldMachine = { chip: 'Apple M4 Pro', usableGib: 24 }
const LIMIT_LINE = 'sudo sysctl iogpu.wired_limit_mb=28672'
const LIMIT_COST = 'resets at reboot; restart the engine after it · tight — quit other apps first'
type Limit = 'offer' | 'none'

function fitOf(point: Point, window: number, usable: number, limit?: Limit): TensorFoldFit {
  const parts = {
    weightsGib: point.weights / GIB,
    ...(point.drafter !== undefined ? { drafterGib: point.drafter.weights / GIB } : {}),
    cacheGib: (point.kvPerToken * window) / GIB,
    ...(point.promptCacheGib !== undefined ? { promptCacheGib: point.promptCacheGib } : {}),
    ...(point.capGib !== undefined ? { promptCacheCapGib: point.capGib } : {}),
    runtimeGib: 2,
  }
  const needed = parts.weightsGib + (parts.drafterGib ?? 0) + parts.cacheGib + (parts.promptCacheGib ?? 0) + parts.runtimeGib
  if (limit === 'offer') return { verdict: 'needs-gpu-limit', neededGib: needed, availableGib: usable, estimate: true, parts, reason: 'needs the GPU limit raised on a Mac under 48 GB', remedy: `${LIMIT_LINE} · ${LIMIT_COST}` }
  if (limit === 'none') return { verdict: 'needs-gpu-limit', neededGib: needed, availableGib: usable, estimate: true, parts, reason: 'past what macOS lets the GPU wire', remedy: 'lower the window or choose a smaller model' }
  return { verdict: needed <= usable ? 'fits' : 'too-big', neededGib: needed, availableGib: usable, estimate: true, parts }
}

function rowOf(point: Point, state: TensorFoldModelRow['state'], machine: TensorFoldMachine, extra: Partial<TensorFoldModelRow> = {}, limit?: Limit): TensorFoldModelRow {
  const usable = machine.usableGib ?? 0
  const ladder = RUNGS.map(window => ({ window, fit: fitOf(point, window, usable, limit) }))
  const window = limit !== undefined ? RUNGS[0]! : (ladder.filter(rung => rung.fit.verdict === 'fits').at(-1)?.window ?? RUNGS[0]!)
  return {
    repo: point.repo,
    shortName: point.shortName,
    label: point.label,
    family: point.family,
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

function truthOf(machine: TensorFoldMachine): { platform: NodeJS.Platform; ramBytes: number; usableBytes: number; usableSource: 'metal'; chip: string; wiredLimitMib: number; osVersion: string } {
  return { platform: 'darwin', ramBytes: (machine === MAC_32 ? 32 : 48) * GIB, usableBytes: (machine.usableGib ?? 36) * GIB, usableSource: 'metal', chip: machine.chip, wiredLimitMib: 0, osVersion: '27.0' }
}

type PodRow = { hostName: string; id: string; provider?: string; words: string; bills: boolean; state: 'starting' | 'serving' | 'stopping' | 'stopped' | 'paused' | 'failed'; title: string; served: string; window?: number; gpu: string; vendor: string; step?: string }
type Server = { kind: string; root: string; baseUrl: string; label: string; version?: string; models: Array<Record<string, unknown>> }
type Browsed = { name: string; host: string; port: number; txt: Record<string, string> }
type StartRequest = { repo: string; name?: string; window: number; port?: number; share?: boolean }
type Seam = {
  engine: TensorFoldEngine | null
  machine: TensorFoldMachine
  inventory: TensorFoldModelRow[] | 'disk'
  best: string | null
  served: TensorFoldServed[]
  hosts: TensorFoldHost[]
  discovered: Server[]
  app?: { running: boolean; engine?: { pid: number; model?: string; port?: number } }
  helper?: string
  pods?: PodRow[]
  announced: Browsed[]
  start?: (request: StartRequest) => Promise<TensorFoldServed>
}
const DEFAULT_SEAM: Seam = { engine: ENGINE, machine: MAC_48, inventory: [], best: null, served: [], hosts: [], discovered: [], announced: [] }
let seam: Seam = { ...DEFAULT_SEAM }
const supportCalls: unknown[] = []
const roadCalls: unknown[][] = []
const receipts: string[] = []
const remembered: Array<Record<string, unknown>> = []
let snapshot: { key: Server[]; value: { probedAtMs: number; targetCount: number; servers: Server[] } } | undefined
const discoveryOf = (): { probedAtMs: number; targetCount: number; servers: Server[] } | null => {
  if (seam.discovered.length === 0) return null
  if (snapshot?.key !== seam.discovered) snapshot = { key: seam.discovered, value: { probedAtMs: Date.now(), targetCount: 1, servers: seam.discovered } }
  return snapshot.value
}

const realEngine = await import('../../src/services/tensorfold/engine.ts')
const realInstall = await import('../../src/services/tensorfold/install.ts')
const realInventory = await import('../../src/services/tensorfold/inventory.ts')
const realServe = await import('../../src/services/tensorfold/serve.ts')
const realPull = await import('../../src/services/tensorfold/pull.ts')
const realPod = await import('../../src/services/host/tensorfoldPod.ts')
const realHosts = await import('../../src/services/providers/local/tensorfoldHosts.ts')
const realHelper = await import('../../src/services/providers/local/tensorfoldHelper.ts')
const realApp = await import('../../src/services/providers/local/tensorfoldApp.ts')
const realSupport = await import('../../src/services/providers/local/tensorfoldSupport.ts')
const realDiscovery = await import('../../src/services/providers/local/localDiscovery.ts')
const realAnnouncer = await import('../../src/services/lan/announcer.ts')
const realProve = await import('../../src/services/localSetup/setupProve.ts')
const realReceipts = await import('../../src/utils/model/seatReceipts.ts')
const readDiskInventory = realInventory.readTensorFoldInventory
const bestOnDisk = realInventory.bestTensorFoldFit

mock.module('../../src/services/tensorfold/engine.js', () => ({
  ...realEngine,
  findTensorFoldEngine: async () => seam.engine,
  tensorFoldMachine: () => seam.machine,
  cachedTensorFoldMachineTruth: async () => truthOf(seam.machine),
}))
mock.module('../../src/services/tensorfold/install.js', () => ({
  ...realInstall,
  tensorFoldInstallPlan: () => ({ kind: 'brew', commands: ['brew install ashhart/tensorfold/tensorfold'], words: 'Homebrew · ashhart/tensorfold', found: 'Homebrew found' }),
  installTensorFold: async (_plan: unknown, onLine: (line: string) => void) => {
    roadCalls.push(['install'])
    onLine('==> Downloading')
    seam.engine = ENGINE
    return { ok: true, line: '' }
  },
}))
mock.module('../../src/services/tensorfold/inventory.js', () => ({
  ...realInventory,
  readTensorFoldInventory: async (engine: TensorFoldEngine | null, io: Record<string, unknown> = {}) => {
    if (seam.inventory === 'disk') return readDiskInventory(engine, io)
    return engine === null ? seam.inventory.map(row => ({ ...row, state: 'not-pulled' as const })) : seam.inventory
  },
  bestTensorFoldFit: (rows: readonly TensorFoldModelRow[]) => (seam.inventory === 'disk' ? bestOnDisk(rows) : (rows.find(row => row.repo === seam.best) ?? null)),
}))
mock.module('../../src/services/tensorfold/serve.js', () => ({
  ...realServe,
  startTensorFold: async (request: StartRequest) => {
    roadCalls.push(['start', request])
    if (seam.start !== undefined) return seam.start(request)
    return { repo: request.repo, name: request.name ?? request.repo, port: request.port ?? 8080, window: request.window, pid: 1, startedAt: 't' }
  },
  stopTensorFold: async (name: string) => {
    roadCalls.push(['stop', name])
  },
  servedTensorFold: () => seam.served,
  readServedRecord: () => null,
  tensorFoldWillRun: willRunOf,
  tensorFoldPairingCode: () => null,
}))
mock.module('../../src/services/tensorfold/pull.js', () => ({
  ...realPull,
  pullTensorFold: async (repo: string) => {
    roadCalls.push(['pull', repo])
  },
}))
mock.module('../../src/services/host/tensorfoldPod.js', () => ({
  ...realPod,
  tensorFoldPodRows: () => seam.pods ?? [],
  stopTensorFoldPod: async (id: string) => {
    roadCalls.push(['stop-pod', id])
    return { ok: true, words: 'runpod pod stopped · compute billing ended · ~$0.24 so far · the disk bills until you terminate it in /llmhost' }
  },
}))
mock.module('../../src/services/providers/local/tensorfoldHosts.js', () => ({
  ...realHosts,
  rememberTensorFoldHost: async (host: TensorFoldHost & { key?: string; chip?: string }) => {
    remembered.push({ ...host })
    const { key, ...rest } = host
    seam.hosts = [...seam.hosts.filter(known => known.name !== host.name), { ...rest, baseUrl: realHosts.tensorFoldHostRoot(host.baseUrl), ...(key !== undefined ? { keyRef: 'stored' } : {}) }]
  },
  forgetTensorFoldHost: async () => undefined,
  tensorFoldHosts: () => seam.hosts,
}))
mock.module('../../src/services/providers/local/tensorfoldHelper.js', () => ({
  ...realHelper,
  helperHeadingWords: () => seam.helper,
}))
mock.module('../../src/services/providers/local/tensorfoldApp.js', () => ({
  ...realApp,
  detectTensorFoldApp: async () => seam.app ?? { running: false },
}))
mock.module('../../src/services/providers/local/tensorfoldSupport.js', () => ({
  ...realSupport,
  tensorFoldSupportLine: () => 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture',
  readTensorFoldSupportLine: async (focus?: unknown) => {
    supportCalls.push(focus)
    return 'TensorFold 1.2.2 · Metal · Apple M5 Pro · fixture'
  },
}))
mock.module('../../src/services/providers/local/localDiscovery.js', () => ({
  ...realDiscovery,
  getCachedLocalDiscovery: () => discoveryOf(),
  cachedLocalModels: () => seam.discovered.flatMap(server => server.models),
  refreshLocalDiscovery: async () => discoveryOf() ?? { probedAtMs: Date.now(), targetCount: 0, servers: [] },
}))
mock.module('../../src/services/lan/announcer.js', () => ({
  ...realAnnouncer,
  browseAnnouncements: async () => seam.announced,
}))
mock.module('../../src/services/localSetup/setupProve.js', () => ({
  ...realProve,
  pickAndProve: async (tag: string) => {
    roadCalls.push(['prove', tag])
    return { ok: true, settled: 'applied', words: `${tag} is this session's model`, model: `local/${tag}` }
  },
}))
mock.module('../../src/utils/model/seatReceipts.js', () => ({
  ...realReceipts,
  mintImmediateReceipt: (text: string) => {
    receipts.push(text)
  },
}))

const React = await import('react')
const h = React.createElement
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { Box } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.tsx')
const { ANTHROPIC_MODEL_GROUP, OPENAI_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
const { readModelTensorFoldFacts } = await import('../../src/components/tensorfold/tensorfoldModelFacts.ts')
const { tensorFoldCapableMachine, refreshTensorFoldAnnouncements, tensorFoldAnnouncementsNow, pairTensorFoldHost } = await import('../../src/components/tensorfold/tensorfoldFacts.ts')
const road = await import('../../src/commands/tensorfold/road.ts')
const { TensorFoldPanel } = await import('../../src/commands/tensorfold/tensorfold.tsx')
const modelCommand = await import('../../src/commands/model/mercuryModel.tsx')
const pairing = await import('../../src/services/lan/pairing.ts')
const { gridToPng } = await import('./gridToPng.ts')
type Facts = Awaited<ReturnType<typeof readModelTensorFoldFacts>>['picker']
type Act = import('../../src/components/tensorfold/tensorfoldRows.ts').TensorFoldAct

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

const SIZES: Array<[number, number]> = [[160, 48], [110, 34], [96, 30]]
const DISK_FREE = 37_578_240_000
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
const PEER = realAnnouncer.announcerMachineName() === 'Air' ? 'Air 2' : 'Air'
const WRONG = 'that pairing code is not the one shown on the serving Mac'

function installed(machine: TensorFoldMachine = MAC_48): TensorFoldModelRow[] {
  return [rowOf(QWEN_27B, 'not-pulled', machine), rowOf(LIGHTNING, 'not-pulled', machine), rowOf(QWEN_2B, 'on-disk', machine, { bytesOnDisk: QWEN_2B.download }), rowOf(LLAMA, 'on-disk', machine)]
}

async function factsFor(next: Partial<Seam>, platform?: NodeJS.Platform): Promise<Facts> {
  seam = { ...DEFAULT_SEAM, inventory: installed(), best: QWEN_27B.repo, ...next }
  const read = await readModelTensorFoldFacts({
    ...(platform !== undefined ? { platform } : {}),
    engine: seam.engine as never,
    machine: truthOf(seam.machine),
    served: seam.served,
    hosts: () => seam.hosts,
    helper: () => seam.helper,
    app: async () => seam.app ?? { running: false },
    pods: () => seam.pods ?? [],
    localModels: () => seam.discovered.flatMap(server => server.models) as never,
    diskFreeBytes: () => DISK_FREE,
    home: SOMEONE,
    cacheRoot: HUB,
  })
  return read.picker
}

type Run = { m: Mounted; acts: Act[]; selected: string[]; closed: () => number; columns: number; rows: number }

const shell = (element: unknown, columns: number, rows: number): unknown =>
  h(AppStateProvider as never, {} as never, h(ThemeProvider as never, {} as never, h(KeybindingSetup as never, null as never, h(Box, { flexDirection: 'column', width: columns, height: rows, justifyContent: 'center' }, element as never))))

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
    onTensorFold: (act: Act) => {
      acts.push(act)
    },
    onSelect: (id: string) => {
      selected.push(id)
    },
    onClose: () => {
      closed++
    },
  } as never)
  const m = await mountOffscreen(shell(picker, columns, rows), columns, rows)
  await waitFor(() => m.screen().includes('Mercury · model'), 8000)
  await settle(250)
  return { m, acts, selected, closed: () => closed, columns, rows }
}

async function press(run: Pick<Run, 'm'>, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    run.m.push(key)
    await settle(140)
  }
  await settle(160)
}

const inner = (line: string): string => line.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '')
const flat = (run: Pick<Run, 'm'>): string[] => run.m.lines().map(line => inner(inner(line)).replace(/\s+$/, ''))
const has = (run: Pick<Run, 'm'>, words: string): boolean => flat(run).some(line => line.includes(words))
const count = (run: Pick<Run, 'm'>, words: string): number => flat(run).filter(line => line.includes(words)).length
const cells = (run: Pick<Run, 'm'>, ...parts: string[]): boolean => flat(run).some(line => new RegExp(parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s{2,}')).test(line))
const lineOf = (run: Pick<Run, 'm'>, words: string): number => flat(run).findIndex(line => line.includes(words))
const legendOf = (run: Pick<Run, 'm'>): string => flat(run).find(line => line.includes('↑↓ select') || line.includes('esc back')) ?? ''

async function focusHeading(run: Pick<Run, 'm'>, words: string): Promise<boolean> {
  for (const key of [KEY.up, KEY.down]) {
    for (let step = 0; step < 30; step++) {
      if (flat(run).some(line => line.startsWith(`❯ ${words}`))) return true
      await press(run, [key])
    }
  }
  return flat(run).some(line => line.startsWith(`❯ ${words}`))
}

async function frameRow(run: Pick<Run, 'm'>, id: string): Promise<boolean> {
  const framed = (): boolean => {
    const lines = run.m.lines()
    const top = lines.findIndex(line => /│\s*╭/.test(line))
    return top >= 0 && (lines[top + 1] ?? '').includes(id)
  }
  for (let step = 0; step < 30 && !framed(); step++) await press(run, [KEY.down])
  return framed()
}

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
const DOWN = KEY.down
const RIGHT = KEY.right

console.log('§1 the frames m01–m05, m03b and the app, win32, 32 GB and outside-server states at 160×48, 110×34 and 96×30, against DESIGN §2–§4 and the frames; /model reads them through the panel lane\'s facts (readTensorFoldPanelFacts + pickerFactsOf)')
for (const [columns, rows] of SIZES) {
  const at = `${columns}x${rows}`
  {
    const run = await open(await factsFor({}), 'claude-opus-5-5', columns, rows)
    await save('m01-model-first-open', run)
    check(`${at} m01: TENSORFOLD pinned first, folded, with its status words`, has(run, '▸ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served'), flat(run).filter(l => l.includes('TENSORFOLD')).join(' | '))
    check(`${at} m01: TENSORFOLD HOST beneath it, folded`, has(run, '▸ TENSORFOLD HOST · no host · a server on your network or a rented GPU pod') && lineOf(run, '▸ TENSORFOLD HOST') === lineOf(run, '▸ TENSORFOLD ·') + 1)
    check(`${at} m01: both above the cloud provider, which keeps its own heading and current row`, lineOf(run, '▸ TENSORFOLD HOST') < lineOf(run, '▾ ANTHROPIC · Claude Max login · 2 live') && cells(run, 'Opus 5.5', 'claude-opus-5-5', 'current', '1M ctx'))
    check(`${at} m01: no live count on the TensorFold headings`, !flat(run).some(l => /TENSORFOLD.*\d+ live/.test(l)))
    check(`${at} m01: the legend is the picker's own`, has(run, LEGEND_PICKER), legendOf(run))
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
    check(`${at} m02: a checkpoint on disk of a family TensorFold does not serve is never listed`, !flat(run).some(l => l.includes('llama')))
    check(`${at} m02: the legend says what ↵ does here, the window keys and c`, has(run, '↑↓ select · ↵ pull, serve and switch · ←→ window · c copies the support line'), legendOf(run))
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
    check(`${at} m03: c copies the support line is in the legend`, has(run, 'c copies the support line'), legendOf(run))
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
    check(`${at} m03b: ↵ switches`, has(run, '↑↓ select · ↵ switch'), legendOf(run))
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
    check(`${at} m04: s stops, the window, n and c in the legend`, has(run, '↑↓ select · s stops · ←→ window · n shares it · c copies the support line'), legendOf(run))
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
    const inventory = [rowOf(QWEN_27B, 'not-pulled', MAC_32, {}, 'offer'), rowOf(LIGHTNING, 'not-pulled', MAC_32), rowOf(QWEN_2B, 'on-disk', MAC_32)]
    const run = await open(await factsFor({ machine: MAC_32, engine: { ...ENGINE, chip: 'Apple M4 Pro' }, inventory, best: LIGHTNING.repo }), 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, UP, RIGHT, UP, RIGHT])
    await frameRow(run, 'local/qwen3.8-27b')
    await save('m08-model-gpu-limit', run)
    check(`${at} 32 GB: Lightning is the best fit on top; the 27B says it needs the GPU limit raised, an estimate`, lineOf(run, 'Nemotron Lightning') < lineOf(run, 'Qwen3.8 27B') && has(run, 'fit       needs the GPU limit raised · w · an estimate'), flat(run).slice(4, 18).join(' | '))
    check(`${at} 32 GB: the card shows the exact command w copies first, with its cost`, has(run, `will run  ${LIMIT_LINE}`) && has(run, 'cost      resets at reboot; restart the engine after it'), flat(run).slice(4, 20).join(' | '))
    check(`${at} 32 GB: w raises the limit in the legend, no ↵ there`, has(run, '↑↓ select · w raise the limit') && !has(run, '↵ pull, serve and switch'), legendOf(run))
    run.m.unmount()
    await settle(60)
  }
  {
    const inventory = [rowOf(QWEN_27B, 'not-pulled', MAC_32, {}, 'none'), rowOf(LIGHTNING, 'not-pulled', MAC_32), rowOf(QWEN_2B, 'on-disk', MAC_32)]
    const run = await open(await factsFor({ machine: MAC_32, engine: { ...ENGINE, chip: 'Apple M4 Pro' }, inventory, best: LIGHTNING.repo }), 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, UP, RIGHT, UP, RIGHT])
    await frameRow(run, 'local/qwen3.8-27b')
    await save('m08b-model-gpu-limit-no-offer', run)
    check(`${at} 32 GB, no safe limit: the card says why and what to do, and w is not offered`, has(run, 'fit       past what macOS lets the GPU wire · lower the window or choose a smaller') && !has(run, 'sudo sysctl') && !has(run, 'w raise the limit'), [...flat(run).slice(4, 18), legendOf(run)].join(' | '))
    run.m.unmount()
    await settle(60)
  }
  {
    const discovered: Server[] = [{ kind: 'tensorfold', root: 'http://127.0.0.1:8087', baseUrl: 'http://127.0.0.1:8087/v1', label: 'TensorFold 1.2.2', version: '1.2.2', models: [{ id: 'qwen3.5-2b', server: 'tensorfold', baseUrl: 'http://127.0.0.1:8087/v1', contextWindow: { tokens: 32_768, source: 'served' }, servedBytes: 2_965_982_016 }] }]
    const run = await open(await factsFor({ inventory: [rowOf(QWEN_27B, 'not-pulled', MAC_48), rowOf(LIGHTNING, 'not-pulled', MAC_48)], discovered }), 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, UP, RIGHT])
    await save('m09-model-served-outside', run)
    check(`${at} outside: a server started by hand is a serving row in TENSORFOLD with its window set outside`, cells(run, 'qwen3.5-2b', 'local/qwen3.5-2b', 'serving', '32k ctx', '2.8 GiB in use') && has(run, 'window    32k · set when it started outside Mercury, which does not stop or restart it') && has(run, '1 serving'), flat(run).slice(4, 14).join(' | '))
    check(`${at} outside: s is never offered on it; ↵ switches`, !has(run, 's stops') && has(run, '↑↓ select · ↵ switch'), legendOf(run))
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
  const typed = await open(await factsFor({ inventory: [rowOf(QWEN_27B, 'not-pulled', MAC_48), rowOf(QWEN_2B, 'serving', MAC_48, { port: 8080, startedBy: 'mercury' })] }), 'claude-opus-5-5', 160, 48)
  await press(typed, ['s', 'o', 'n'])
  check('from any row that is not a TensorFold row a typed letter searches: s, o, n type "son" and the rows narrow to Sonnet 5, nothing acts', flat(typed).some(line => /\/ son/.test(line)) && cells(typed, 'Sonnet 5', 'claude-sonnet-5') && !cells(typed, 'Opus 5.5', 'claude-opus-5-5') && typed.acts.length === 0, [...flat(typed).slice(0, 12), JSON.stringify(typed.acts)].join(' | '))
  typed.m.unmount()
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
  check("↵ on a host row switches through the picker's own road", run.selected.at(-1) === 'local/qwen3.8-27b', run.selected.join(','))
  await press(run, [KEY.down, KEY.down, KEY.enter, 'a', 'i', 'r', '.', 'l', 'o', 'c', 'a', 'l', ':', '8', '0', '8', '0', KEY.enter])
  const address = run.acts.at(-1)
  check('the address row takes host:port and hands it on', address?.kind === 'address' && address.address === 'air.local:8080', JSON.stringify(address ?? null))
  run.m.unmount()
  await settle(60)
}
{
  const inventory = [rowOf(QWEN_27B, 'not-pulled', MAC_32, {}, 'offer'), rowOf(LIGHTNING, 'not-pulled', MAC_32), rowOf(QWEN_2B, 'on-disk', MAC_32)]
  const run = await open(await factsFor({ machine: MAC_32, inventory, best: LIGHTNING.repo }), 'claude-opus-5-5', 160, 48)
  await press(run, [UP, UP, UP, RIGHT, UP, RIGHT])
  await frameRow(run, 'local/qwen3.8-27b')
  await press(run, ['w'])
  const limit = run.acts.at(-1)
  check('w hands on exactly the bare sysctl command, never the prose around it (Mercury never runs it)', limit?.kind === 'limit' && limit.line === LIMIT_LINE, JSON.stringify(limit ?? null).slice(0, 200))
  run.m.unmount()
  await settle(60)
  const none = [rowOf(QWEN_27B, 'not-pulled', MAC_32, {}, 'none'), rowOf(LIGHTNING, 'not-pulled', MAC_32), rowOf(QWEN_2B, 'on-disk', MAC_32)]
  const quiet = await open(await factsFor({ machine: MAC_32, inventory: none, best: LIGHTNING.repo }), 'claude-opus-5-5', 160, 48)
  await press(quiet, [UP, UP, UP, RIGHT, UP, RIGHT])
  await frameRow(quiet, 'local/qwen3.8-27b')
  await press(quiet, ['w'])
  check('with no safe limit to offer, w does nothing', !quiet.acts.some(act => act.kind === 'limit'), JSON.stringify(quiet.acts).slice(0, 200))
  quiet.m.unmount()
  await settle(60)
}

console.log('\n§3 the order rule and the facts the /model group reads')
{
  const used = await open(await factsFor({}), 'claude-opus-5-5', 160, 48, { fresh: false, uses: { [ANTHROPIC_MODEL_GROUP]: 100, tensorfold: 50 } })
  check('TensorFold used before the cloud provider: after the current provider, ahead of the never-used one, the pair adjacent', lineOf(used, '▾ ANTHROPIC') < lineOf(used, '▸ TENSORFOLD ·') && lineOf(used, '▸ TENSORFOLD HOST') === lineOf(used, '▸ TENSORFOLD ·') + 1 && lineOf(used, '▸ TENSORFOLD HOST') < lineOf(used, '▾ OPENAI'), flat(used).filter(l => /[▾▸❯] [A-Z]/.test(l)).join(' | '))
  used.m.unmount()
  await settle(60)
  check('a machine that can run TensorFold: Apple silicon, or Linux with the R580+ NVIDIA driver loaded', tensorFoldCapableMachine('darwin', 'arm64') && !tensorFoldCapableMachine('darwin', 'x64') && tensorFoldCapableMachine('linux', 'x64', () => 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.95.05') && !tensorFoldCapableMachine('linux', 'x64', () => undefined) && !tensorFoldCapableMachine('win32', 'x64', () => 'Kernel Module  580.95.05'))
  const facts = await factsFor({ hosts: [STUDIO], app: APP })
  check("the app's engine, detected by process (tf-engine-106's reader), becomes the app row and never a host row", facts.app?.serving === 'qwen3.5-2b' && facts.hosts?.length === 1)
  const helped = await factsFor({ helper: '· helper 2B' })
  check("the helper suffix comes from the one heading reader (tf-engine-106's helperHeadingWords)", helped.helper === '· helper 2B')
  const POD: TensorFoldHost = { name: 'pod-7f3a', baseUrl: 'http://127.0.0.1:41234', origin: 'pod', keyRef: 'pod-7f3a', serving: 'qwen3.8-27b', version: '1.2.2', chip: 'RTX 5090', window: 131_072 }
  const POD_ROW: PodRow = { hostName: 'pod-7f3a', id: '7f3a', provider: 'pod-7f3a-runpod', words: '$1.19/h on Runpod · 12 min · ~$0.24 so far · s stops the pod and its billing', bills: true, state: 'serving', title: 'Qwen3.8 27B', served: 'qwen3.8-27b', window: 131_072, gpu: 'RTX 5090', vendor: 'Runpod' }
  const SETTING_UP: PodRow = { hostName: 'pod-7f3b', id: '7f3b', words: '$1.19/h on Runpod · 3 min · ~$0.06 so far · s stops the pod and its billing', bills: true, state: 'starting', title: 'Qwen3.8 27B', served: 'qwen3.8-27b', window: 131_072, gpu: 'RTX 5090', vendor: 'Runpod', step: 'pulling TensorFold/Qwen3.8-27B-MLX-4bit' }
  const STOPPED: PodRow = { hostName: 'pod-7f3c', id: '7f3c', words: 'stopped · compute billing ended · ~$0.31 so far · the disk bills until you terminate it in /llmhost', bills: false, state: 'stopped', title: 'Qwen3.8 27B', served: 'qwen3.8-27b', window: 131_072, gpu: 'RTX 5090', vendor: 'Runpod' }
  const PAUSED: PodRow = { hostName: 'pod-7f3d', id: '7f3d', words: '$0.53/h on Vast.ai · 9 min · ~$0.08 so far · s stops the pod and its billing', bills: true, state: 'paused', title: 'Qwen3.8 27B', served: 'qwen3.8-27b', window: 131_072, gpu: 'RTX 5090', vendor: 'Vast.ai', step: 'paused at starting engine' }
  const tunnel: Server[] = [{ kind: 'tensorfold', root: 'http://127.0.0.1:41234', baseUrl: 'http://127.0.0.1:41234/v1', label: 'TensorFold 1.2.2', version: '1.2.2', models: [{ id: 'qwen3.8-27b', server: 'tensorfold', baseUrl: 'http://127.0.0.1:41234/v1' }] }]
  const pod = await open(await factsFor({ hosts: [POD], discovered: tunnel, pods: [POD_ROW] }), 'claude-opus-5-5', 160, 48)
  await press(pod, [UP, UP, RIGHT])
  check("a rented pod's loopback tunnel is a TENSORFOLD HOST row, never a served row on this machine", cells(pod, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'serving', '128k ctx', 'pod-7f3a') === false && has(pod, 'pod-7f3a · 1 serving') && has(pod, '▸ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served'), flat(pod).filter(l => /TENSORFOLD|pod-7f3a/.test(l)).join(' | '))
  check("the pod row's card carries tf-host-106's pod line (price, time, spend, s) under the host line", has(pod, 'host      RTX 5090 · TensorFold 1.2.2 · keyed') && !has(pod, '127.0.0.1:41234') && has(pod, 'window    128k · set when the pod was rented') && has(pod, 'pod       $1.19/h on Runpod · 12 min · ~$0.24 so far · s stops the pod and its billing'), flat(pod).slice(4, 16).join(' | '))
  check('the legend offers s stops the pod', has(pod, '↑↓ select · ↵ switch · s stops the pod'), legendOf(pod))
  await press(pod, ['s'])
  const stopPod = pod.acts.at(-1)
  check("s on the pod row hands the pod's id on (tf-host-106's stopTensorFoldPod ends its billing)", stopPod?.kind === 'stop-pod' && stopPod.id === '7f3a' && stopPod.name === 'pod-7f3a', JSON.stringify(stopPod ?? null))
  await press(pod, [KEY.enter])
  check("↵ on the pod row switches to the pod through its compat road, named for the pod's endpoint", pod.selected.at(-1) === 'compat/pod-7f3a-runpod/qwen3.8-27b', pod.selected.join(','))
  pod.m.unmount()
  await settle(60)
  const rented = await open(await factsFor({ hosts: [], pods: [SETTING_UP, STOPPED, PAUSED] }), 'claude-opus-5-5', 160, 48)
  await press(rented, [UP, UP, RIGHT])
  await frameRow(rented, 'compat/pod-7f3b/qwen3.8-27b')
  check('a pod is visible from the moment it is rented: the HOST heading names the live pods and counts every state', has(rented, '▾ TENSORFOLD HOST · pod-7f3b · pod-7f3d · 1 setting up · 1 stopped · 1 paused'), flat(rented).filter(l => l.includes('TENSORFOLD HOST')).join(' | '))
  check('the setting-up pod is a row in the columns: name, its pod id, setting up, the window, the card', cells(rented, 'Qwen3.8 27B', 'compat/pod-7f3b/qwen3.8-27b', 'setting up', '128k ctx', 'RTX 5090'), flat(rented).filter(l => l.includes('pod-7f3b')).join(' | '))
  check("the framed setting-up row's card: the pod line with price, time and spend, then what it is doing now", has(rented, 'pod       RTX 5090 · $1.19/h on Runpod · 3 min · ~$0.06 so far · s stops the pod and its') && has(rented, 'now       pulling TensorFold/Qwen3.8-27B-MLX-4bit'), flat(rented).filter(l => /^(pod|now|paused|next) {2,}/.test(l.trim())).join(' / '))
  check('the stopped pod stays listed with its disk-billing words and no s; the paused pod names its cause and the next step', cells(rented, 'Qwen3.8 27B', 'compat/pod-7f3c/qwen3.8-27b', 'stopped', '128k ctx', 'RTX 5090') && cells(rented, 'Qwen3.8 27B', 'compat/pod-7f3d/qwen3.8-27b', 'paused', '128k ctx', 'RTX 5090'), flat(rented).filter(l => l.includes('pod-7f3')).join(' | '))
  check('the legend on a setting-up pod offers s stops the pod and no switch', legendOf(rented).includes('s stops the pod') && !legendOf(rented).includes('↵ switch'), legendOf(rented))
  await press(rented, ['s'])
  const stopRented = rented.acts.at(-1)
  check("s on the setting-up pod hands its id on", stopRented?.kind === 'stop-pod' && stopRented.id === '7f3b' && stopRented.name === 'pod-7f3b', JSON.stringify(stopRented ?? null))
  await frameRow(rented, 'compat/pod-7f3d/qwen3.8-27b')
  check("the paused pod's card carries its cause and the next step", has(rented, 'paused    starting engine') && has(rented, 'next      Resume or Terminate in /llmhost'), flat(rented).filter(l => /^(pod|now|paused|next) {2,}/.test(l.trim())).join(' / '))
  rented.m.unmount()
  await settle(60)
  const SHARED: TensorFoldHost = { name: realAnnouncer.announcerMachineName(), baseUrl: 'http://127.0.0.1:8080', origin: 'shared', keyRef: 'stored', serving: 'qwen3.5-2b', version: '1.2.2', window: 262_144 }
  const ownAnnouncement: Browsed[] = [{ name: realAnnouncer.announcerMachineName(), host: 'localhost', port: 52_000, txt: { model: 'qwen3.5-2b', engine: '8080', pair: '52000', keyed: '1' } }]
  process.env.MERCURY_LOCAL_PROBE_TARGETS = PROBING_ON
  for (const [columns, rows] of SIZES) {
    const at = `${columns}x${rows}`
    const base = await factsFor({ hosts: [SHARED], announced: ownAnnouncement, inventory: [rowOf(QWEN_27B, 'not-pulled', MAC_48), rowOf(QWEN_2B, 'serving', MAC_48, { port: 8080, startedBy: 'mercury' })] })
    await refreshTensorFoldAnnouncements()
    const facts = { ...base, announced: tensorFoldAnnouncementsNow(seam.hosts) }
    const shared = await open(facts, 'claude-opus-5-5', columns, rows)
    await press(shared, [UP, UP, RIGHT])
    await save('m12-model-host-shared', shared)
    check(`${at} m12: this Mac's own shared server reads as this Mac under TENSORFOLD HOST, shared on this network, keyed`, has(shared, '▾ TENSORFOLD HOST · this Mac · 1 serving') && cells(shared, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'shared', '256k ctx', 'this Mac') && has(shared, 'host      this Mac · TensorFold 1.2.2') && has(shared, 'network   shared on this network · keyed'), flat(shared).filter(l => /TENSORFOLD HOST|shared|this Mac/.test(l)).join(' | '))
    check(`${at} m12: never a pairable row — its own announcement is not listed and ↵ offers neither pairing nor a switch`, facts.announced.length === 0 && !has(shared, 'not paired') && !has(shared, '↵ pair') && !has(shared, '↑↓ select · ↵ switch'), [legendOf(shared), JSON.stringify(facts.announced)].join(' | '))
    shared.m.unmount()
    await settle(60)
  }
  process.env.MERCURY_LOCAL_PROBE_TARGETS = PROBING_OFF
}

console.log("\n§4 /model keeps no TensorFold road of its own: every key but pairing goes to the panel lane's onTensorFoldAct (tf-panel-106)")
{
  const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'commands', 'model', 'mercuryModel.tsx'), 'utf8')
  check('mercuryModel.tsx starts, stops, pulls, installs and copies nothing for TensorFold itself', !/\b(startTensorFold|stopTensorFold|pullTensorFold|installTensorFold|installTensorFoldThen|stopTensorFoldPod|readTensorFoldSupportLine|readOtherCheckpoint)\b/.test(source) && source.includes("import { onTensorFoldAct } from '../tensorfold/tensorfold.js'"), 'mercuryModel.tsx')
  const { servedByTensorFold, tensorFoldPodEndpoints } = modelCommand
  const endpoints = tensorFoldPodEndpoints([{ id: '7f3a' }], [{ name: 'pod-7f3a-runpod', hostPodId: '7f3a' }, { name: 'pod-other', hostPodId: 'abcd' }, { name: 'plain' }])
  check('a compat endpoint whose hostPodId names a TensorFold pod leaves the custom-endpoint group (it lives under TENSORFOLD HOST); other pods and plain endpoints stay', [...endpoints].join(',') === 'pod-7f3a-runpod' && servedByTensorFold({ id: 'compat/pod-7f3a-runpod/qwen3.8-27b', group: 'OpenAI-compatible' }, endpoints) && servedByTensorFold({ id: '__mercury_connect__:compat/pod-7f3a-runpod', group: 'OpenAI-compatible' }, endpoints) && !servedByTensorFold({ id: 'compat/pod-other/m', group: 'OpenAI-compatible' }, endpoints) && !servedByTensorFold({ id: 'compat/plain/m', group: 'OpenAI-compatible' }, endpoints), [...endpoints].join(','))
}

console.log('\n§5 the review rows: an announced Mac pairs with its code (finding 3), on-disk checkpoints TensorFold has not qualified (finding 4), and a refused serve reads the same on /model and /tensorfold (finding 9)')
{
  const announcedAt = (host: string, port: number): Browsed[] => [{ name: PEER, host, port, txt: { model: 'qwen3.8-27b', engine: '8099', pair: String(port), keyed: '1', window: '131072', version: '1.2.2', chip: 'Apple_M3_Ultra' } }]
  process.env.MERCURY_LOCAL_PROBE_TARGETS = PROBING_ON
  for (const [columns, rows] of SIZES) {
    const at = `${columns}x${rows}`
    const base = await factsFor({ announced: announcedAt('air.local', 51234) })
    await refreshTensorFoldAnnouncements()
    const facts = { ...base, announced: tensorFoldAnnouncementsNow(seam.hosts) }
    const run = await open(facts, 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, RIGHT])
    await save('m10-model-host-announced', run)
    check(`${at} m10: a Mac announcing on the network is listed under TENSORFOLD HOST before it is paired`, has(run, `▾ TENSORFOLD HOST · ${PEER} · 1 serving`) && cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'not paired', '128k ctx', PEER), flat(run).filter(l => /TENSORFOLD|not paired/.test(l)).join(' | '))
    check(`${at} m10: its card: the host, the pairing road, plain HTTP on the network`, has(run, 'host      air.local:8099 · Apple M3 Ultra · TensorFold 1.2.2 · keyed') && has(run, `pair      ↵ asks once for the pairing code shown on ${PEER}`) && has(run, 'network   plain HTTP on your home or office network, not across the internet'), flat(run).slice(4, 16).join(' | '))
    check(`${at} m10: ↵ pairs with its code`, has(run, '↑↓ select · ↵ pair with its code'), legendOf(run))
    await press(run, [KEY.enter, '4', '2', 'x', '7'])
    await save('m10b-model-host-code', run)
    check(`${at} m10b: ↵ asks for the code in the typed-row grammar, digits only`, has(run, 'code      427▌') && has(run, 'type the pairing code · ↵ pair · esc back'), [...flat(run).slice(4, 16), legendOf(run)].join(' | '))
    await press(run, [KEY.enter])
    const pair = run.acts.at(-1)
    check(`${at} m10b: ↵ hands the announced host and the typed code on`, pair?.kind === 'pair' && pair.code === '427' && pair.host.name === PEER && pair.host.pairPort === 51234, JSON.stringify(pair ?? null).slice(0, 200))
    run.m.unmount()
    await settle(60)
  }
  const server = await pairing.startPairingServer({ model: 'qwen3.8-27b', enginePort: 8099, window: 131_072, version: '1.2.2', chip: 'Apple M3 Ultra', key: 'a'.repeat(48), name: PEER }, { listenHost: '127.0.0.1', announce: false })
  seam = { ...DEFAULT_SEAM, inventory: installed(), best: QWEN_27B.repo, announced: announcedAt('127.0.0.1', server.port) }
  await refreshTensorFoldAnnouncements()
  const host = tensorFoldAnnouncementsNow(seam.hosts)[0]
  const wrongWords = host === undefined ? 'no host' : await pairTensorFoldHost(host, server.code === '000000' ? '111111' : '000000')
  const refused = tensorFoldAnnouncementsNow(seam.hosts)[0]
  check('a wrong code pairs nothing, remembers nothing, and the row keeps the reason', wrongWords === undefined && refused?.refused === WRONG && remembered.length === 0, JSON.stringify({ wrongWords, refused }))
  for (const [columns, rows] of SIZES) {
    const at = `${columns}x${rows}`
    const facts = { ...(await factsFor({ announced: seam.announced })), announced: tensorFoldAnnouncementsNow([]) }
    const run = await open(facts, 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, RIGHT])
    await save('m10c-model-host-wrong-code', run)
    check(`${at} m10c: a wrong code says so once, on the row's card, and ↵ asks again`, count(run, WRONG) === 1 && has(run, `refused   ${WRONG}`) && has(run, '↑↓ select · ↵ pair with its code'), [...flat(run).slice(4, 16), legendOf(run)].join(' | '))
    run.m.unmount()
    await settle(60)
  }
  await server.stop()

  console.log('  — /model itself: the code road pairs the announced Mac and the row becomes a host row')
  const live = await pairing.startPairingServer({ model: 'qwen3.8-27b', enginePort: 8099, window: 131_072, version: '1.2.2', chip: 'Apple M3 Ultra', key: 'b'.repeat(48), name: PEER }, { listenHost: '127.0.0.1', announce: false })
  seam = { ...DEFAULT_SEAM, inventory: installed(), best: QWEN_27B.repo, announced: announcedAt('127.0.0.1', live.port) }
  remembered.length = 0
  road.__resetTensorFoldRoadForTest()
  const element = await modelCommand.call(() => undefined, { messages: [], options: {} } as never, '')
  const model = { m: await mountOffscreen(shell(element, 160, 48), 160, 48) }
  const listed = await waitFor(() => flat(model).some(line => line.includes(`TENSORFOLD HOST · ${PEER} · 1 serving`)), 10_000)
  check('/model lists the announced Mac under TENSORFOLD HOST', listed, flat(model).filter(l => l.includes('TENSORFOLD')).join(' | '))
  const onHost = await focusHeading(model, 'TENSORFOLD HOST')
  await press(model, [RIGHT])
  check('/model frames the announced row with its pairing road', onHost && has(model, `pair      ↵ asks once for the pairing code shown on ${PEER}`), flat(model).slice(2, 20).join(' | '))
  await press(model, [KEY.enter, ...(live.code === '000000' ? '111111' : '000000').split(''), KEY.enter])
  await waitFor(() => has(model, WRONG), 5000)
  check('/model: a wrong code says so once and pairs nothing', count(model, WRONG) === 1 && remembered.length === 0, JSON.stringify({ lines: flat(model).filter(l => l.includes('pairing code')), remembered }))
  await press(model, [KEY.enter, ...live.code.split(''), KEY.enter])
  const paired = await waitFor(() => cells(model, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'serving', '128k ctx', PEER), 6000)
  const kept = remembered.at(-1)
  check('/model: the right code pairs it — lane 2\'s pairWithHost, the key kept by rememberTensorFoldHost as a lan-paired host', paired && kept?.origin === 'lan-paired' && kept.key === 'b'.repeat(48) && kept.baseUrl === 'http://127.0.0.1:8099' && kept.serving === 'qwen3.8-27b', JSON.stringify({ kept, lines: flat(model).filter(l => l.includes(PEER)) }))
  check('/model: the row is a normal host row now, ↵ switches, and the notice names what to do next', !has(model, 'not paired') && has(model, `paired with ${PEER} · ↵ on its row switches to qwen3.8-27b`), [...flat(model).filter(l => l.includes(PEER) || l.includes('paired')), legendOf(model)].join(' | '))
  model.m.unmount()
  await settle(80)
  await live.stop()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = PROBING_OFF

  console.log('  — finding 4: the Hugging Face cache read through the panel lane\'s inventory')
  const weights = (repo: string, config: Record<string, unknown>, bytes: number): void => {
    const dir = join(HUB, `models--${repo.replace('/', '--')}`, 'snapshots', 'fixture')
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(HUB, `models--${repo.replace('/', '--')}`, 'refs'), { recursive: true })
    writeFileSync(join(HUB, `models--${repo.replace('/', '--')}`, 'refs', 'main'), 'fixture')
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
    writeFileSync(join(dir, 'model.safetensors'), '')
    truncateSync(join(dir, 'model.safetensors'), bytes)
  }
  weights('mlx-community/Qwen3.5-9B-MLX-4bit', { model_type: 'qwen3_5', text_config: { model_type: 'qwen3_5_text', num_hidden_layers: 32, num_attention_heads: 16, num_key_value_heads: 4, head_dim: 256, hidden_size: 4096, max_position_embeddings: 262_144, full_attention_interval: 4 }, quantization: { bits: 4, group_size: 64 } }, 5_950_221_072)
  weights('mlx-community/Llama-3.3-8B-Instruct-4bit', { model_type: 'llama', num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, hidden_size: 4096, max_position_embeddings: 131_072, quantization: { bits: 4, group_size: 64 } }, 4_517_000_000)
  for (const [columns, rows] of SIZES) {
    const at = `${columns}x${rows}`
    const run = await open(await factsFor({ inventory: 'disk' }), 'claude-opus-5-5', columns, rows)
    await press(run, [UP, UP, UP, RIGHT])
    await frameRow(run, 'local/qwen3.5-9b')
    await save('m11-model-unqualified-on-disk', run)
    check(`${at} m11: a Qwen checkpoint on disk that is not a starting point is listed, on disk, unqualified by TensorFold`, cells(run, 'Qwen3.5 9B', 'local/qwen3.5-9b', 'on disk') && flat(run).some(l => /local\/qwen3\.5-9b\s{2,}on disk\s{2,}\S+ ctx\s{2,}unqualified/.test(l)) && has(run, 'note      unqualified by TensorFold'), flat(run).slice(4, 20).join(' | '))
    check(`${at} m11: the pinned starting points keep their rank above it; a family TensorFold cannot serve is not listed`, lineOf(run, 'local/qwen3.8-27b') < lineOf(run, 'local/qwen3.5-9b') && !flat(run).some(l => /llama/i.test(l)), flat(run).filter(l => l.includes('local/')).join(' | '))
    check(`${at} m11: never a download, never the best fit`, !cells(run, 'Qwen3.5 9B', 'local/qwen3.5-9b', '↓') && lineOf(run, 'Qwen3.5 9B') > lineOf(run, 'Qwen3.8 27B'))
    run.m.unmount()
    await settle(60)
  }
  const bare = await open(await factsFor({ inventory: 'disk', engine: null }), 'claude-opus-5-5', 160, 48)
  await press(bare, [UP, UP, UP, RIGHT, UP, RIGHT])
  check('with TensorFold not installed (no capabilities to read), nothing unqualified is listed', !has(bare, 'qwen3.5-9b') && !flat(bare).some(l => /llama/i.test(l)), flat(bare).filter(l => l.includes('local/')).join(' | '))
  bare.m.unmount()
  await settle(60)

  console.log('  — finding 9: a refused serve, from /model and from /tensorfold')
  const REFUSAL = { kind: 'memory' as const, line: 'not enough memory for the KV cache at 131072 tokens', needGib: 28.5, leftGib: 25.2, window: 131_072, nextWindow: 65_536, cacheGibAt: 4 }
  const refusedOn = async (screen: 'model' | 'tensorfold'): Promise<{ card: string[]; receipts: string[]; calls: string[] }> => {
    seam = { ...DEFAULT_SEAM, inventory: installed(), best: QWEN_27B.repo, start: async () => { throw new realServe.TensorFoldStartError('refused', REFUSAL) } }
    road.__resetTensorFoldRoadForTest()
    receipts.length = 0
    roadCalls.length = 0
    process.env.MERCURY_LOCAL_PROBE_TARGETS = PROBING_ON
    const node = screen === 'model' ? await modelCommand.call(() => undefined, { messages: [], options: {} } as never, '') : h(TensorFoldPanel as never, { onDone: () => undefined, io: { current: () => 'claude-opus-5-5' } } as never)
    const mounted = { m: await mountOffscreen(shell(node, 160, 48), 160, 48) }
    await waitFor(() => flat(mounted).some(line => line.includes('TENSORFOLD · 1.2.2')), 10_000)
    if (screen === 'model') {
      await focusHeading(mounted, 'TENSORFOLD ·')
      await press(mounted, [RIGHT])
    }
    await frameRow(mounted, 'local/qwen3.8-27b')
    await press(mounted, [KEY.enter])
    await waitFor(() => flat(mounted).some(line => line.startsWith('refused')), 6000)
    await settle(300)
    const lines = flat(mounted)
    const card = lines.filter(line => /^(refused|window)\s/.test(line) || line.includes('local/qwen3.8-27b'))
    mounted.m.unmount()
    await settle(80)
    process.env.MERCURY_LOCAL_PROBE_TARGETS = PROBING_OFF
    return { card, receipts: [...receipts], calls: roadCalls.map(call => String(call[0])) }
  }
  const fromModel = await refusedOn('model')
  const fromPanel = await refusedOn('tensorfold')
  check('/model serves through the panel lane\'s road: pull, then start, then refused', fromModel.calls.join(',') === 'pull,start' && fromPanel.calls.join(',') === 'pull,start', JSON.stringify({ model: fromModel.calls, panel: fromPanel.calls }))
  check('the refused card reads the same on /model and /tensorfold — TensorFold\'s line, the stepped-down window', fromModel.card.some(line => line === `refused   ${REFUSAL.line}`) && JSON.stringify(fromModel.card) === JSON.stringify(fromPanel.card), JSON.stringify({ model: fromModel.card, panel: fromPanel.card }))
  check('the same feed receipts from both — the refusal with c copies the support line', fromModel.receipts.at(-1)?.startsWith('▲ TensorFold refused qwen3.8-27b at 128k') === true && fromModel.receipts.at(-1)?.includes('c copies the support line') === true && JSON.stringify(fromModel.receipts) === JSON.stringify(fromPanel.receipts), JSON.stringify({ model: fromModel.receipts, panel: fromPanel.receipts }))
}

await releaseScratchHome(home)
console.log(failures === 0 ? '\nprove-tensorfold-model-groups: ALL GREEN' : `\nprove-tensorfold-model-groups: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
