import { hostMachineName } from '../../commands/llmhost/words.js'
import { configuredCompatEndpoints } from '../providers/openaicompat/compatAccounts.js'
import { compatEndpointLastTurnAt } from '../providers/openaicompat/compatPrefixCache.js'
import { terminateHostResource } from './cluster.js'
import { terminateVerified } from './keptWeights.js'
import { hostNotice } from './notices.js'
import { HostTerminationUnconfirmed, hostJobReadOnly } from './retry.js'
import { closeHostTunnel } from './ssh.js'
import { hostRecords, patchHostRecord, readHostRecord, type HostRecord } from './store.js'
import { runpodOnly, vendorClient, vendorLabel } from './vendors/client.js'
import { keptDiskPrice, readKeptVolume, writeKeptVolume } from './volumes.js'

export const HOST_IDLE_LIMIT_MS = 2 * 3600_000
export const HOST_IDLE_POLL_MS = 5 * 60_000
export const hostIdleHoursWords = Math.round(HOST_IDLE_LIMIT_MS / 3600_000) + ' hours'

export interface HostIdleVerdict { kind: 'paused' | 'idle'; since: number }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function hostEndpointLastTurnAt(record: HostRecord): number | undefined {
  try {
    const endpoint = configuredCompatEndpoints().find(row => row.hostPodId === record.id || Boolean(record.provider) && row.name === record.provider)
    return endpoint ? compatEndpointLastTurnAt(endpoint) : undefined
  } catch { return undefined }
}

export function hostIdleSince(record: HostRecord, lastTurnAt: (record: HostRecord) => number | undefined = hostEndpointLastTurnAt): number | undefined {
  if (record.jobKind && record.jobKind !== 'setup') return undefined
  if (record.status === 'EXITED' || record.status === 'TERMINATED') return undefined
  if (record.jobState === 'paused') return record.advancedAt ?? record.steps?.findLast(row => row.step.startsWith('paused'))?.at
  if (record.jobState !== 'ready') return undefined
  const marks = [record.steps?.findLast(row => row.step === 'ready')?.at, record.advancedAt, lastTurnAt(record)].filter(finite)
  return marks.length ? Math.max(...marks) : undefined
}

export function hostIdleVerdict(record: HostRecord, now = Date.now(), options: { watchedSince?: number; lastTurnAt?: (record: HostRecord) => number | undefined } = {}): HostIdleVerdict | undefined {
  const since = hostIdleSince(record, options.lastTurnAt)
  if (since === undefined) return
  const floor = Math.max(since, options.watchedSince ?? since)
  if (now - floor < HOST_IDLE_LIMIT_MS) return
  return { kind: record.jobState === 'paused' ? 'paused' : 'idle', since: floor }
}

export function hostIdleReason(verdict: HostIdleVerdict, record?: HostRecord): string {
  if (verdict.kind !== 'paused') return 'no model request reached it for ' + hostIdleHoursWords
  const cause = record?.engineDeath ? 'the engine died and the pause' : record?.linkLost ? 'the link dropped and the pause' : 'the setup pause'
  return cause + ' went unanswered for ' + hostIdleHoursWords
}

export async function releaseIdleRental(record: HostRecord, verdict: HostIdleVerdict): Promise<void> {
  const vendor = record.vendor ?? 'runpod'
  const machine = record.cluster ? 'Runpod cluster ' + record.id : hostMachineName(vendor, record.id)
  const rate = '$' + record.price.toFixed(2) + '/hr'
  const reason = hostIdleReason(verdict, record)
  const plain = (value: unknown): string => (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim()
  hostNotice(record, 'idle', record.name + ' · ' + reason + ' · terminating ' + machine + ' · it bills ' + rate + ' until it is gone')
  const { stopHostSetup } = await import('./jobs.js')
  await stopHostSetup(record.id).catch(() => {})
  closeHostTunnel(record.id)
  const read = hostJobReadOnly({ label: vendorLabel(vendor), pauseMs: 5000, timeoutMs: 4 * 60_000, signal: new AbortController().signal, mark: step => { patchHostRecord(record.id, { step }) } })
  try {
    const api = vendorClient(record)
    if (record.cluster) await terminateHostResource(runpodOnly(api, 'Clusters'), { id: record.id, name: record.name, status: record.status, cost: record.price, createdAt: record.startedAt, family: record.cluster }, read)
    else await terminateVerified(api, record.id, read, api.label)
    if (record.provider) { const { removeLlmHostProvider } = await import('../llmHost/index.js'); removeLlmHostProvider(record.provider) }
    const volume = record.volumeId ? readKeptVolume(record.volumeId) : undefined
    if (volume && volume.preparingPod === record.id) writeKeptVolume({ ...volume, preparingPod: undefined })
    const disk = volume && volume.state !== 'gone' ? 'weights disk ' + volume.id + ' is kept and bills ' + keptDiskPrice(volume) : record.volumeId ? 'weights disk billing is not verified; check your account' : ''
    const ended = reason + ' · ' + machine + ' terminated and verified absent (' + api.label + ' no longer lists it) · ' + (disk || 'nothing more bills') + ' · /llmhost to rent again'
    patchHostRecord(record.id, { status: 'TERMINATED', jobState: 'failed', step: 'terminated after ' + hostIdleHoursWords + ' idle', error: ended })
    hostNotice(record, 'ended', record.name + ' · ' + ended)
  } catch (error) {
    const words = reason + ' · ' + (error instanceof HostTerminationUnconfirmed ? plain(error) : 'Mercury could not verify ' + machine + ' termination: ' + plain(error) + ' · check your account; it may still bill ' + rate) + ' · /llmhost → Machines I’m paying for → Terminate'
    patchHostRecord(record.id, { jobState: 'failed', error: words, step: words })
    hostNotice(record, 'failed', record.name + ' · ' + words)
  }
}

export async function sweepHostIdle(options: { now?: number; records?: HostRecord[]; watched?: Map<string, { marker: string; at: number }>; lastTurnAt?: (record: HostRecord) => number | undefined; release?: (record: HostRecord, verdict: HostIdleVerdict) => Promise<void> } = {}): Promise<HostIdleVerdict[]> {
  const now = options.now ?? Date.now()
  const verdicts: HostIdleVerdict[] = []
  for (const row of options.records ?? hostRecords()) {
    const marker = (row.generation ?? '') + ':' + (row.jobState ?? '')
    const seen = options.watched?.get(row.id)
    if (options.watched && seen?.marker !== marker) options.watched.set(row.id, { marker, at: now })
    const verdict = hostIdleVerdict(row, now, { watchedSince: options.watched ? (seen?.marker === marker ? seen.at : now) : undefined, lastTurnAt: options.lastTurnAt })
    if (!verdict) continue
    const current = readHostRecord(row.id)
    if (!current || current.generation !== row.generation || current.jobState !== row.jobState) continue
    verdicts.push(verdict)
    await (options.release ?? releaseIdleRental)(current, verdict)
  }
  return verdicts
}
