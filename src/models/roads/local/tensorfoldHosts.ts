import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishAtomicSync } from '../../../platform/substrate/fileStore.js'
import { getMercuryHome } from '../../../platform/environment/envUtils.js'
import { refuseProofWriteIntoAccountStore } from '../proofHomeGuard.js'
import type { HelperModelState, TensorFoldHost, TensorFoldHostOrigin } from '../../tensorfold/contracts.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { isOneOf } from '../../../platform/primitives/isOneOf.js'

const FILE_NAME = 'tensorfold-hosts.json'
const ORIGINS: readonly TensorFoldHostOrigin[] = ['lan-paired', 'typed', 'pod', 'app', 'shared']

export interface TensorFoldHostRecord extends TensorFoldHost {
  key?: string
  chip?: string
  pairedAt?: string
}

interface HostsFile {
  version: 1
  hosts: TensorFoldHostRecord[]
  ports: number[]
  windows?: Record<string, number>
}

function storePath(): string {
  return join(getMercuryHome(), 'local-setup', FILE_NAME)
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

export function tensorFoldHostRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

export function tensorFoldHostAddress(baseUrl: string): string {
  try {
    const url = new URL(tensorFoldHostRoot(baseUrl))
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return tensorFoldHostRoot(baseUrl)
  }
}

function hostRecordOf(raw: unknown): TensorFoldHostRecord | undefined {
  const row = rec(raw)
  const name = str(row?.name)
  const baseUrl = str(row?.baseUrl)
  const origin = str(row?.origin)
  if (!row || !name || !baseUrl || !origin || !isOneOf(ORIGINS, origin)) return undefined
  return {
    name,
    baseUrl: tensorFoldHostRoot(baseUrl),
    origin,
    ...(str(row.key) !== undefined ? { key: str(row.key)!, keyRef: str(row.keyRef) ?? 'stored' } : str(row.keyRef) !== undefined ? { keyRef: str(row.keyRef)! } : {}),
    ...(str(row.serving) !== undefined ? { serving: str(row.serving)! } : {}),
    ...(str(row.version) !== undefined ? { version: str(row.version)! } : {}),
    ...(str(row.chip) !== undefined ? { chip: str(row.chip)! } : {}),
    ...(typeof row.window === 'number' && Number.isFinite(row.window) && row.window > 0 ? { window: row.window } : {}),
    ...(str(row.servedBy) !== undefined ? { servedBy: str(row.servedBy)! } : {}),
    ...(str(row.pairedAt) !== undefined ? { pairedAt: str(row.pairedAt)! } : {}),
  }
}

function readStoreStrict(): HostsFile {
  let raw: string
  try {
    raw = readFileSync(storePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { version: 1, hosts: [], ports: [] }
    throw error
  }
  const parsed = rec(JSON.parse(raw))
  if (parsed === undefined) throw new SyntaxError(`TensorFold hosts store at ${storePath()} is not a JSON object`)
  const hosts = Array.isArray(parsed.hosts) ? parsed.hosts.map(hostRecordOf).filter((row): row is TensorFoldHostRecord => row !== undefined) : []
  const ports = Array.isArray(parsed.ports) ? parsed.ports.filter((port): port is number => Number.isInteger(port) && port > 0 && port < 65536) : []
  const windows = Object.fromEntries(Object.entries(rec(parsed.windows) ?? {}).filter((entry): entry is [string, number] => Number.isInteger(entry[1]) && (entry[1] as number) > 0))
  return { version: 1, hosts, ports, ...(Object.keys(windows).length > 0 ? { windows } : {}) }
}

function hostsStoreReadErrorMessage(path: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (detail.startsWith(`TensorFold hosts store at ${path}`)) return detail
  return `TensorFold hosts store at ${path} could not be read (${detail})`
}

function readStore(): HostsFile {
  try {
    return readStoreStrict()
  } catch (error) {
    passedOver(error)
    logForDebugging(`[tensorfold-hosts] could not read ${storePath()}: ${error instanceof Error ? error.message : String(error)}`, { level: 'error' })
    return { version: 1, hosts: [], ports: [] }
  }
}

export function tensorFoldHostsReadError(): string | undefined {
  try {
    readStoreStrict()
    return undefined
  } catch (error) {
    passedOver(error)
    return hostsStoreReadErrorMessage(storePath(), error)
  }
}

function writeStore(next: HostsFile): void {
  const home = getMercuryHome()
  refuseProofWriteIntoAccountStore(home, 'the TensorFold hosts store')
  publishAtomicSync(storePath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
}

function stripKey(host: TensorFoldHostRecord): TensorFoldHost {
  const { key: _key, pairedAt: _pairedAt, ...rest } = host
  return rest
}

export async function rememberTensorFoldHost(host: TensorFoldHost & { key?: string; chip?: string }): Promise<void> {
  const store = readStoreStrict()
  const baseUrl = tensorFoldHostRoot(host.baseUrl)
  const before = store.hosts.find(row => row.name === host.name || row.baseUrl === baseUrl)
  const next: TensorFoldHostRecord = {
    name: host.name,
    baseUrl,
    origin: host.origin,
    ...(host.key !== undefined && host.key !== '' ? { key: host.key, keyRef: host.keyRef ?? 'stored' } : before?.key !== undefined ? { key: before.key, keyRef: host.keyRef ?? before.keyRef ?? 'stored' } : host.keyRef !== undefined ? { keyRef: host.keyRef } : {}),
    ...(host.serving !== undefined ? { serving: host.serving } : before?.serving !== undefined ? { serving: before.serving } : {}),
    ...(host.version !== undefined ? { version: host.version } : before?.version !== undefined ? { version: before.version } : {}),
    ...(host.chip !== undefined ? { chip: host.chip } : before?.chip !== undefined ? { chip: before.chip } : {}),
    ...(host.window !== undefined ? { window: host.window } : before?.window !== undefined ? { window: before.window } : {}),
    ...(host.servedBy !== undefined ? { servedBy: host.servedBy } : before?.servedBy !== undefined ? { servedBy: before.servedBy } : {}),
    pairedAt: before?.pairedAt ?? new Date().toISOString(),
  }
  writeStore({ ...store, hosts: [...store.hosts.filter(row => row !== before), next] })
}

export async function forgetTensorFoldHost(name: string): Promise<void> {
  const store = readStoreStrict()
  writeStore({ ...store, hosts: store.hosts.filter(row => row.name !== name && row.baseUrl !== tensorFoldHostRoot(name)) })
}

export function tensorFoldHosts(): readonly TensorFoldHost[] {
  return readStore().hosts.map(stripKey)
}

export function tensorFoldHostRecords(): readonly TensorFoldHostRecord[] {
  return readStore().hosts
}

export function tensorFoldHostFor(baseUrl: string): TensorFoldHostRecord | undefined {
  const root = tensorFoldHostRoot(baseUrl)
  return readStore().hosts.find(row => row.baseUrl === root)
}

export function tensorFoldHostKey(baseUrl: string): string | undefined {
  return tensorFoldHostFor(baseUrl)?.key
}

export function pairableTensorFoldHosts(): readonly TensorFoldHost[] {
  return tensorFoldHosts().filter(host => host.origin !== 'app' && host.origin !== 'shared')
}

export function tensorFoldPorts(): readonly number[] {
  return readStore().ports
}

export function rememberTensorFoldPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error(`a TensorFold port is 1 to 65535, not ${port}`)
  const store = readStoreStrict()
  if (store.ports.includes(port)) return
  writeStore({ ...store, ports: [...store.ports, port] })
}

export function rememberTensorFoldWindow(repo: string, window: number): void {
  if (repo.trim() === '' || !Number.isInteger(window) || window <= 0) return
  const store = readStoreStrict()
  const key = repo.toLowerCase()
  if (store.windows?.[key] === window) return
  writeStore({ ...store, windows: { ...store.windows, [key]: window } })
}

export function rememberedTensorFoldWindow(repo: string): number | undefined {
  return readStore().windows?.[repo.toLowerCase()]
}

export function rememberedTensorFoldRepos(): readonly string[] {
  return Object.keys(readStore().windows ?? {})
}

export function forgetTensorFoldPort(port: number): void {
  const store = readStoreStrict()
  if (!store.ports.includes(port)) return
  writeStore({ ...store, ports: store.ports.filter(row => row !== port) })
}

export function helperModelState(): HelperModelState {
  const { readHelperModelState } = require('./tensorfoldHelper.js') as typeof import('./tensorfoldHelper.js')
  return readHelperModelState()
}

export function helperPort(): number | undefined {
  const { readHelperPort } = require('./tensorfoldHelper.js') as typeof import('./tensorfoldHelper.js')
  return readHelperPort()
}
