import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import type { SshTarget } from './ssh.js'
import type { HostRecipe } from './recipes.js'

export interface HostRecord {
  id: string; name: string; recipe: string; price: number; startedAt: string; status: string
  target?: SshTarget; localPort?: number; provider?: string
  sessionId?: string; workspace?: string; sshKey?: string; apiBaseUrl?: string
  jobKind?: 'setup' | 'watch'; maxPrice?: number; pollIntervalMs?: number; pollWindowMs?: number; rateLimit?: string; watchedFrom?: string; creating?: string
  jobState?: 'queued' | 'starting' | 'running' | 'ready' | 'failed' | 'stopped'
  generation?: string; jobStartedAt?: number; advancedAt?: number; step?: string; log?: string; error?: string
  steps?: { step: string; at: number }[]
  recipeRow?: HostRecipe
  volumeId?: string; prepareWeightsOnly?: boolean; verifyWeightsFully?: boolean; weightsCheck?: string
}
export function readHostRecord(id: string): HostRecord | undefined {
  try { return JSON.parse(readFileSync(recordPath(id), 'utf8')) as HostRecord } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
export function patchHostRecord(id: string, patch: Partial<HostRecord>): HostRecord | undefined {
  const record = readHostRecord(id)
  if (!record) return
  const next = { ...record, ...patch }; writeHostRecord(next); return next
}
export function hostDirectory(): string {
  const dir = join(getMercuryHome(), 'host')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
function recordPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid host record id')
  const dir = join(hostDirectory(), 'pods')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, id + '.json')
}
export function writeHostRecord(record: HostRecord): void { durableAtomicPublishSync(recordPath(record.id), JSON.stringify(record) + '\n', { mode: 0o600 }) }
export function removeHostRecord(id: string): void { try { unlinkSync(recordPath(id)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
export function hostRecords(): HostRecord[] {
  const dir = join(hostDirectory(), 'pods')
  try { return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as HostRecord) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Host records could not be read. The Runpod paid-pods list still shows the account resources.') }
}
