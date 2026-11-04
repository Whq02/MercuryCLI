import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishAtomicSync } from '../../../substrate/fileStore.js'
import { getAuthConfigHomeDir } from '../../../utils/envUtils.js'
import { refuseProofWriteIntoAccountStore } from '../../../utils/proofHomeGuard.js'
import type { HelperModelState, TensorFoldHost, TensorFoldHostOrigin } from '../../tensorfold/contracts.js'

const FILE_NAME = '.tensorfold-hosts.json'
const ORIGINS: readonly TensorFoldHostOrigin[] = ['lan-paired', 'typed', 'pod', 'app']

export interface TensorFoldHostRecord extends TensorFoldHost {
  key?: string
  chip?: string
  pairedAt?: string
}

interface HostsFile {
  version: 1
  hosts: TensorFoldHostRecord[]
  ports: number[]
}

function storePath(): string {
  return join(getAuthConfigHomeDir(), FILE_NAME)
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
  if (!row || !name || !baseUrl || !origin || !(ORIGINS as readonly string[]).includes(origin)) return undefined
  return {
    name,
    baseUrl: tensorFoldHostRoot(baseUrl),
    origin: origin as TensorFoldHostOrigin,
    ...(str(row.key) !== undefined ? { key: str(row.key)!, keyRef: str(row.keyRef) ?? 'stored' } : str(row.keyRef) !== undefined ? { keyRef: str(row.keyRef)! } : {}),
    ...(str(row.serving) !== undefined ? { serving: str(row.serving)! } : {}),
    ...(str(row.version) !== undefined ? { version: str(row.version)! } : {}),
    ...(str(row.chip) !== undefined ? { chip: str(row.chip)! } : {}),
    ...(typeof row.window === 'number' && Number.isFinite(row.window) && row.window > 0 ? { window: row.window } : {}),
    ...(str(row.pairedAt) !== undefined ? { pairedAt: str(row.pairedAt)! } : {}),
  }
}

function readStore(): HostsFile {
  try {
    const parsed = rec(JSON.parse(readFileSync(storePath(), 'utf8')))
    const hosts = Array.isArray(parsed?.hosts) ? parsed!.hosts.map(hostRecordOf).filter((row): row is TensorFoldHostRecord => row !== undefined) : []
    const ports = Array.isArray(parsed?.ports) ? parsed!.ports.filter((port): port is number => Number.isInteger(port) && port > 0 && port < 65536) : []
    return { version: 1, hosts, ports }
  } catch {
    return { version: 1, hosts: [], ports: [] }
  }
}

function writeStore(next: HostsFile): void {
  const dir = getAuthConfigHomeDir()
  refuseProofWriteIntoAccountStore(dir, 'the TensorFold hosts store')
  publishAtomicSync(storePath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
}

function stripKey(host: TensorFoldHostRecord): TensorFoldHost {
  const { key: _key, chip: _chip, pairedAt: _pairedAt, ...rest } = host
  return rest
}

export async function rememberTensorFoldHost(host: TensorFoldHost & { key?: string; chip?: string }): Promise<void> {
  const store = readStore()
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
    pairedAt: before?.pairedAt ?? new Date().toISOString(),
  }
  writeStore({ ...store, hosts: [...store.hosts.filter(row => row !== before), next] })
}

export async function forgetTensorFoldHost(name: string): Promise<void> {
  const store = readStore()
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
  return tensorFoldHosts().filter(host => host.origin !== 'app')
}

export function tensorFoldPorts(): readonly number[] {
  return readStore().ports
}

export function rememberTensorFoldPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error(`a TensorFold port is 1 to 65535, not ${port}`)
  const store = readStore()
  if (store.ports.includes(port)) return
  writeStore({ ...store, ports: [...store.ports, port] })
}

export function forgetTensorFoldPort(port: number): void {
  const store = readStore()
  if (!store.ports.includes(port)) return
  writeStore({ ...store, ports: store.ports.filter(row => row !== port) })
}

export function helperModelState(): HelperModelState {
  const { readHelperModelState } = require('./tensorfoldHelper.js') as typeof import('./tensorfoldHelper.js')
  return readHelperModelState()
}
