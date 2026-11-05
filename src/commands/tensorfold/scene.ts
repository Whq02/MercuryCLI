import { statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { bytesWords } from '../../services/host/bank.js'
import { currentHostRecipes } from '../../services/host/recipesFile.js'
import { tensorFoldPodRows, tensorFoldRentFacts, tensorFoldRentRow, type TensorFoldPodRowFacts } from '../../services/host/tensorfoldPod.js'
import { gibWords, tokensWords } from '../../services/localServer/localServerMemory.js'
import { LOCAL_SERVER_NAMES } from '../../services/providers/local/localCatalogue.js'
import { cachedLocalModels, type LocalModelRecord } from '../../services/providers/local/localDiscovery.js'
import { detectTensorFoldApp, type TensorFoldAppState } from '../../services/providers/local/tensorfoldApp.js'
import { helperHeadingWords } from '../../services/providers/local/tensorfoldHelper.js'
import { tensorFoldHosts } from '../../services/providers/local/tensorfoldHosts.js'
import { lastTensorFoldTurn } from '../../services/providers/local/tensorfoldUsage.js'
import type { TensorFoldEngine, TensorFoldHost, TensorFoldLastReply, TensorFoldServed } from '../../services/tensorfold/contracts.js'
import { cachedTensorFoldMachineTruth, findTensorFoldEngine, tensorFoldBackendWords, type EngineIo, type TensorFoldEngineFound } from '../../services/tensorfold/engine.js'
import type { TensorFoldMachineTruth } from '../../services/tensorfold/fit.js'
import { tensorFoldInstallPlan, type InstallIo, type TensorFoldInstallPlan } from '../../services/tensorfold/install.js'
import { isLoopbackUrl } from '../../utils/privacyLevel.js'
import { bestTensorFoldFit, hfCacheRoot, hfCacheWords, readTensorFoldInventory, type InventoryIo, type TensorFoldInventoryRow } from '../../services/tensorfold/inventory.js'
import { pullPace, pullPercent, pullProgressWords, type PullPace } from '../../services/tensorfold/pull.js'
import { refusalNextStep, refusedWords, wiredLimitCommand, wiredLimitCostWords, type TensorFoldRefusal } from '../../services/tensorfold/refusal.js'
import { rememberedTensorFoldPort, servedTensorFold, TENSORFOLD_DEFAULT_PORT, TENSORFOLD_HOST, type ServeIo } from '../../services/tensorfold/serve.js'
import { TENSORFOLD_RELEASE } from '../../services/tensorfold/starting.js'
import { TENSORFOLD_WORDS as W } from './words.js'

export type TensorFoldAct =
  | { kind: 'installing'; line?: string }
  | { kind: 'pulling'; bytes: number; totalBytes?: number; percent?: number; pace: PullPace; then: { window: number } }
  | { kind: 'starting'; name: string; port: number; seconds: number }
  | { kind: 'refused'; name: string; window: number; refusal: TensorFoldRefusal; words: string; nextWindow?: number; cacheGibAt?: number; leftGib?: number; command?: string; cost?: string; remedy?: string }
  | { kind: 'exited'; name: string; port: number; line: string }
  | { kind: 'tight'; needBytes: number; freeBytes: number; offers: readonly string[] }

export type TensorFoldOutsideServer = {
  name: string
  baseUrl: string
  port: number
  window?: number
  keyed: boolean
  current: boolean
  inUseBytes?: number
  lastReply?: { firstTokenMs?: number; tokensPerSecond?: number }
}

export type TensorFoldPanelFacts = {
  platform: NodeJS.Platform
  engine: TensorFoldEngine | null
  machine: { chip: string; usableGib?: number; ramGib?: number; backend: string; usableSource?: string }
  install: TensorFoldInstallPlan | null
  rows: readonly TensorFoldInventoryRow[]
  served: readonly TensorFoldServed[]
  outside: readonly TensorFoldOutsideServer[]
  hosts: readonly TensorFoldHost[]
  helper?: string
  app?: string
  rent?: { pod: string; serves: string; title: string }
  pods: readonly TensorFoldPodRowFacts[]
  current?: string
  landing?: string
  acts: Readonly<Record<string, TensorFoldAct>>
  other?: { input: string; refused?: string; read?: TensorFoldInventoryRow }
  port: { next: number; busy?: { port: number; answersAs?: string } }
  keyed?: { address: string }
  disk?: { freeBytes: number; cacheWords: string }
  live: string
  copySupportOffered: boolean
}

type TensorFoldTurnFacts = { model: string; address: string; tokensPerSecond?: number; timeToFirstTokenS?: number }

export type FactsIo = EngineIo & InventoryIo & InstallIo & Pick<ServeIo, 'servedFile' | 'helperFile'> & {
  engine?: TensorFoldEngineFound | null
  machine?: TensorFoldMachineTruth
  localModels?: () => readonly LocalModelRecord[]
  lastTurn?: () => TensorFoldTurnFacts | undefined
  keyedAt?: (port: number) => Promise<boolean>
  hosts?: () => readonly TensorFoldHost[]
  helper?: () => string | undefined
  app?: () => Promise<TensorFoldAppState>
  rent?: () => { pod: string; serves: string; title: string } | undefined
  pods?: () => readonly TensorFoldPodRowFacts[]
  current?: string
  diskFreeBytes?: (path: string) => number | undefined
}

export type FactsState = {
  acts: Readonly<Record<string, TensorFoldAct>>
  other?: TensorFoldPanelFacts['other']
}

const EMPTY_STATE: FactsState = { acts: {} }

function defaultDiskFree(path: string): number | undefined {
  try {
    const stats = statfsSync(path)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return undefined
  }
}

function portOf(baseUrl: string): number | undefined {
  try {
    return Number(new URL(baseUrl).port || 80)
  } catch {
    return undefined
  }
}

function loopbackPortOf(baseUrl: string): number | undefined {
  if (!isLoopbackUrl(baseUrl)) return undefined
  try {
    return Number(new URL(baseUrl).port || 80)
  } catch {
    return undefined
  }
}

function outsideOf(records: readonly LocalModelRecord[], served: readonly TensorFoldServed[], helper: readonly TensorFoldServed[], hosts: readonly TensorFoldHost[], current: string | undefined): TensorFoldOutsideServer[] {
  const ports = new Set([...served, ...helper].map(row => row.port))
  for (const host of hosts) {
    const tunnel = host.origin === 'shared' ? undefined : loopbackPortOf(host.baseUrl)
    if (tunnel !== undefined) ports.add(tunnel)
  }
  const out: TensorFoldOutsideServer[] = []
  for (const record of records) {
    if (record.server !== 'tensorfold') continue
    const port = loopbackPortOf(record.baseUrl)
    if (port === undefined || ports.has(port)) continue
    const window = record.contextWindow?.tokens
    out.push({ name: record.id, baseUrl: record.baseUrl, port, ...(window !== undefined ? { window } : {}), keyed: false, current: current !== undefined && current.endsWith(`/${record.id}`), ...(record.servedBytes !== undefined ? { inUseBytes: record.servedBytes } : {}) })
  }
  return out
}

function lastReplyOf(turn: TensorFoldTurnFacts | undefined, name: string, port: number): TensorFoldLastReply | undefined {
  if (turn === undefined || turn.address !== servedAddress(port) || (turn.model !== name && !turn.model.endsWith(`/${name}`))) return undefined
  return { ...(turn.timeToFirstTokenS !== undefined ? { firstTokenMs: turn.timeToFirstTokenS * 1000 } : {}), ...(turn.tokensPerSecond !== undefined ? { tokensPerSecond: turn.tokensPerSecond } : {}) }
}

function withServedReadings(rows: readonly TensorFoldInventoryRow[], records: readonly LocalModelRecord[], turn: TensorFoldTurnFacts | undefined): TensorFoldInventoryRow[] {
  return rows.map(row => {
    if (row.state !== 'serving' || row.startedBy !== 'mercury' || row.port === undefined) return row
    const port = row.port
    const record = records.find(candidate => candidate.server === 'tensorfold' && portOf(candidate.baseUrl) === port)
    const lastReply = lastReplyOf(turn, row.shortName, port)
    return { ...row, ...(record?.servedBytes !== undefined ? { inUseBytes: record.servedBytes } : {}), ...(lastReply !== undefined ? { lastReply } : {}) }
  })
}

async function defaultKeyedAt(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${TENSORFOLD_HOST}:${port}/v1/models`, { signal: AbortSignal.timeout(400) })
    return response.status === 401 || response.status === 403
  } catch {
    return false
  }
}

function answersAsOf(records: readonly LocalModelRecord[], port: number): string | undefined {
  records = records.filter(record => isLoopbackUrl(record.baseUrl))
  const hit = records.find(record => {
    try {
      return Number(new URL(record.baseUrl).port) === port
    } catch {
      return false
    }
  })
  return hit === undefined ? undefined : LOCAL_SERVER_NAMES[hit.server]
}

function quietly<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function defaultRent(): { pod: string; serves: string; title: string } | undefined {
  const row = tensorFoldRentRow([], currentHostRecipes())
  return row === undefined ? undefined : tensorFoldRentFacts(row)
}

export async function readTensorFoldPanelFacts(io: FactsIo = {}, state: FactsState = EMPTY_STATE): Promise<TensorFoldPanelFacts> {
  const platform = io.platform ?? process.platform
  const machine = io.machine ?? (await cachedTensorFoldMachineTruth(io))
  const engine = platform === 'win32' ? null : io.engine !== undefined ? io.engine : await findTensorFoldEngine(io)
  const served = io.served ?? servedTensorFold(io)
  const helperServed = quietly(() => servedTensorFold({ ...io, role: 'helper' }), [] as readonly TensorFoldServed[])
  const records = io.localModels?.() ?? cachedLocalModels()
  const rows = platform === 'win32' ? [] : withServedReadings(await readTensorFoldInventory(engine, { ...io, machine, served }), records, quietly(() => (io.lastTurn ?? lastTensorFoldTurn)(), undefined))
  const current = io.current
  const hosts = quietly(() => io.hosts?.() ?? tensorFoldHosts(), [] as readonly TensorFoldHost[])
  const outside = outsideOf(records, served, helperServed, hosts, current)
  const helper = quietly(() => (io.helper ?? helperHeadingWords)(), undefined)
  const app = platform === 'darwin' ? await (io.app ?? detectTensorFoldApp)().catch(() => undefined) : undefined
  const rent = quietly(() => (io.rent ?? defaultRent)(), undefined)
  const pods = quietly(() => (io.pods ?? (() => tensorFoldPodRows(currentHostRecipes())))(), [] as readonly TensorFoldPodRowFacts[])
  const install = engine === null && platform !== 'win32' ? tensorFoldInstallPlan(machine, { ...io, platform }) : platform === 'win32' ? tensorFoldInstallPlan({ platform, ...(machine.gpu ? { gpu: machine.gpu } : {}) }, { ...io, platform }) : null
  const remembered = rememberedTensorFoldPort(io)
  const preferred = served[0]?.port ?? remembered ?? TENSORFOLD_DEFAULT_PORT
  const takenOutside = outside.find(server => server.port === preferred)
  const keyed = served.length === 0 && takenOutside === undefined && answersAsOf(records, preferred) === undefined && !helperServed.some(row => row.port === preferred) && platform !== 'win32' ? await (io.keyedAt ?? defaultKeyedAt)(preferred) : false
  const busyAs = takenOutside !== undefined || keyed ? 'TensorFold' : answersAsOf(records, preferred)
  const port = served.length > 0 ? { next: preferred } : busyAs !== undefined ? { next: preferred + 1, busy: { port: preferred, answersAs: busyAs } } : { next: preferred }
  const root = io.cacheRoot ?? hfCacheRoot(io.env ?? process.env, io.home ?? homedir())
  const freeBytes = (io.diskFreeBytes ?? defaultDiskFree)(root)
  const facts: Omit<TensorFoldPanelFacts, 'live' | 'copySupportOffered'> = {
    platform,
    engine,
    machine: { chip: machine.chip, usableGib: machine.usableBytes / 1024 ** 3, ramGib: machine.ramBytes / 1024 ** 3, backend: tensorFoldBackendWords(engine, platform), usableSource: machine.usableSource },
    install,
    rows,
    served,
    outside,
    hosts,
    ...(helper !== undefined ? { helper } : {}),
    ...(app?.engine !== undefined ? { app: app.engine.model ?? 'a model' } : {}),
    ...(rent !== undefined ? { rent } : {}),
    pods,
    ...(current !== undefined ? { current } : {}),
    acts: state.acts,
    ...(state.other !== undefined ? { other: state.other } : {}),
    port,
    ...(keyed ? { keyed: { address: servedAddress(preferred) } } : {}),
    ...(freeBytes !== undefined ? { disk: { freeBytes, cacheWords: hfCacheWords(root, io.home ?? homedir()) } } : {}),
  }
  const landing = landingOf(facts)
  return { ...facts, ...(landing !== undefined ? { landing } : {}), live: liveLineOf(facts), copySupportOffered: Object.values(state.acts).some(act => act.kind === 'refused' || act.kind === 'exited' || act.kind === 'tight') }
}

function landingOf(facts: Pick<TensorFoldPanelFacts, 'rows' | 'served' | 'outside' | 'install' | 'platform' | 'acts'>): string | undefined {
  const acting = Object.entries(facts.acts).find(([, act]) => act.kind === 'pulling' || act.kind === 'starting' || act.kind === 'refused' || act.kind === 'exited' || act.kind === 'tight')
  if (acting !== undefined) return acting[0]
  if (facts.served.length > 0) return facts.served[0]!.repo
  if (facts.outside.length > 0) return `outside:${facts.outside[0]!.port}`
  if (facts.install !== null && (facts.install.kind === 'needs-brew' || facts.install.kind === 'archive' || facts.install.kind === 'no-gpu' || facts.install.kind === 'old-driver')) return 'install'
  if (facts.platform === 'win32') return 'rent'
  return bestTensorFoldFit(facts.rows)?.repo ?? facts.rows[0]?.repo
}

export function servedAddress(port: number): string {
  return `${TENSORFOLD_HOST}:${port}`
}

function liveLineOf(facts: Omit<TensorFoldPanelFacts, 'live' | 'copySupportOffered'>): string {
  if (facts.platform === 'win32') return W.windowsLive
  const installing = facts.acts.install
  if (installing?.kind === 'installing') return `installing TensorFold ${TENSORFOLD_RELEASE} with Homebrew`
  if (facts.engine === null) return facts.install?.found ?? W.notInstalled
  for (const [repo, act] of Object.entries(facts.acts)) {
    const row = facts.rows.find(candidate => candidate.repo === repo)
    if (act.kind === 'pulling') return pullProgressWords(row?.label ?? repo, act.bytes, act.totalBytes, act.pace)
    if (act.kind === 'starting') return `starting ${act.name} on ${servedAddress(act.port)} · loading · ${act.seconds} s`
  }
  if (facts.keyed !== undefined) return `${facts.keyed.address} answers with a key · /health shows status only`
  const served = facts.served[0]
  if (served !== undefined) {
    const row = facts.rows.find(candidate => candidate.repo === served.repo)
    return `serving ${served.name} on ${servedAddress(served.port)} · ${replyWords(row?.lastReply)}`
  }
  const outside = facts.outside[0]
  if (outside !== undefined) return `serving ${outside.name} on ${servedAddress(outside.port)} · ${replyWords(outside.lastReply)}`
  const host = facts.hosts.find(candidate => candidate.serving !== undefined && candidate.origin !== 'shared')
  if (host !== undefined) return `nothing served here · ${host.name} serves ${host.serving}`
  return `${W.nothingServed} · ${facts.machine.backend}`
}

function replyWords(reply: { firstTokenMs?: number; tokensPerSecond?: number } | undefined): string {
  const speed = reply?.tokensPerSecond !== undefined ? `~${Math.round(reply.tokensPerSecond)} tok/s` : undefined
  if (reply?.firstTokenMs !== undefined) return [`first reply in ${Math.round(reply.firstTokenMs)} ms`, speed].filter(part => part !== undefined).join(' · ')
  return ['idle', speed].filter(part => part !== undefined).join(' · ')
}

export function pullActOf(repo: string, samples: readonly { at: number; bytes: number }[], totalBytes: number | undefined, window: number): TensorFoldAct {
  const last = samples[samples.length - 1]
  const bytes = last?.bytes ?? 0
  const percent = pullPercent(bytes, totalBytes)
  return { kind: 'pulling', bytes, ...(totalBytes !== undefined ? { totalBytes } : {}), ...(percent !== undefined ? { percent } : {}), pace: pullPace(samples, totalBytes), then: { window } }
}

export function refusedActOf(name: string, window: number, refusal: TensorFoldRefusal): TensorFoldAct {
  const offer = refusal.kind === 'gpu-limit' ? (refusal.wired?.offer ?? null) : null
  return {
    kind: 'refused',
    name,
    window,
    refusal,
    words: refusedWords(refusal, name),
    ...(refusal.nextWindow !== undefined ? { nextWindow: refusal.nextWindow } : {}),
    ...(refusal.cacheGibAt !== undefined ? { cacheGibAt: refusal.cacheGibAt } : {}),
    ...(refusal.leftGib !== undefined ? { leftGib: refusal.leftGib } : {}),
    ...(offer !== null ? { command: wiredLimitCommand(offer), cost: wiredLimitCostWords(offer) } : {}),
    ...(refusal.kind === 'gpu-limit' && offer === null ? { remedy: refusalNextStep(refusal) } : {}),
  }
}

export const FEED = {
  serves: (name: string, window: number, port: number, switched = true): string => `● TensorFold serves ${name} · ${tokensWords(window)} on ${servedAddress(port)} · ${switched ? "this session's model" : 'your default model'}`,
  servesElsewhere: (name: string, port: number, busy: number, window: number, switched = true): string => `● TensorFold serves ${name} on ${servedAddress(port)} · ${busy} was in use · ${tokensWords(window)}${switched ? '' : ' · your default model'}`,
  pulled: (label: string, bytes: number): string => `● TensorFold pulled ${label} · ${bytesWords(bytes)} · starting it`,
  stopped: (name: string): string => `◌ TensorFold stopped ${name} · /tensorfold serves it again`,
  refused: (name: string, window: number, refusal: TensorFoldRefusal): string => {
    const numbers = refusal.needGib !== undefined && refusal.leftGib !== undefined ? ` (needs ${refusal.needGib.toFixed(1)} GiB, ${refusal.leftGib.toFixed(1)} GiB left)` : ''
    return `▲ TensorFold refused ${name} at ${tokensWords(window)}${numbers} · /tensorfold · ${W.copySupport}`
  },
  portBusy: (port: number): string => `▲ TensorFold could not listen on ${servedAddress(port)} · /tensorfold takes the next free port · ${W.copySupport}`,
  gpuLimit: (name: string, window: number): string => `▲ TensorFold refused ${name} at ${tokensWords(window)} · macOS's GPU limit · /tensorfold shows the fix · ${W.copySupport}`,
  exited: (name: string, port: number): string => `▲ TensorFold exited · ${name} on ${servedAddress(port)} · /tensorfold starts it again · ${W.copySupport}`,
  pullFailed: (label: string, line: string): string => `▲ TensorFold could not pull ${label} · ${line} · /tensorfold tries again · ${W.copySupport}`,
  notInstalled: (): string => '▲ TensorFold is not installed · /tensorfold installs it',
  notServed: (name: string): string => `▲ ${name} is not served · /tensorfold serves it`,
  tight: (need: number, free: number, offers: readonly string[]): string => `▲ TensorFold needs ${gibWords(need)} · ${gibWords(free)} free${offers.length > 0 ? ` · ${offers.join(' · ')}` : ''} · ${W.copySupport}`,
} as const
