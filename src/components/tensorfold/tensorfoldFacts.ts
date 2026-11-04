import { existsSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { TensorFoldHost, TensorFoldModelRow } from '../../services/tensorfold/contracts.js'
import { findTensorFoldEngine, tensorFoldMachine } from '../../services/tensorfold/engine.js'
import { bestTensorFoldFit, readTensorFoldInventory } from '../../services/tensorfold/inventory.js'
import { servedTensorFold } from '../../services/tensorfold/serve.js'
import { helperModelState, tensorFoldHosts } from '../../services/providers/local/tensorfoldHosts.js'
import { getCachedLocalDiscovery } from '../../services/providers/local/localDiscovery.js'
import { listBoxes } from '../../services/host/boxes.js'
import { localServerProbingOff } from '../../services/localServer/localServerTruth.js'
import type { TensorFoldPickerFacts } from './tensorfoldRows.js'

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

export function tensorFoldCapableMachine(platform: NodeJS.Platform = process.platform, arch: string = process.arch, nvidia: () => boolean = () => existsSync('/proc/driver/nvidia/version')): boolean {
  if (platform === 'darwin') return arch === 'arm64'
  return platform === 'linux' && nvidia()
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

export function discoveredTensorFoldRows(): TensorFoldModelRow[] {
  return tensorFoldServers()
    .filter(server => isLoopbackUrl(server.baseUrl))
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

function withDiscoveredRows(rows: readonly TensorFoldModelRow[]): TensorFoldModelRow[] {
  const known = new Set(rows.map(row => row.shortName))
  return [...rows, ...discoveredTensorFoldRows().filter(row => !known.has(row.shortName))]
}

function withDiscoveredHosts(hosts: readonly TensorFoldHost[]): TensorFoldHost[] {
  const out = [...hosts]
  for (const host of [...discoveredTensorFoldHosts(), ...boxTensorFoldHosts()]) {
    if (!out.some(known => known.baseUrl.replace(/\/+$/, '') === host.baseUrl.replace(/\/+$/, '') || known.name === host.name)) out.push(host)
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

export async function readTensorFoldPickerFacts(): Promise<TensorFoldPickerFacts> {
  const platform = process.platform
  const hosts = quietly(() => tensorFoldHosts(), [])
  const helper = quietly(() => helperModelState(), undefined)
  const app = hosts.find(host => host.origin === 'app' && host.serving !== undefined)
  const shared = {
    hosts: withDiscoveredHosts(hosts),
    ...(helper !== undefined ? { helper } : {}),
    ...(app?.serving !== undefined ? { app: { serving: app.serving } } : {}),
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
  return facts.platform === 'win32' ? facts : { ...facts, rows: withDiscoveredRows(facts.rows) }
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
