import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../../platform/environment/envUtils.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { hostMachineName } from '../../commands/llmhost/words.js'
import { configuredCompatEndpoints } from '../roads/openaicompat/compatAccounts.js'
import { compatEndpointLastTurnAt } from '../roads/openaicompat/compatPrefixCache.js'
import { terminateHostResource } from './cluster.js'
import { terminateVerified } from './keptWeights.js'
import { hostNotice } from './notices.js'
import { HostTerminationUnconfirmed, hostJobReadOnly } from './retry.js'
import { closeHostTunnel } from './ssh.js'
import { hostRecords, patchHostRecord, readHostRecord, type HostRecord } from './store.js'
import { runpodOnly, vendorClient, vendorLabel } from './vendors/client.js'
import { keptDiskPrice, readKeptVolume, writeKeptVolume } from './volumes.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export const HOST_IDLE_LIMIT_MS = 2 * 3600_000
export const HOST_IDLE_POLL_MS = 5 * 60_000
export const hostIdleHoursWords = Math.round(HOST_IDLE_LIMIT_MS / 3600_000) + ' hours'

interface HostIdleVerdict { kind: 'paused' | 'idle'; since: number }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const plainError = (value: unknown): string => (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim()
const idleReadFailing = new Set<string>()
const idleReadEpisodes = new Map<string, number>()

export function hostEndpointLastTurnAt(record: HostRecord): number | undefined {
  try {
    const endpoint = configuredCompatEndpoints().find(row => row.hostPodId === record.id || Boolean(record.provider) && row.name === record.provider)
    return endpoint ? compatEndpointLastTurnAt(endpoint) : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function mediaLastRequestAt(id: string): number | undefined {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) return undefined
  try {
    const { at } = JSON.parse(readFileSync(join(getMercuryHome(), 'host', 'media', id, 'activity.json'), 'utf8')) as { at?: unknown }
    return finite(at) ? at : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function readIdleSince(record: HostRecord, lastTurnAt: (record: HostRecord) => number | undefined = hostEndpointLastTurnAt): { since: number | undefined; unread?: unknown } {
  if (record.jobKind && record.jobKind !== 'setup') return { since: undefined }
  if (record.status === 'EXITED' || record.status === 'TERMINATED') return { since: undefined }
  if (record.jobState === 'paused') return { since: record.advancedAt ?? record.steps?.findLast(row => row.step.startsWith('paused'))?.at }
  if (record.jobState !== 'ready') return { since: undefined }
  let lastTurn: number | undefined
  let mediaAt: number | undefined
  try {
    lastTurn = lastTurnAt(record)
    mediaAt = mediaLastRequestAt(record.id)
  } catch (error) {
    logForDebugging(`[host] idle mark for ${record.id} could not be read (${plainError(error)}); leaving host running`, { level: 'warn' })
    return { since: undefined, unread: error }
  }
  const marks = [record.steps?.findLast(row => row.step === 'ready')?.at, record.advancedAt, lastTurn, mediaAt].filter(finite)
  return { since: marks.length ? Math.max(...marks) : undefined }
}

function idleUnreadWords(record: HostRecord, error: unknown): string {
  const vendor = record.vendor ?? 'runpod'
  const machine = record.cluster ? 'Runpod cluster ' + record.id : hostMachineName(vendor, record.id)
  const rate = '$' + record.price.toFixed(2) + '/hr'
  return record.name + ' · ' + machine + ' is still running and bills ' + rate + ' because its last use could not be read (' + plainError(error) + ') · /llmhost → Machines I’m paying for → Terminate stops it'
}

function noteIdleUnread(record: HostRecord, error: unknown): void {
  if (idleReadFailing.has(record.id)) return
  idleReadFailing.add(record.id)
  const episode = (idleReadEpisodes.get(record.id) ?? 0) + 1
  idleReadEpisodes.set(record.id, episode)
  hostNotice(record, 'idle-unread-' + episode, idleUnreadWords(record, error))
}

export function hostIdleSince(record: HostRecord, lastTurnAt: (record: HostRecord) => number | undefined = hostEndpointLastTurnAt): number | undefined {
  return readIdleSince(record, lastTurnAt).since
}

export function hostIdleVerdict(record: HostRecord, now = Date.now(), options: { watchedSince?: number; lastTurnAt?: (record: HostRecord) => number | undefined } = {}): HostIdleVerdict | undefined {
  const since = hostIdleSince(record, options.lastTurnAt)
  if (since === undefined) return
  const floor = Math.max(since, options.watchedSince ?? since)
  if (now - floor < HOST_IDLE_LIMIT_MS) return
  return { kind: record.jobState === 'paused' ? 'paused' : 'idle', since: floor }
}

function hostIdleReason(verdict: HostIdleVerdict, record?: HostRecord): string {
  if (verdict.kind !== 'paused') return 'no model request reached it for ' + hostIdleHoursWords
  const cause = record?.engineDeath ? 'the engine died and the pause' : record?.linkLost ? 'the link dropped and the pause' : 'the setup pause'
  return cause + ' went unanswered for ' + hostIdleHoursWords
}

async function releaseIdleRental(record: HostRecord, verdict: HostIdleVerdict): Promise<void> {
  const vendor = record.vendor ?? 'runpod'
  const machine = record.cluster ? 'Runpod cluster ' + record.id : hostMachineName(vendor, record.id)
  const rate = '$' + record.price.toFixed(2) + '/hr'
  const reason = hostIdleReason(verdict, record)
  const plain = (value: unknown): string => (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim()
  hostNotice(record, 'idle', record.name + ' · ' + reason + ' · terminating ' + machine + ' · it bills ' + rate + ' until it is gone')
  const { stopHostSetup } = await import('./jobs.js')
  await stopHostSetup(record.id).catch(passedOver)
  closeHostTunnel(record.id)
  const read = hostJobReadOnly({ label: vendorLabel(vendor), pauseMs: 5000, timeoutMs: 4 * 60_000, signal: new AbortController().signal, mark: step => { patchHostRecord(record.id, { step }) } })
  try {
    const api = vendorClient(record)
    if (record.cluster) await terminateHostResource(runpodOnly(api, 'Clusters'), { id: record.id, name: record.name, status: record.status, cost: record.price, createdAt: record.startedAt, family: record.cluster }, read)
    else await terminateVerified(api, record.id, read, api.label)
    let unregisterNote = ''
    if (record.provider) {
      const { removeLlmHostProvider, tensorFoldUnregisterFailedNote } = await import('../llm-host/index.js')
      const removed = await removeLlmHostProvider(record.provider)
      if (removed.tensorFoldUnregisterError) unregisterNote = ' · ' + tensorFoldUnregisterFailedNote(removed.tensorFoldUnregisterError)
    }
    const { restoreRentingSessionOutcome } = await import('./worker.js')
    const restored = await restoreRentingSessionOutcome(record)
    const restoreNote = restored.state === 'failed' ? ' · this session stays on a model that is gone (' + restored.detail + ') — run /model ' + record.sessionModelBefore : ''
    const volume = record.volumeId ? readKeptVolume(record.volumeId) : undefined
    if (volume && volume.preparingPod === record.id) writeKeptVolume({ ...volume, preparingPod: undefined })
    const disk = volume && volume.state !== 'gone' ? 'weights disk ' + volume.id + ' is kept and bills ' + keptDiskPrice(volume) : record.volumeId ? 'weights disk billing is not verified; check your account' : ''
    const ended = reason + ' · ' + machine + ' terminated · ' + (disk || 'nothing more bills') + restoreNote + unregisterNote
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
    const current = readHostRecord(row.id)
    if (!current || current.generation !== row.generation || current.jobState !== row.jobState) {
      idleReadFailing.delete(row.id)
      continue
    }
    const watchedSince = options.watched ? (seen?.marker === marker ? seen.at : now) : undefined
    const judge = (): HostIdleVerdict | undefined => {
      const read = readIdleSince(current, options.lastTurnAt)
      if (read.unread !== undefined) {
        noteIdleUnread(current, read.unread)
        return undefined
      }
      idleReadFailing.delete(current.id)
      if (read.since === undefined) return undefined
      const floor = Math.max(read.since, watchedSince ?? read.since)
      if (now - floor < HOST_IDLE_LIMIT_MS) return undefined
      return { kind: current.jobState === 'paused' ? 'paused' : 'idle', since: floor }
    }
    let verdict = judge()
    if (!verdict) continue
    if (verdict.kind === 'idle') {
      try { await (await import('../../integrations/media/host.js')).refreshMediaHostActivity(current.id) } catch (error) { passedOver(error); continue }
      verdict = judge()
      if (!verdict) continue
    }
    verdicts.push(verdict)
    await (options.release ?? releaseIdleRental)(current, verdict)
  }
  return verdicts
}
