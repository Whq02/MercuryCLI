
import { join } from 'node:path'
import { defineStore } from '../substrate/fileStore.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { getGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import {
  acknowledgeObligation,
  noteObligationEmission,
} from './crew/obligations.js'

export const CONCOURSE_SIGNAL_KINDS = [
  'started',
  'needs-you',
  'ready-to-review',
  'completed',
  'failed',
] as const
export type ConcourseSignalKind = (typeof CONCOURSE_SIGNAL_KINDS)[number]

export interface SignalTarget {
  sessionId?: string
  obligationId?: string
}

export interface ConcourseSignal {
  kind: ConcourseSignalKind
  targetId: string
  revision: number
  title: string
  detail?: string
  deepLink?: SignalTarget
  obligationBacked?: boolean
}

export type SignalOutcome =
  | { emitted: true; destination: 'host'; method: string }
  | { emitted: false; reason: 'policy-off' | 'duplicate-revision' | 'coalesced' | 'emit-failed' }


const HOST_DEFAULTS: Record<ConcourseSignalKind, boolean> = {
  started: false,
  'needs-you': true,
  'ready-to-review': true,
  completed: true,
  failed: true,
}

export function hostSignalEnabled(kind: ConcourseSignalKind): boolean {
  const cfg = getGlobalConfig().concourseHostSignals
  switch (kind) {
    case 'started':
      return cfg?.started ?? HOST_DEFAULTS.started
    case 'needs-you':
      return cfg?.needsYou ?? HOST_DEFAULTS['needs-you']
    case 'ready-to-review':
      return cfg?.readyToReview ?? HOST_DEFAULTS['ready-to-review']
    case 'completed':
    case 'failed':
      return cfg?.settled ?? HOST_DEFAULTS.completed
  }
}

export function detailedPreviewEnabled(): boolean {
  return getGlobalConfig().concourseHostSignals?.detailedPreview ?? false
}


interface DedupRowV1 {
  emittedRevision: number
  emittedAtMs: number
  acknowledgedRevision?: number
}

interface DedupFileV1 {
  rows: Record<string, DedupRowV1>
}

const MAX_DEDUP_ROWS = 500

const dedupStore = defineStore<DedupFileV1, [dir?: string]>({
  name: 'notification-dedup',
  path: (dir?: string) => join(dir ?? getMercuryHome(), 'notification-dedup.json'),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<DedupFileV1>
    const out: DedupFileV1 = { rows: {} }
    if (r.rows && typeof r.rows === 'object' && !Array.isArray(r.rows)) {
      for (const [k, v] of Object.entries(r.rows)) {
        if (v && typeof v === 'object' && typeof (v as DedupRowV1).emittedRevision === 'number') {
          out.rows[k] = v as DedupRowV1
        }
      }
    }
    return out
  },
  empty: () => ({ rows: {} }),
  onReadFailure: 'empty',
})

function compact(rows: Record<string, DedupRowV1>): Record<string, DedupRowV1> {
  const keys = Object.keys(rows)
  if (keys.length <= MAX_DEDUP_ROWS) return rows
  const drop = new Set(
    keys.sort((a, b) => rows[a]!.emittedAtMs - rows[b]!.emittedAtMs).slice(0, keys.length - MAX_DEDUP_ROWS),
  )
  return Object.fromEntries(Object.entries(rows).filter(([k]) => !drop.has(k)))
}

export async function claimEmission(
  kind: ConcourseSignalKind,
  targetId: string,
  destination: string,
  revision: number,
  opts?: { dir?: string },
): Promise<boolean> {
  const store = dedupStore(opts?.dir)
  return store.update<boolean>(current => {
    const key = `${kind}|${targetId}|${destination}`
    const row = current.rows[key]
    if (row && (row.emittedRevision >= revision || (row.acknowledgedRevision ?? -1) >= revision)) {
      return { next: current, result: false }
    }
    return {
      next: {
        rows: compact({
          ...current.rows,
          [key]: {
            emittedRevision: revision,
            emittedAtMs: Date.now(),
            ...(row?.acknowledgedRevision !== undefined
              ? { acknowledgedRevision: row.acknowledgedRevision }
              : {}),
          },
        }),
      },
      result: true,
    }
  })
}

export async function acknowledgeSignal(
  signal: Pick<ConcourseSignal, 'kind' | 'targetId' | 'revision' | 'obligationBacked'>,
  destination: string,
  opts?: { dir?: string },
): Promise<boolean> {
  if (signal.obligationBacked) {
    return acknowledgeObligation(signal.targetId, destination, signal.revision, { scope: 'switchboard', ...opts })
  }
  const store = dedupStore(opts?.dir)
  return store.update<boolean>(current => {
    const key = `${signal.kind}|${signal.targetId}|${destination}`
    const row = current.rows[key] ?? { emittedRevision: 0, emittedAtMs: Date.now() }
    if ((row.acknowledgedRevision ?? -1) >= signal.revision) return { next: current, result: false }
    return {
      next: {
        rows: compact({ ...current.rows, [key]: { ...row, acknowledgedRevision: signal.revision } }),
      },
      result: true,
    }
  })
}


interface JournalRowV1 {
  seq: number
  signal: ConcourseSignal
  decidedAtMs: number
}

interface JournalFileV1 {
  rows: JournalRowV1[]
  nextSeq: number
  consumedSeq: number
}

const MAX_JOURNAL_ROWS = 100

const journalStore = defineStore<JournalFileV1, [dir?: string]>({
  name: 'concourse-notification-journal',
  path: (dir?: string) => join(dir ?? getMercuryHome(), 'notification-journal.json'),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<JournalFileV1>
    return {
      rows: Array.isArray(r.rows) ? (r.rows.filter(x => x && typeof (x as JournalRowV1).seq === 'number') as JournalRowV1[]) : [],
      nextSeq: typeof r.nextSeq === 'number' ? r.nextSeq : 1,
      consumedSeq: typeof r.consumedSeq === 'number' ? r.consumedSeq : 0,
    }
  },
  empty: () => ({ rows: [], nextSeq: 1, consumedSeq: 0 }),
  onReadFailure: 'empty',
})

export type JournalOutcome =
  | { journaled: true; seq: number }
  | { journaled: false; reason: 'policy-off' | 'duplicate-revision' }

export async function journalConcourseSignal(
  signal: ConcourseSignal,
  opts?: { dir?: string },
): Promise<JournalOutcome> {
  if (!hostSignalEnabled(signal.kind)) return { journaled: false, reason: 'policy-off' }
  const claimed = signal.obligationBacked
    ? await noteObligationEmission(signal.targetId, 'journal', signal.revision, { scope: 'switchboard', ...(opts?.dir !== undefined ? { dir: opts.dir } : {}) })
    : await claimEmission(signal.kind, signal.targetId, 'journal', signal.revision, opts?.dir !== undefined ? { dir: opts.dir } : undefined)
  if (!claimed) return { journaled: false, reason: 'duplicate-revision' }
  const store = journalStore(opts?.dir)
  return store.update<JournalOutcome>(current => {
    const seq = current.nextSeq
    const rows = [...current.rows, { seq, signal, decidedAtMs: Date.now() }].slice(-MAX_JOURNAL_ROWS)
    return { next: { rows, nextSeq: seq + 1, consumedSeq: current.consumedSeq }, result: { journaled: true, seq } }
  })
}

export async function readUnseenJournalSignals(opts?: { dir?: string }): Promise<JournalRowV1[]> {
  const f = await journalStore(opts?.dir).read()
  return f.rows.filter(r => r.seq > f.consumedSeq)
}

export async function markJournalConsumed(seq: number, opts?: { dir?: string }): Promise<void> {
  await journalStore(opts?.dir).mutate(current => ({
    ...current,
    consumedSeq: Math.max(current.consumedSeq, seq),
  }))
}

export function subscribeNotificationJournal(cb: () => void, dir?: string): () => void {
  return journalStore(dir).subscribe(() => cb(), { immediate: false })
}


const COALESCE_WINDOW_MS = 1500
interface CoalesceBucket {
  signals: ConcourseSignal[]
  timer: ReturnType<typeof setTimeout>
}
let settledBucket: CoalesceBucket | null = null


export interface EmitDeps {
  send: (args: { message: string; title: string; notificationType: string }) => Promise<string>
  dir?: string
  coalesceMs?: number
}

function hostCopy(signal: ConcourseSignal): { title: string; message: string } {
  const message =
    signal.detail !== undefined && detailedPreviewEnabled() ? signal.detail : signal.title
  return { title: 'Mercury', message }
}

async function emitNow(signal: ConcourseSignal, deps: EmitDeps): Promise<SignalOutcome> {
  const { title, message } = hostCopy(signal)
  try {
    const method = await deps.send({ message, title, notificationType: `concourse-${signal.kind}` })
    return { emitted: true, destination: 'host', method }
  } catch (e) {
    logForDebugging(`[notification-policy] host emission failed: ${e}`)
    return { emitted: false, reason: 'emit-failed' }
  }
}

export async function emitConcourseSignal(
  signal: ConcourseSignal,
  deps: EmitDeps,
): Promise<SignalOutcome> {
  if (!hostSignalEnabled(signal.kind)) return { emitted: false, reason: 'policy-off' }
  const claimed = signal.obligationBacked
    ? await noteObligationEmission(signal.targetId, 'host', signal.revision, { scope: 'switchboard', ...(deps.dir !== undefined ? { dir: deps.dir } : {}) })
    : await claimEmission(signal.kind, signal.targetId, 'host', signal.revision, deps.dir !== undefined ? { dir: deps.dir } : undefined)
  if (!claimed) return { emitted: false, reason: 'duplicate-revision' }

  if (signal.kind === 'completed' || signal.kind === 'failed') {
    const windowMs = deps.coalesceMs ?? COALESCE_WINDOW_MS
    if (settledBucket) {
      settledBucket.signals.push(signal)
      return { emitted: false, reason: 'coalesced' }
    }
    settledBucket = {
      signals: [signal],
      timer: setTimeout(() => {
        const bucket = settledBucket
        settledBucket = null
        if (!bucket) return
        const one = bucket.signals.length === 1 ? bucket.signals[0]! : null
        const coalesced: ConcourseSignal =
          one ??
          ({
            kind: 'completed',
            targetId: 'coalesced',
            revision: 0,
            title: `${bucket.signals.length} sessions settled`,
          } satisfies ConcourseSignal)
        void emitNow(coalesced, deps)
      }, windowMs),
    }
    settledBucket.timer.unref?.()
    return { emitted: false, reason: 'coalesced' }
  }

  return emitNow(signal, deps)
}

export function _resetNotificationPolicyForTesting(): void {
  if (settledBucket) {
    clearTimeout(settledBucket.timer)
    settledBucket = null
  }
}
