import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { TensorFoldHost, TensorFoldModelRow } from '../../services/tensorfold/contracts.js'
import { findTensorFoldEngine, tensorFoldMachine } from '../../services/tensorfold/engine.js'
import { bestTensorFoldFit, readTensorFoldInventory } from '../../services/tensorfold/inventory.js'
import { servedTensorFold } from '../../services/tensorfold/serve.js'
import { detectTensorFoldApp } from '../../services/providers/local/tensorfoldApp.js'
import { helperHeadingWords } from '../../services/providers/local/tensorfoldHelper.js'
import { tensorFoldHosts } from '../../services/providers/local/tensorfoldHosts.js'
import { getCachedLocalDiscovery } from '../../services/providers/local/localDiscovery.js'
import { currentHostRecipes } from '../../services/host/recipesFile.js'
import { tensorFoldRentFacts, tensorFoldRentRow } from '../../services/host/tensorfoldPod.js'
import { listBoxes } from '../../services/host/boxes.js'
import { localServerProbingOff } from '../../services/localServer/localServerTruth.js'
import type { TensorFoldPickerFacts } from './tensorfoldRows.js'
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

export const TENSORFOLD_DRIVER_FLOOR = 580

export function tensorFoldCapableMachine(platform: NodeJS.Platform = process.platform, arch: string = process.arch, nvidia: () => string | undefined = () => quietly(() => readFileSync('/proc/driver/nvidia/version', 'utf8'), undefined)): boolean {
  if (platform === 'darwin') return arch === 'arm64'
  if (platform !== 'linux') return false
  const major = Number(/Module\s+(\d+)\./.exec(nvidia() ?? '')?.[1])
  return Number.isInteger(major) && major >= TENSORFOLD_DRIVER_FLOOR
}

export function isLoopbackUrl(baseUrl: string): boolean {
  return LOOPBACK.test(urlOf(baseUrl)?.hostname ?? '')
}

function portOf(baseUrl: string): number | undefined {
  const port = Number(urlOf(baseUrl)?.port)
  return Number.isInteger(port) && port > 0 ? port : undefined
}

function tensorFoldServers(): NonNullable<ReturnType<typeof getCachedLocalDiscovery>>['servers'] {
  return (getCachedLocalDiscovery()?.servers ?? []).filter(server => server.kind === 'tensorfold')
}

const sameUrl = (a: string, b: string): boolean => a.replace(/\/v1\/?$/, '').replace(/\/+$/, '') === b.replace(/\/v1\/?$/, '').replace(/\/+$/, '')

export function discoveredTensorFoldRows(hosts: readonly TensorFoldHost[] = []): TensorFoldModelRow[] {
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

export function discoveredTensorFoldHosts(): TensorFoldHost[] {
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

function withDiscoveredHosts(hosts: readonly TensorFoldHost[]): TensorFoldHost[] {
  const out = [...hosts]
  for (const host of [...discoveredTensorFoldHosts(), ...boxTensorFoldHosts()]) {
    if (!out.some(known => sameUrl(known.baseUrl, host.baseUrl) || known.name === host.name)) out.push(host)
  }
  return out
}

export function huggingFaceCacheFacts(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): { into: string; freeBytes?: number } {
  const hub = env.HF_HUB_CACHE?.trim() || join(env.HF_HOME?.trim() || join(home, '.cache', 'huggingface'), 'hub')
  let probe = hub
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  const free = quietly(() => {
    const stats = statfsSync(probe)
    return stats.bavail * stats.bsize
  }, undefined)
  return { into: hub.startsWith(`${home}/`) ? `~${hub.slice(home.length)}` : hub, ...(free !== undefined ? { freeBytes: free } : {}) }
}

function rentFacts(): { pod: string; serves: string; title: string } | undefined {
  const row = tensorFoldRentRow([], currentHostRecipes())
  return row === undefined ? undefined : tensorFoldRentFacts(row)
}

export async function readTensorFoldPickerFacts(): Promise<TensorFoldPickerFacts> {
  const platform = process.platform
  const hosts = quietly(() => tensorFoldHosts(), [])
  const helper = quietly(() => helperHeadingWords(), undefined)
  const app = platform === 'darwin' ? await quietlyAsync(() => detectTensorFoldApp(), undefined) : undefined
  const rent = quietly(() => rentFacts(), undefined)
  const shared = {
    hosts: withDiscoveredHosts(hosts),
    ...(helper !== undefined ? { helper } : {}),
    ...(app?.engine !== undefined ? { app: { serving: app.engine.model ?? 'a model' } } : {}),
    ...(rent !== undefined ? { rent } : {}),
  }
  if (platform === 'win32') return { platform, engine: null, rows: [], ...shared }
  const engine = await quietlyAsync(() => findTensorFoldEngine(), null)
  const inventory = await quietlyAsync(() => readTensorFoldInventory(engine), [])
  const machine = quietly(() => tensorFoldMachine(), undefined)
  const best = quietly(() => bestTensorFoldFit(inventory), null)
  const served = quietly(() => servedTensorFold(), [])
  return {
    platform,
    engine,
    rows: inventory,
    served,
    disk: huggingFaceCacheFacts(),
    ...(machine !== undefined ? { machine } : {}),
    ...(best !== null ? { best: best.repo } : {}),
    ...shared,
  }
}

export async function readTensorFoldOffer(platform: NodeJS.Platform = process.platform, capable: () => boolean = () => tensorFoldCapableMachine()): Promise<TensorFoldOffer | null> {
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

export function refreshTensorFoldOffer(): Promise<TensorFoldOffer | null> {
  offerReading ??= readTensorFoldOffer()
    .then(next => {
      offer = next
      stamp++
      for (const listener of listeners) listener()
      return next
    })
    .finally(() => {
      offerReading = undefined
    })
  return offerReading
}

let snapshot: TensorFoldPickerFacts | undefined
let stamp = 0
let reading: Promise<TensorFoldPickerFacts> | undefined
const listeners = new Set<() => void>()

export function refreshTensorFoldPickerFacts(): Promise<TensorFoldPickerFacts> {
  reading ??= readTensorFoldPickerFacts()
    .then(facts => {
      snapshot = facts
      stamp++
      for (const listener of listeners) listener()
      return facts
    })
    .finally(() => {
      reading = undefined
    })
  return reading
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const stampOf = (): number => stamp

export function tensorFoldPickerFactsNow(): TensorFoldPickerFacts {
  const facts = snapshot ?? { platform: process.platform, rows: [], hosts: withDiscoveredHosts(quietly(() => tensorFoldHosts(), [])) }
  return facts.platform === 'win32' ? facts : { ...facts, rows: withDiscoveredRows(facts.rows, facts.hosts ?? []) }
}

export function useTensorFoldOffer(): TensorFoldOffer | null | undefined {
  useSyncExternalStore(subscribe, stampOf, stampOf)
  useEffect(() => {
    void refreshTensorFoldOffer().catch(() => undefined)
  }, [])
  return offer
}

export function useTensorFoldPickerFacts(): TensorFoldPickerFacts | undefined {
  const read = useSyncExternalStore(subscribe, stampOf, stampOf)
  const off = localServerProbingOff()
  useEffect(() => {
    if (!off) void refreshTensorFoldPickerFacts().catch(() => undefined)
  }, [off])
  const discovery = getCachedLocalDiscovery()
  return useMemo(() => {
    void read
    void discovery
    return off ? undefined : tensorFoldPickerFactsNow()
  }, [read, discovery, off])
}
