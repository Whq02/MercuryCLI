import { readFileSync } from 'node:fs'
import { useEffect, useSyncExternalStore } from 'react'
import type { TensorFoldHost, TensorFoldModelRow } from '../../services/tensorfold/contracts.js'
import { findTensorFoldEngine } from '../../services/tensorfold/engine.js'
import { bestTensorFoldFit, readTensorFoldInventory } from '../../services/tensorfold/inventory.js'
import { announcerMachineName, browseAnnouncements } from '../../services/lan/announcer.js'
import { pairWithHost } from '../../services/lan/pairing.js'
import { rememberTensorFoldHost, tensorFoldHosts } from '../../services/providers/local/tensorfoldHosts.js'
import { getCachedLocalDiscovery, refreshLocalDiscovery } from '../../services/providers/local/localDiscovery.js'
import { listBoxes } from '../../services/host/boxes.js'
import { localServerProbingOff } from '../../services/localServer/localServerTruth.js'
import type { TensorFoldAnnouncedHost } from './tensorfoldRows.js'
import type { TensorFoldOffer } from '../loginFamilyRows.js'

const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|::1|\[::1\])$/i

function quietly<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

async function quietlyAsync<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch {
    return fallback
  }
}

function urlOf(baseUrl: string): URL | undefined {
  try {
    return new URL(baseUrl)
  } catch {
    return undefined
  }
}

const TENSORFOLD_DRIVER_FLOOR = 580

export function tensorFoldCapableMachine(platform: NodeJS.Platform = process.platform, arch: string = process.arch, nvidia: () => string | undefined = () => quietly(() => readFileSync('/proc/driver/nvidia/version', 'utf8'), undefined)): boolean {
  if (platform === 'darwin') return arch === 'arm64'
  if (platform !== 'linux') return false
  const major = Number(/Module\s+(\d+)\./.exec(nvidia() ?? '')?.[1])
  return Number.isInteger(major) && major >= TENSORFOLD_DRIVER_FLOOR
}

function isLoopbackUrl(baseUrl: string): boolean {
  return LOOPBACK.test(urlOf(baseUrl)?.hostname ?? '')
}

function portOf(baseUrl: string): number | undefined {
  const port = Number(urlOf(baseUrl)?.port)
  return Number.isInteger(port) && port > 0 ? port : undefined
}

function tensorFoldServers(): NonNullable<ReturnType<typeof getCachedLocalDiscovery>>['servers'] {
  return (getCachedLocalDiscovery()?.servers ?? []).filter(server => server.kind === 'tensorfold')
}

export const sameUrl = (a: string, b: string): boolean => a.replace(/\/v1\/?$/, '').replace(/\/+$/, '') === b.replace(/\/v1\/?$/, '').replace(/\/+$/, '')

function discoveredTensorFoldRows(hosts: readonly TensorFoldHost[] = []): TensorFoldModelRow[] {
  return tensorFoldServers()
    .filter(server => isLoopbackUrl(server.baseUrl) && !hosts.some(host => sameUrl(host.baseUrl, server.baseUrl)))
    .flatMap(server =>
      server.models.map((record): TensorFoldModelRow => {
        const port = portOf(server.baseUrl)
        return {
          repo: record.id,
          shortName: record.id,
          family: record.family ?? '',
          state: 'serving',
          fit: { verdict: 'fits', neededGib: 0, availableGib: 0, estimate: true },
          window: record.contextWindow?.tokens ?? 0,
          qualified: true,
          ...(port !== undefined ? { port } : {}),
          ...(record.servedBytes !== undefined ? { inUseBytes: record.servedBytes } : {}),
        }
      }),
    )
}

function discoveredTensorFoldHosts(): TensorFoldHost[] {
  return tensorFoldServers()
    .filter(server => !isLoopbackUrl(server.baseUrl))
    .map(server => {
      const model = server.models[0]
      return {
        name: urlOf(server.baseUrl)?.hostname ?? server.baseUrl,
        baseUrl: server.baseUrl,
        origin: 'typed' as const,
        ...(model !== undefined ? { serving: model.id } : {}),
        ...(server.version !== undefined ? { version: server.version } : {}),
        ...(model?.contextWindow !== undefined ? { window: model.contextWindow.tokens } : {}),
      }
    })
}

function boxTensorFoldHosts(): TensorFoldHost[] {
  return quietly(() => listBoxes(), []).flatMap(box => {
    const engine = box.engines.find(candidate => candidate.kind === 'tensorfold')
    if (box.kind !== 'ssh' || engine === undefined || box.target === undefined) return []
    const gpu = box.gpus[0]?.name
    return [{ name: box.name, baseUrl: `http://${box.target.host}:${engine.port}`, origin: 'typed' as const, version: engine.version, ...(gpu !== undefined ? { chip: gpu } : {}) }]
  })
}

function withDiscoveredRows(rows: readonly TensorFoldModelRow[], hosts: readonly TensorFoldHost[] = []): TensorFoldModelRow[] {
  const known = new Set(rows.map(row => row.shortName))
  return [...rows, ...discoveredTensorFoldRows(hosts).filter(row => !known.has(row.shortName))]
}

export function withDiscoveredHosts(hosts: readonly TensorFoldHost[]): TensorFoldHost[] {
  const out = [...hosts]
  for (const host of [...discoveredTensorFoldHosts(), ...boxTensorFoldHosts()]) {
    if (!out.some(known => sameUrl(known.baseUrl, host.baseUrl) || known.name === host.name)) out.push(host)
  }
  return out
}

export function tensorFoldHostsNow(): TensorFoldHost[] {
  return withDiscoveredHosts(quietly(() => tensorFoldHosts(), []))
}

async function readTensorFoldOffer(platform: NodeJS.Platform = process.platform, capable: () => boolean = () => tensorFoldCapableMachine()): Promise<TensorFoldOffer | null> {
  if (localServerProbingOff()) return null
  if (platform === 'win32') return { kind: 'host' }
  if (!capable()) return null
  const engine = await quietlyAsync(() => findTensorFoldEngine(), null)
  const rows = withDiscoveredRows(await quietlyAsync(() => readTensorFoldInventory(engine), []), quietly(() => tensorFoldHosts(), []))
  const served = rows.find(row => row.state === 'serving')
  if (served !== undefined && engine !== null) return { kind: 'served', model: served.shortName, version: engine.version }
  const best = quietly(() => bestTensorFoldFit(rows), null)
  if (best === null) return null
  return { kind: engine === null ? 'install' : 'ready', label: best.label ?? best.shortName, place: platform === 'darwin' ? 'mac' : 'gpu' }
}

let offer: TensorFoldOffer | null | undefined
let offerReading: Promise<TensorFoldOffer | null> | undefined
let stamp = 0
const listeners = new Set<() => void>()

function emit(): void {
  stamp++
  for (const listener of [...listeners]) listener()
}

function refreshTensorFoldOffer(): Promise<TensorFoldOffer | null> {
  offerReading ??= readTensorFoldOffer()
    .then(next => {
      offer = next
      emit()
      return next
    })
    .finally(() => {
      offerReading = undefined
    })
  return offerReading
}

export function subscribeTensorFoldFacts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const tensorFoldFactsStamp = (): number => stamp

export function useTensorFoldOffer(): TensorFoldOffer | null | undefined {
  useSyncExternalStore(subscribeTensorFoldFacts, tensorFoldFactsStamp, tensorFoldFactsStamp)
  useEffect(() => {
    void refreshTensorFoldOffer().catch(() => undefined)
  }, [])
  return offer
}

let announced: readonly TensorFoldAnnouncedHost[] = []
let browsing: Promise<void> | undefined

function txtNumber(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return value !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function announcedOf(found: { name: string; host: string; port: number; txt: Record<string, string> }): TensorFoldAnnouncedHost | undefined {
  const pairPort = txtNumber(found.txt.pair) ?? (Number.isInteger(found.port) && found.port > 0 ? found.port : undefined)
  if (pairPort === undefined || found.host === '') return undefined
  const enginePort = txtNumber(found.txt.engine)
  const window = txtNumber(found.txt.window)
  return {
    name: found.name,
    host: found.host,
    pairPort,
    ...(enginePort !== undefined ? { enginePort } : {}),
    ...(found.txt.model ? { serving: found.txt.model } : {}),
    ...(window !== undefined ? { window } : {}),
    ...(found.txt.version ? { version: found.txt.version } : {}),
    ...(found.txt.chip ? { chip: found.txt.chip.replace(/_/g, ' ') } : {}),
    keyed: found.txt.keyed === '1',
  }
}

function remembered(host: TensorFoldAnnouncedHost, hosts: readonly TensorFoldHost[]): boolean {
  return hosts.some(known => known.name === host.name || (host.enginePort !== undefined && sameUrl(known.baseUrl, `http://${host.host}:${host.enginePort}`)))
}

export function tensorFoldAnnouncementsNow(hosts: readonly TensorFoldHost[] = quietly(() => tensorFoldHosts(), [])): TensorFoldAnnouncedHost[] {
  return announced.filter(host => !remembered(host, hosts))
}

export function refreshTensorFoldAnnouncements(): Promise<void> {
  if (localServerProbingOff() || process.platform === 'win32') return Promise.resolve()
  browsing ??= browseAnnouncements()
    .then(found => {
      const mine = announcerMachineName()
      const before = new Map(announced.map(host => [host.name, host]))
      announced = found
        .filter(row => row.name !== mine)
        .map(announcedOf)
        .filter((host): host is TensorFoldAnnouncedHost => host !== undefined)
        .map(host => {
          return before.get(host.name)?.pairing === true ? { ...host, pairing: true } : host
        })
      emit()
    })
    .catch(() => undefined)
    .finally(() => {
      browsing = undefined
    })
  return browsing
}

function markAnnounced(name: string, mark: Pick<TensorFoldAnnouncedHost, 'pairing' | 'refused'>): void {
  announced = announced.map(host => {
    if (host.name !== name) return host
    const { pairing: _pairing, refused: _refused, ...rest } = host
    return { ...rest, ...(mark.pairing === true ? { pairing: true } : {}), ...(mark.refused !== undefined ? { refused: mark.refused } : {}) }
  })
  emit()
}

export async function pairTensorFoldHost(host: TensorFoldAnnouncedHost, code: string): Promise<string | undefined> {
  markAnnounced(host.name, { pairing: true })
  const outcome = await pairWithHost({ host: host.host, pairPort: host.pairPort, code })
  if (!outcome.ok) {
    markAnnounced(host.name, { refused: outcome.reason })
    return undefined
  }
  const reply = outcome.reply
  try {
    await rememberTensorFoldHost({
      name: reply.name,
      baseUrl: reply.baseUrl,
      origin: 'lan-paired',
      serving: reply.model,
      ...(reply.key !== undefined ? { key: reply.key } : {}),
      ...(reply.version !== undefined ? { version: reply.version } : {}),
      ...(reply.chip !== undefined ? { chip: reply.chip } : {}),
      ...(reply.window !== undefined ? { window: reply.window } : {}),
    })
  } catch (error) {
    markAnnounced(host.name, { refused: error instanceof Error ? error.message : String(error) })
    return undefined
  }
  announced = announced.filter(row => row.name !== host.name)
  emit()
  void refreshLocalDiscovery({ force: true }).catch(() => undefined)
  return `paired with ${reply.name} · ↵ on its row switches to ${reply.model}`
}
