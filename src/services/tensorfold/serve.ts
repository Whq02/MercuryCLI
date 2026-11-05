import { readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { freemem } from 'node:os'
import { dirname, join } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { getCwd } from '../../utils/cwd.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { announcerMachineName } from '../lan/announcer.js'
import { startPairingServer } from '../lan/pairing.js'
import { gibWords } from '../localServer/localServerMemory.js'
import type { ServiceRecord, ServiceSpec } from '../projectServices/contracts.js'
import { readRecord, reconcileRecord, startService, stopService, waitForReady } from '../projectServices/serviceManager.js'
import { detectTensorFoldApp, refuseSecondCopy, type TensorFoldAppState } from '../providers/local/tensorfoldApp.js'
import { forgetTensorFoldHost, forgetTensorFoldPort, rememberTensorFoldHost, rememberTensorFoldPort } from '../providers/local/tensorfoldHosts.js'
import { writeTensorFoldKeyFile } from '../providers/local/tensorfoldKeyFile.js'
import { ADAPTER_SERVED_BY, adapterChildPidFile, isAdapterEntry, servedByAdapter } from './adapter/identity.js'
import { adapterCheckpointOf } from './adapter/models.js'
import type { TensorFoldEngine, TensorFoldHost, TensorFoldModelRow, TensorFoldPullProgress, TensorFoldServeRequest, TensorFoldServeRole, TensorFoldServed } from './contracts.js'
import { cachedTensorFoldMachineTruth, engineServedByAdapter, findTensorFoldEngine, tensorFoldCommand, tensorFoldCommandWords, type EngineIo } from './engine.js'
import { runForOutput, tensorFoldLadder, tensorFoldProjectedBytes, type TensorFoldMachineTruth } from './fit.js'
import { pullCommandLines, pullTensorFold as pullWithEngine, type PullIo } from './pull.js'
import { readTensorFoldRefusal, type TensorFoldRefusal } from './refusal.js'
import { PROMPT_CACHE_OPT_IN_FAMILIES, startingPointOf, tensorFoldShortName, type TensorFoldCheckpoint } from './starting.js'

export const TENSORFOLD_SERVICES: Readonly<Record<TensorFoldServeRole, string>> = { session: 'tensorfold', helper: 'tensorfold-helper' }
const TENSORFOLD_RECORD_FILES: Readonly<Record<TensorFoldServeRole, string>> = { session: 'served.json', helper: 'helper.json' }
export const TENSORFOLD_DEFAULT_PORT = 8080
export const TENSORFOLD_HOST = '127.0.0.1'
const TENSORFOLD_DRAIN_SECONDS = 4
const TENSORFOLD_START_WAIT_MS = 15 * 60_000
const TENSORFOLD_MEMORY_TIGHT_GIB = 2

type TensorFoldServedRecord = TensorFoldServed & { project: string; busy?: { port: number; answersAs?: string }; sharedAs?: string; servedBy?: string }

export type TensorFoldServedByEngine = TensorFoldServed & { servedBy?: string }

type TensorFoldPortPick = { port: number; busy?: { port: number; answersAs?: string } }

type TensorFoldAnnounceOffer = { model: string; enginePort: number; window: number; key: string }

type TensorFoldAnnouncement = { stop: () => void; code?: string }

export type TensorFoldSharedHost = TensorFoldHost & { key: string }

export type ServeIo = EngineIo & {
  binary?: string
  cwd?: string
  sessionId?: string
  role?: TensorFoldServeRole
  startWaitMs?: number
  signal?: AbortSignal
  onLoading?: (seconds: number) => void
  onPort?: (pick: TensorFoldPortPick) => void
  freeMemoryBytes?: () => Promise<number>
  machine?: TensorFoldMachineTruth
  app?: () => Promise<TensorFoldAppState>
  answersAs?: (port: number) => Promise<string | undefined>
  rememberPort?: (port: number) => void
  forgetPort?: (port: number) => void
  rememberHost?: (host: TensorFoldSharedHost) => Promise<void>
  forgetHost?: (name: string) => Promise<void>
  machineName?: () => string
  servedFile?: string
  helperFile?: string
  serviceEnv?: Record<string, string>
  sleep?: (ms: number) => Promise<void>
  keyFile?: () => { path: string; key: string; line: string }
  announce?: (offer: TensorFoldAnnounceOffer) => TensorFoldAnnouncement | Promise<TensorFoldAnnouncement>
}

const TENSORFOLD_SHARE_HOST = '0.0.0.0'

let announcement: ({ name: string } & TensorFoldAnnouncement) | null = null

export function tensorFoldAnnouncing(): string | null {
  return announcement?.name ?? null
}

export function tensorFoldPairingCode(): string | null {
  return announcement?.code ?? null
}

async function announceOnNetwork(offer: TensorFoldAnnounceOffer): Promise<TensorFoldAnnouncement> {
  const pairing = await startPairingServer(offer, { listenHost: TENSORFOLD_SHARE_HOST })
  return { stop: () => void pairing.stop().catch(() => undefined), code: pairing.code }
}

function endAnnouncement(): void {
  try {
    announcement?.stop()
  } catch {
    void 0
  }
  announcement = null
}

export class TensorFoldStartError extends Error {
  constructor(message: string, public readonly refusal: TensorFoldRefusal | null, public readonly tight: { needBytes: number; freeBytes: number; offers: string[] } | null = null) {
    super(message)
  }
}

type RoleIo = Pick<ServeIo, 'role' | 'servedFile' | 'helperFile'>

function roleOf(io: RoleIo): TensorFoldServeRole {
  return io.role ?? 'session'
}

function otherRole(role: TensorFoldServeRole): TensorFoldServeRole {
  return role === 'session' ? 'helper' : 'session'
}

function recordFile(io: RoleIo = {}): string {
  const served = io.servedFile ?? join(getMercuryHome(), 'tensorfold', TENSORFOLD_RECORD_FILES.session)
  if (roleOf(io) === 'session') return served
  return io.helperFile ?? join(dirname(served), TENSORFOLD_RECORD_FILES.helper)
}

export function readServedRecord(io: RoleIo = {}): TensorFoldServedRecord | null {
  try {
    const raw = JSON.parse(readFileSync(recordFile(io), 'utf8')) as TensorFoldServedRecord
    return typeof raw.repo === 'string' && typeof raw.port === 'number' && typeof raw.project === 'string' ? raw : null
  } catch {
    return null
  }
}

function writeServedRecord(record: TensorFoldServedRecord | null, io: RoleIo = {}): void {
  publishAtomicSync(recordFile(io), JSON.stringify(record) + '\n', { mode: 0o600 })
}

export function servedTensorFold(io: RoleIo = {}): readonly TensorFoldServedByEngine[] {
  const record = readServedRecord(io)
  if (record === null) return []
  const service = reconcileRecord(record.project, TENSORFOLD_SERVICES[roleOf(io)])
  if (service === null || !['starting', 'ready', 'running'].includes(service.state) || service.pid === null) return []
  const { project: _project, busy: _busy, sharedAs: _sharedAs, ...served } = record
  return [{ ...served, pid: service.pid }]
}

function servedTensorFoldRecord(io: RoleIo = {}): (TensorFoldServedRecord & { service: ServiceRecord }) | null {
  const record = readServedRecord(io)
  if (record === null) return null
  const service = reconcileRecord(record.project, TENSORFOLD_SERVICES[roleOf(io)])
  if (service === null) return null
  return { ...record, service }
}

export function rememberedTensorFoldPort(io: RoleIo = {}): number | undefined {
  return readServedRecord(io)?.port
}

function checkpointFor(repo: string, adapter: boolean): TensorFoldCheckpoint | undefined {
  return adapter ? adapterCheckpointOf(repo) : startingPointOf(repo)
}

const LIVE_STATES = ['starting', 'ready', 'running']

function heldBytesOf(record: (TensorFoldServedRecord & { service: ServiceRecord }) | null, adapter: boolean, states: readonly string[]): number {
  if (record === null || !states.includes(record.service.state)) return 0
  const point = checkpointFor(record.repo, adapter)
  if (point === undefined) return 0
  return tensorFoldProjectedBytes({ ...point, ...(record.promptCacheGib !== undefined ? { promptCacheGib: record.promptCacheGib } : {}) }, record.window)
}

const loadingBytesOf = (record: (TensorFoldServedRecord & { service: ServiceRecord }) | null, adapter: boolean): number => heldBytesOf(record, adapter, ['starting'])

async function forgetShared(sharedAs: string | undefined, io: Pick<ServeIo, 'forgetHost'>): Promise<void> {
  if (sharedAs === undefined) return
  try {
    await (io.forgetHost ?? forgetTensorFoldHost)(sharedAs)
  } catch {
    void 0
  }
}

function serveArgs(point: Pick<TensorFoldCheckpoint, 'repo' | 'shortName' | 'drafter' | 'promptCacheGib'>, window: number, port: number, name = point.shortName, share?: { keyFile: string }): string[] {
  return [
    'serve',
    point.repo,
    ...(point.drafter !== undefined ? ['--drafter', point.drafter.repo] : []),
    '--name',
    name,
    '--context',
    String(window),
    ...(point.promptCacheGib !== undefined ? ['--prompt-cache-gib', String(point.promptCacheGib)] : []),
    ...(share !== undefined ? ['--host', TENSORFOLD_SHARE_HOST, '--api-key-file', share.keyFile] : []),
    '--port',
    String(port),
  ]
}

function serveCommandLine(point: Pick<TensorFoldCheckpoint, 'repo' | 'shortName' | 'drafter' | 'promptCacheGib'>, window: number, port: number, name?: string, program = 'tensorfold'): string {
  return [program, ...serveArgs(point, window, port, name)].join(' ')
}

function checkpointOfRow(row: TensorFoldModelRow, adapter: boolean): Pick<TensorFoldCheckpoint, 'repo' | 'shortName' | 'drafter' | 'promptCacheGib'> {
  const point = checkpointFor(row.repo, adapter)
  if (point !== undefined) return point
  return {
    repo: row.repo,
    shortName: row.shortName,
    ...(row.drafter !== undefined ? { drafter: { repo: row.drafter, weightsBytes: 0, downloadBytes: 0 } } : {}),
    ...(row.promptCacheGib !== undefined ? { promptCacheGib: row.promptCacheGib } : PROMPT_CACHE_OPT_IN_FAMILIES.has(row.family) ? { promptCacheGib: 1 } : {}),
  }
}

export function tensorFoldWillRun(row: TensorFoldModelRow, window: number, engine?: Pick<TensorFoldEngine, 'binary' | 'servedBy'> | null): string[] {
  const port = row.port ?? rememberedTensorFoldPort() ?? TENSORFOLD_DEFAULT_PORT
  const adapter = engineServedByAdapter(engine)
  const program = engine ? tensorFoldCommandWords(engine.binary) : 'tensorfold'
  const pulls = row.state === 'not-pulled' || row.state === 'pulling' ? pullCommandLines(row.repo, program) : []
  return [...pulls, serveCommandLine(checkpointOfRow(row, adapter), window, port, undefined, program)]
}

async function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

export async function pickTensorFoldPort(preferred: number, io: Pick<ServeIo, 'answersAs'> = {}, free: (port: number) => Promise<boolean> = portFree): Promise<TensorFoldPortPick> {
  if (await free(preferred)) return { port: preferred }
  const answersAs = await io.answersAs?.(preferred)
  for (let port = preferred + 1; port < preferred + 50; port += 1) {
    if (await free(port)) return { port, busy: { port: preferred, ...(answersAs !== undefined ? { answersAs } : {}) } }
  }
  throw new TensorFoldStartError(`no free port from ${preferred} on`, null)
}

async function defaultFreeMemory(platform: NodeJS.Platform, run: (file: string, args: string[]) => Promise<string | undefined>): Promise<number> {
  if (platform !== 'darwin') return freemem()
  const text = (await run('/usr/bin/vm_stat', [])) ?? ''
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  const counts = ['free', 'inactive', 'speculative'].map(name => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(text)?.[1]))
  if (!page || counts.some(value => !Number.isFinite(value))) return freemem()
  return counts.reduce((sum, value) => sum + value, 0) * page
}

export function memoryOffers(records: readonly { name: string }[], ollamaRunning: boolean): string[] {
  const offers: string[] = []
  if (ollamaRunning) offers.push('ollama stop frees its model')
  if (records.some(record => record.name === 'local-gguf')) offers.push("s on Mercury's own llama.cpp server stops it")
  return offers
}

export function tensorFoldServiceSpec(binary: string, point: Pick<TensorFoldCheckpoint, 'repo' | 'shortName' | 'drafter' | 'promptCacheGib'>, window: number, port: number, cwd: string, name?: string, extraEnv: Record<string, string> = {}, share?: { keyFile: string }, role: TensorFoldServeRole = 'session'): ServiceSpec {
  const { command, args } = tensorFoldCommand(binary)
  return {
    name: TENSORFOLD_SERVICES[role],
    command,
    args: [...args, ...serveArgs(point, window, port, name, share)],
    cwd,
    env: { ...extraEnv, TF_DRAIN_S: String(TENSORFOLD_DRAIN_SECONDS), TENSORFOLD_NO_UPDATE_CHECK: '1', TENSORFOLD_NO_LIVE: '1' },
    readiness: [{ kind: 'http', url: `http://${TENSORFOLD_HOST}:${port}/health` }],
    readinessMode: 'all',
    restart: 'never',
    lifecycle: 'project',
  }
}

function logTail(record: ServiceRecord | null, bytes = 65_536): string {
  if (record === null) return ''
  try {
    const size = statSync(record.logFile).size
    const start = Math.max(record.logStartByte ?? 0, size - bytes)
    return readFileSync(record.logFile, 'utf8').slice(start)
  } catch {
    return ''
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function startTensorFold(request: TensorFoldServeRequest, io: ServeIo = {}): Promise<TensorFoldServedByEngine> {
  const role = request.role ?? io.role ?? 'session'
  const scoped: ServeIo = { ...io, role }
  const service = TENSORFOLD_SERVICES[role]
  const binary = io.binary ?? (await findTensorFoldEngine(io))?.binary
  if (binary === undefined) throw new TensorFoldStartError('TensorFold is not installed', null)
  const adapter = isAdapterEntry(binary)
  const point = checkpointFor(request.repo, adapter) ?? {
    repo: request.repo,
    shortName: request.name ?? tensorFoldShortName(request.repo),
    ...(request.drafter !== undefined ? { drafter: { repo: request.drafter, weightsBytes: 0, downloadBytes: 0 } } : {}),
    ...(request.promptCacheGib !== undefined ? { promptCacheGib: request.promptCacheGib } : {}),
  }
  const name = request.name ?? point.shortName
  const cwd = io.cwd ?? getCwd()
  const sessionId = io.sessionId ?? getSessionId()
  const sleep = io.sleep ?? defaultSleep
  const machine = io.machine ?? (await cachedTensorFoldMachineTruth(io))
  if (machine.platform === 'darwin' || io.app !== undefined) {
    const app = await (io.app ?? detectTensorFoldApp)().catch(() => undefined)
    const refused = app === undefined ? undefined : refuseSecondCopy(app)
    if (refused !== undefined) throw new TensorFoldStartError(refused, null)
  }
  const existing = servedTensorFoldRecord(scoped)
  const live = existing !== null && LIVE_STATES.includes(existing.service.state) ? existing : null
  const full = checkpointFor(request.repo, adapter)
  if (full !== undefined) {
    const needBytes = tensorFoldProjectedBytes({ ...full, ...(request.promptCacheGib !== undefined ? { promptCacheGib: request.promptCacheGib } : {}) }, request.window)
    const raw = io.freeMemoryBytes !== undefined ? await io.freeMemoryBytes() : await defaultFreeMemory(machine.platform, io.run ?? runForOutput)
    const freeBytes = Math.max(0, raw + heldBytesOf(live, adapter, LIVE_STATES) - loadingBytesOf(servedTensorFoldRecord({ ...scoped, role: otherRole(role) }), adapter))
    if (raw > 0 && freeBytes + TENSORFOLD_MEMORY_TIGHT_GIB * 1024 ** 3 < needBytes) {
      const ollama = await portFree(11434).then(free => !free)
      const offers = memoryOffers(role === 'session' && readRecord(cwd, 'local-gguf') !== null ? [{ name: 'local-gguf' }] : [], ollama)
      throw new TensorFoldStartError(`${gibWords(needBytes)} needed · ${gibWords(freeBytes)} free${live !== null ? ` once ${live.name} stops` : ''}`, null, { needBytes, freeBytes, offers })
    }
  }
  if (live !== null) await stopTensorFold(live.name, scoped)
  const pick = await pickTensorFoldPort(request.port ?? rememberedTensorFoldPort(scoped) ?? TENSORFOLD_DEFAULT_PORT, io)
  io.onPort?.(pick)
  const key = request.share === true && role === 'session' ? (io.keyFile ?? writeTensorFoldKeyFile)() : undefined
  const sharedAs = key === undefined ? undefined : (io.machineName ?? announcerMachineName)()
  if (key !== undefined && sharedAs !== undefined) {
    await (io.rememberHost ?? rememberTensorFoldHost)({ name: sharedAs, baseUrl: `http://${TENSORFOLD_HOST}:${pick.port}`, origin: 'shared', key: key.key, serving: name, window: request.window })
  }
  const spec = tensorFoldServiceSpec(binary, point, request.window, pick.port, cwd, name, io.serviceEnv ?? {}, key !== undefined ? { keyFile: key.path } : undefined, role)
  const started = await startService({ spec, sessionId })
  if ('error' in started) {
    await forgetShared(sharedAs, io)
    throw new TensorFoldStartError(started.error, null)
  }
  const record: TensorFoldServedRecord = {
    repo: request.repo,
    name,
    port: pick.port,
    window: request.window,
    pid: started.record.pid ?? 0,
    startedAt: new Date(started.record.startedAt ?? Date.now()).toISOString(),
    project: cwd,
    ...(key !== undefined ? { keyFile: key.path } : {}),
    ...(sharedAs !== undefined ? { sharedAs } : {}),
    ...(pick.busy !== undefined ? { busy: pick.busy } : {}),
    ...(point.drafter !== undefined ? { drafter: point.drafter.repo } : {}),
    ...(point.promptCacheGib !== undefined ? { promptCacheGib: point.promptCacheGib } : {}),
    ...(adapter ? { servedBy: ADAPTER_SERVED_BY } : {}),
  }
  writeServedRecord(record, scoped)
  const begun = Date.now()
  const deadline = begun + (io.startWaitMs ?? TENSORFOLD_START_WAIT_MS)
  for (;;) {
    if (io.signal?.aborted) {
      await stopTensorFold(name, scoped)
      throw new TensorFoldStartError('the start was stopped', null)
    }
    const ready = await waitForReady(cwd, service, 500)
    if (ready.ready) break
    const state = ready.record?.state
    if (ready.record === null || state === 'failed' || state === 'stopped') {
      const tail = logTail(ready.record)
      writeServedRecord(null, scoped)
      await forgetShared(sharedAs, io)
      const exit = { code: ready.record?.lastExitCode ?? null, signal: ready.record?.lastExitCode === -1 ? 'SIGKILL' : null }
      const refusal = readTensorFoldRefusal(tail, { window: request.window, machine, ...(full !== undefined ? { needBytes: tensorFoldProjectedBytes(full, request.window), ladder: tensorFoldLadder(full, machine) } : {}), exit })
      throw new TensorFoldStartError(refusal.line, refusal)
    }
    io.onLoading?.(Math.round((Date.now() - begun) / 1000))
    if (Date.now() >= deadline) {
      await stopTensorFold(name, scoped)
      throw new TensorFoldStartError('the model did not finish loading', null)
    }
    await sleep(0)
  }
  const rememberPort = io.rememberPort ?? rememberTensorFoldPort
  try {
    rememberPort(pick.port)
  } catch {
    void 0
  }
  if (role === 'session') endAnnouncement()
  if (key !== undefined) {
    try {
      const handle = await (io.announce ?? announceOnNetwork)({ model: name, enginePort: pick.port, window: request.window, key: key.key })
      announcement = { name, ...handle }
    } catch {
      announcement = null
    }
  }
  const { project: _project, busy: _busy, sharedAs: _sharedAs, ...served } = record
  return { ...served, pid: readRecord(cwd, service)?.pid ?? record.pid }
}

export async function stopTensorFold(name: string, io: Pick<ServeIo, 'role' | 'servedFile' | 'helperFile' | 'forgetPort' | 'forgetHost'> = {}): Promise<void> {
  const record = readServedRecord(io)
  if (record === null) return
  if (record.name !== name && record.repo !== name) return
  if (roleOf(io) === 'session') endAnnouncement()
  const stopped = await stopService(record.project, TENSORFOLD_SERVICES[roleOf(io)])
  if (servedByAdapter(record.servedBy) && !('error' in stopped) && stopped.note === undefined) rmSync(adapterChildPidFile(record.port), { force: true })
  writeServedRecord(null, io)
  const forgetPort = io.forgetPort ?? forgetTensorFoldPort
  try {
    forgetPort(record.port)
  } catch {
    void 0
  }
  await forgetShared(record.sharedAs, io)
  if ('error' in stopped) throw new Error(stopped.error)
  if (stopped.note !== undefined) throw new Error(stopped.note)
}

export async function pullTensorFold(repo: string, onProgress: (progress: TensorFoldPullProgress) => void, io: PullIo = {}): Promise<void> {
  return pullWithEngine(repo, onProgress, io)
}

export function tensorFoldExit(io: RoleIo = {}): { line: string; refusal: TensorFoldRefusal } | null {
  const served = servedTensorFoldRecord(io)
  if (served === null || !['failed', 'stopped'].includes(served.service.state) || served.service.explicitStop) return null
  const exit = { code: served.service.lastExitCode, signal: served.service.lastExitCode === -1 ? 'SIGKILL' : null }
  const refusal = readTensorFoldRefusal(logTail(served.service), { window: served.window, exit })
  return { line: refusal.line, refusal }
}
