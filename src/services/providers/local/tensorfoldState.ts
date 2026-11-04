import { getCwd } from '../../../utils/cwd.js'
import { readLogs, readRecord } from '../../projectServices/serviceManager.js'
import type { HelperModelState, TensorFoldEngine, TensorFoldHost, TensorFoldServed } from '../../tensorfold/contracts.js'
import { getCachedLocalDiscovery, refreshLocalDiscovery, type LocalDiscoverySnapshot, type LocalServerRecord } from './localDiscovery.js'
import { detectTensorFoldApp, type TensorFoldAppState } from './tensorfoldApp.js'
import { tensorFoldHostAddress, tensorFoldHostRecords, tensorFoldHostRoot } from './tensorfoldHosts.js'

const TENSORFOLD_SERVICE_NAME = 'tensorfold'
export const TENSORFOLD_WINDOW_FLOOR = 32768

export interface TensorFoldServerState {
  root: string
  address: string
  model?: string
  window?: number
  keyed: boolean
  version?: string
  backend?: string
  device?: string
  inUseBytes?: number
  streams?: number
  draining?: boolean
  host?: TensorFoldHost
  started?: TensorFoldServed
}

interface TensorFoldExit {
  name: string
  lastLine?: string
}

export interface TensorFoldState {
  engine: TensorFoldEngine | null | undefined
  servers: TensorFoldServerState[]
  exited?: TensorFoldExit
  app: TensorFoldAppState
  helper: HelperModelState
}

export interface TensorFoldStateReads {
  engine?: () => Promise<TensorFoldEngine | null | undefined>
  served?: () => readonly TensorFoldServed[]
  snapshot?: () => Promise<LocalDiscoverySnapshot | null>
  hosts?: () => readonly TensorFoldHost[]
  app?: () => Promise<TensorFoldAppState>
  helper?: () => HelperModelState
  exited?: () => Promise<TensorFoldExit | undefined>
}

async function readEngine(): Promise<TensorFoldEngine | null | undefined> {
  try {
    const { findTensorFoldEngine } = await import('../../tensorfold/engine.js')
    return await findTensorFoldEngine()
  } catch {
    return undefined
  }
}

function readServed(): readonly TensorFoldServed[] {
  try {
    const { servedTensorFold } = require('../../tensorfold/serve.js') as typeof import('../../tensorfold/serve.js')
    return servedTensorFold()
  } catch {
    return []
  }
}

function readHelper(): HelperModelState {
  try {
    const { readHelperModelState } = require('./tensorfoldHelper.js') as typeof import('./tensorfoldHelper.js')
    return readHelperModelState()
  } catch {
    return { enabled: false }
  }
}

async function readExited(): Promise<TensorFoldExit | undefined> {
  try {
    const record = readRecord(getCwd(), TENSORFOLD_SERVICE_NAME)
    if (record === null || record.explicitStop) return undefined
    if (record.state !== 'failed' && !(record.state === 'stopped' && record.lastExitCode !== null && record.lastExitCode !== 0)) return undefined
    const logs = await readLogs(getCwd(), TENSORFOLD_SERVICE_NAME, { tail: true, limitLines: 50 })
    const lastLine = 'lines' in logs ? [...logs.lines].reverse().find(line => line.trim() !== '') : undefined
    return { name: TENSORFOLD_SERVICE_NAME, ...(lastLine !== undefined ? { lastLine: lastLine.trim() } : {}) }
  } catch {
    return undefined
  }
}

function serverStateOf(record: LocalServerRecord, served: readonly TensorFoldServed[], hosts: readonly TensorFoldHost[]): TensorFoldServerState {
  const root = tensorFoldHostRoot(record.root)
  const model = record.models[0]
  const port = Number(new URL(root).port)
  const started = served.find(row => row.port === port && /^(http:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(root.replace(/^http:\/\//, 'http://')))
  const host = hosts.find(row => tensorFoldHostRoot(row.baseUrl) === root)
  return {
    root,
    address: tensorFoldHostAddress(root),
    ...(model !== undefined ? { model: model.id } : {}),
    ...(model?.contextWindow !== undefined ? { window: model.contextWindow.tokens } : {}),
    keyed: record.engine?.keyed ?? false,
    ...(record.version !== undefined ? { version: record.version } : host?.version !== undefined ? { version: host.version } : {}),
    ...(record.engine?.backend !== undefined ? { backend: record.engine.backend } : {}),
    ...(record.engine?.device !== undefined ? { device: record.engine.device } : {}),
    ...(record.engine?.inUseBytes !== undefined ? { inUseBytes: record.engine.inUseBytes } : {}),
    ...(record.engine?.streams !== undefined ? { streams: record.engine.streams } : {}),
    ...(record.engine?.draining ? { draining: true } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(started !== undefined ? { started } : {}),
  }
}

export async function readTensorFoldState(reads: TensorFoldStateReads = {}): Promise<TensorFoldState> {
  const [engine, snapshot, app, exited] = await Promise.all([
    (reads.engine ?? readEngine)(),
    (reads.snapshot ?? (async () => getCachedLocalDiscovery() ?? (await refreshLocalDiscovery().catch(() => null))))(),
    (reads.app ?? (() => detectTensorFoldApp()))(),
    (reads.exited ?? readExited)(),
  ])
  const served = (reads.served ?? readServed)()
  const hosts = (reads.hosts ?? (() => tensorFoldHostRecords()))()
  const servers = (snapshot?.servers ?? []).filter(server => server.kind === 'tensorfold').map(server => serverStateOf(server, served, hosts))
  return { engine, servers, ...(exited !== undefined ? { exited } : {}), app, helper: (reads.helper ?? readHelper)() }
}

export function tensorFoldPresent(state: TensorFoldState): boolean {
  return state.engine !== null && state.engine !== undefined || state.servers.length > 0 || state.exited !== undefined || state.app.engine !== undefined
}
