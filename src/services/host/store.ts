import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'
import { publishAtomicSync } from '../../substrate/fileStore.js'
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
  target?: SshTarget; localPort?: number; provider?: string
  sessionId?: string; workspace?: string; sshKey?: string; apiBaseUrl?: string
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
  try { return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => ({ vendor: 'runpod', ...JSON.parse(readFileSync(join(dir, name), 'utf8')) }) as HostRecord) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Host records could not be read. The paid-pods list still shows the connected vendors’ account resources.') }
}
