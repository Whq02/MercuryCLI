import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { publishAtomicSync } from '../../platform/substrate/fileStore.js'
import { resolveWatchRoot } from '../../platform/processes/watchRoot.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { startInterval, stopInterval } from '../../platform/async/timers.js'
import type { SshTarget } from './ssh.js'
import type { HostRecipe } from './recipes.js'
import type { HostCluster, HostClusterPod } from './runpod.js'
import type { HostRetune, HostTunePreferences } from './tune.js'
import { releaseHostHuggingfaceCredential, type HostHuggingfaceCredential } from './jobCredentials.js'
import type { WeightsSource } from './weightsSource.js'
import type { HostEngineDeathFacts } from '../../commands/llmhost/words.js'

export interface HostRecord {
  vendor?: 'runpod' | 'vast' | 'lambda' | 'huggingface' | 'hyperstack' | 'verda' | 'digitalocean'
  id: string; name: string; recipe: string; price: number; startedAt: string; status: string
  machineId?: string
  externalJob?: string
  target?: SshTarget; localPort?: number; provider?: string
  sessionId?: string; workspace?: string; sshKey?: string; apiBaseUrl?: string; spendUSD?: number; stopRequestedAt?: number
  jobKind?: 'setup' | 'watch' | 'bank'; maxPrice?: number; pollIntervalMs?: number; pollWindowMs?: number; rateLimit?: string; watchedFrom?: string; creating?: string
  watchVendors?: ('runpod' | 'vast' | 'lambda' | 'huggingface' | 'hyperstack' | 'verda' | 'digitalocean')[]
  bankTask?: 'bank' | 'verify'; bankFolder?: string
  huggingfaceCredential?: HostHuggingfaceCredential
  jobState?: 'queued' | 'starting' | 'running' | 'ready' | 'paused' | 'failed' | 'stopped'
  generation?: string; jobStartedAt?: number; advancedAt?: number; step?: string; log?: string; error?: string
  steps?: { step: string; at: number }[]
  recipeRow?: HostRecipe
  volumeId?: string; prepareWeightsOnly?: boolean; verifyWeightsFully?: boolean; weightsCheck?: string
  weightsSource?: WeightsSource
  loadedWeights?: string
  sessionModelBefore?: string; sessionModel?: string
  engineDeath?: HostEngineDeathFacts
  linkLost?: true
  cluster?: HostCluster
  nodes?: HostClusterPod[]
  tune?: HostTunePreferences; retuning?: HostRetune
}
export function readHostRecord(id: string): HostRecord | undefined {
  try { return { vendor: 'runpod', ...JSON.parse(readFileSync(recordPath(id), 'utf8')) } as HostRecord } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
export function patchHostRecord(id: string, patch: Partial<HostRecord>): HostRecord | undefined {
  const record = readHostRecord(id)
  if (!record) return
  const next = { ...record, ...patch }; writeHostRecord(next); return next
}
const ensuredDirectories = new Set<string>()
function ensureDirectory(dir: string): string {
  if (!ensuredDirectories.has(dir)) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); ensuredDirectories.add(dir) } catch (error) { if (!['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  }
  return dir
}
export function hostDirectory(): string {
  return ensureDirectory(join(getMercuryHome(), 'host'))
}
const podsDirectory = (): string => join(getMercuryHome(), 'host', 'pods')
function recordPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid host record id')
  return join(podsDirectory(), id + '.json')
}
export function writeHostRecord(record: HostRecord): void { ensureDirectory(podsDirectory()); publishAtomicSync(recordPath(record.id), JSON.stringify({ ...record, vendor: record.vendor ?? 'runpod' }) + '\n', { mode: 0o600 }) }
export function removeHostRecord(id: string): void {
  const record = readHostRecord(id)
  try { unlinkSync(recordPath(id)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (record) releaseHostHuggingfaceCredential(record)
}
export function hostRecords(): HostRecord[] {
  const dir = podsDirectory()
  try { return readdirSync(dir).filter(name => name.endsWith('.json')).flatMap(name => { try { return [{ vendor: 'runpod', ...JSON.parse(readFileSync(join(dir, name), 'utf8')) } as HostRecord] } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error } }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Host records could not be read. The paid-pods list still shows the connected vendors’ account resources.') }
}
export function watchHostDirectory(dir: string, onChange: (filename: string | null) => void, fallbackMs = 1000): () => void {
  let closed = false
  let watcher: FSWatcher | null = null
  let ancestor: FSWatcher | null = null
  const closeWatcher = (handle: FSWatcher | null): void => {
    try { handle?.close() } catch (error) { passedOver(error) }
  }
  const arm = (): void => {
    if (closed || watcher) return
    if (existsSync(dir)) {
      closeWatcher(ancestor)
      ancestor = null
      try {
        const w = watch(resolveWatchRoot(dir), { persistent: false }, (_event, filename) => {
          if (!closed) onChange(filename ? String(filename) : null)
        })
        w.unref?.()
        w.on('error', () => {
          closeWatcher(w)
          if (watcher === w) watcher = null
        })
        watcher = w
      } catch (error) {
        passedOver(error)
      }
      return
    }
    if (ancestor) return
    let root = dirname(dir)
    while (root !== dirname(root) && !existsSync(root)) root = dirname(root)
    const nextChild = relative(root, dir).split(sep)[0] ?? null
    try {
      const w = watch(resolveWatchRoot(root), { persistent: false }, (_event, filename) => {
        if (closed) return
        if (filename !== null && nextChild !== null && String(filename) !== nextChild) return
        if (existsSync(dir)) {
          arm()
          onChange(null)
        } else {
          let deeper = dirname(dir)
          while (deeper !== dirname(deeper) && !existsSync(deeper)) deeper = dirname(deeper)
          if (deeper !== root) {
            closeWatcher(w)
            if (ancestor === w) ancestor = null
            arm()
          }
        }
      })
      w.unref?.()
      w.on('error', () => {
        closeWatcher(w)
        if (ancestor === w) ancestor = null
      })
      ancestor = w
      if (existsSync(dir)) {
        arm()
        onChange(null)
      }
    } catch (error) {
      passedOver(error)
    }
  }
  arm()
  const timer = fallbackMs > 0 ? startInterval(() => {
    if (closed) return
    if (!watcher && !ancestor) arm()
    onChange(null)
  }, fallbackMs) : null
  return () => {
    closed = true
    if (timer !== null) stopInterval(timer)
    closeWatcher(watcher)
    watcher = null
    closeWatcher(ancestor)
    ancestor = null
  }
}
export function subscribeHostRecord(id: string, cb: (record: HostRecord | undefined) => void, fallbackMs = 1000, onBeat?: () => void): () => void {
  const path = recordPath(id)
  const file = id + '.json'
  const readRaw = (): string | null => {
    try { return readFileSync(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  let lastRaw = readRaw()
  const check = (beat: boolean): void => {
    let raw: string | null
    try { raw = readRaw() } catch (error) { passedOver(error); return }
    if (raw === lastRaw) {
      if (beat) onBeat?.()
      return
    }
    lastRaw = raw
    if (raw === null) { cb(undefined); return }
    try { cb({ vendor: 'runpod', ...JSON.parse(raw) } as HostRecord) } catch (error) { passedOver(error) }
  }
  return watchHostDirectory(podsDirectory(), filename => {
    if (filename === null || filename === file || filename.startsWith('.' + file + '.')) check(filename === null)
  }, fallbackMs)
}
export function subscribeHostRecords(cb: () => void, onBeat?: () => void): () => void {
  const dir = podsDirectory()
  const snapshot = (): string => {
    try {
      return readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => {
        try { return name + '\0' + readFileSync(join(dir, name), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
      }).join('\0')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      passedOver(error)
      return ''
    }
  }
  let last = snapshot()
  const check = (beat: boolean): void => {
    const next = snapshot()
    if (next === last) {
      if (beat) onBeat?.()
      return
    }
    last = next
    cb()
  }
  return watchHostDirectory(dir, filename => {
    if (filename === null || filename.endsWith('.json') || filename.endsWith('.tmp')) check(filename === null)
  })
}
