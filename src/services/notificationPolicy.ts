// ============================================================================
// notificationPolicy — the ONE policy layer ABOVE
//  src/services/notifier.ts (which keeps its law untouched: emission ≠
//  delivery — "delivered" is never claimed; presence suppression and channel
//  resolution stay the notifier's job).
//
//  This layer owns: per-user HOST-signal settings (config
//  `concourseHostSignals`), EDGE-TRIGGERED evaluation with deduplication by
//  obligation/state REVISION (never a second emission for one revision, and
//  reconnect/restart replay never re-emits an ACKNOWLEDGED revision — the
//  dedup records are durable and bounded), sibling-settlement COALESCING,
//  typed deep-link targets (the route owner's vocabulary — activation opens
//  the exact session/obligation), and the privacy floor (no private prompt
//  content in host notifications unless detailedPreview is explicitly on).
//
// Dedup homes: an OBLIGATION-backed signal records its emission/
//  acknowledgement ON the obligation row (the owner's per-destination state
//  — obligation state lives per-obligation); every other signal (started /
//  ready / settled per session) records in THIS module's bounded durable
//  dedup store, registered in LIFECYCLE_MANIFEST.
//
//  In-app attention is NOT gated here: the attention projection renders
//  durable rows regardless of host policy/denial — host emission is
//  strictly additive.
// ============================================================================

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

/** The typed deep-link target — the route owner's vocabulary (the
 *  basis: activation opens the EXACT session/obligation; the surface wiring
 *  lands with the board). */
export interface SignalTarget {
  sessionId?: string
  obligationId?: string
}

export interface ConcourseSignal {
  kind: ConcourseSignalKind
  /** The dedup subject: the obligationId for obligation-backed signals,
   *  else the session/run identity the signal is about. */
  targetId: string
  /** The subject's state revision — ONE emission per (kind, target,
   *  destination, revision). */
  revision: number
  /** Public copy (always safe for host display). */
  title: string
  /** Detail copy — shown on host ONLY with detailedPreview on. */
  detail?: string
  deepLink?: SignalTarget
  /** True when targetId is an obligationId (dedup rides the obligation
   *  row's own per-destination state). */
  obligationBacked?: boolean
}

export type SignalOutcome =
  | { emitted: true; destination: 'host'; method: string }
  | { emitted: false; reason: 'policy-off' | 'duplicate-revision' | 'coalesced' | 'emit-failed' }

// ── per-user policy ─────────────────────────────────────────────────────────

const HOST_DEFAULTS: Record<ConcourseSignalKind, boolean> = {
  // Started — in-app always, HOST opt-in (default off).
  started: false,
  // Needs-you — in-app mandatory; host per setting (default on).
  'needs-you': true,
  'ready-to-review': true,
  completed: true,
  failed: true,
}

/** The per-user HOST policy for one signal kind (in-app is never gated). */
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

// ── the durable dedup store (non-obligation signals) ────────────────────────

interface DedupRowV1 {
  emittedRevision: number
  emittedAtMs: number
  acknowledgedRevision?: number
}

interface DedupFileV1 {
  /** `${kind}|${targetId}|${destination}` → row. Bounded + compactable. */
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

/** Atomically claim (kind, target, destination, revision) — true exactly
 *  once per revision; an acknowledged revision can never re-claim. */
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

/** Record the operator's acknowledgement (a later replay of ≤revision can
 *  never re-emit). */
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

// ── the cross-process emission journal (the daemon half) ────────
//  The daemon has no host toast: its seams DECIDE (policy gate + a claim on
//  destination 'journal') and append the FULL signal here; the visible
//  process replays unseen rows through emitConcourseSignal with the REAL
//  sender, whose own claim on destination 'host' makes the pair emit the
//  toast EXACTLY ONCE — the dedup key already carries the destination
//  column, so the two claims never collide, and a crash between replay and
//  cursor advance re-runs into a duplicate-revision refusal, never a second
//  toast. (A dedicated entry, not a journal-flavored send: EmitDeps.send
//  receives only {message,title,notificationType} — the replay needs the
//  whole ConcourseSignal.) coordinator receipt fold rides this SAME
//  pattern with its own store (one mechanism, two stores).

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

/** The DAEMON-side decision entry: gate → claim (destination 'journal') →
 *  append the full signal for the visible process's replay. */
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

/** The VISIBLE-side replay read: decided rows this process has not yet
 *  replayed to the host. */
export async function readUnseenJournalSignals(opts?: { dir?: string }): Promise<JournalRowV1[]> {
  const f = await journalStore(opts?.dir).read()
  return f.rows.filter(r => r.seq > f.consumedSeq)
}

/** Advance the replay cursor (idempotent; never rewinds). */
export async function markJournalConsumed(seq: number, opts?: { dir?: string }): Promise<void> {
  await journalStore(opts?.dir).mutate(current => ({
    ...current,
    consumedSeq: Math.max(current.consumedSeq, seq),
  }))
}

export function subscribeNotificationJournal(cb: () => void, dir?: string): () => void {
  return journalStore(dir).subscribe(() => cb(), { immediate: false })
}

// ── coalescing (sibling settlements) ────────────────────────────────────────

const COALESCE_WINDOW_MS = 1500
interface CoalesceBucket {
  signals: ConcourseSignal[]
  timer: ReturnType<typeof setTimeout>
}
let settledBucket: CoalesceBucket | null = null

// ── the emission path ───────────────────────────────────────────────────────

export interface EmitDeps {
  /** The notifier seam (production: sendNotification with the REPL's
   *  terminal handle; proofs inject a recorder). */
  send: (args: { message: string; title: string; notificationType: string }) => Promise<string>
  dir?: string
  /** Proofs collapse the coalescing window. */
  coalesceMs?: number
}

function hostCopy(signal: ConcourseSignal): { title: string; message: string } {
  // Privacy floor: detail (prompt/question text) reaches the host ONLY
  // with the explicit detailed-preview setting; the public title always
  // stays generic-safe.
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

/**
 * Emit one Concourse signal through the policy: per-user HOST setting →
 * revision dedup (obligation row or the durable dedup store) → coalescing
 * for sibling settlements → the notifier. Edge-triggered by construction:
 * callers invoke on STATE CHANGES; the revision claim makes replays free.
 * In-app attention is untouched either way.
 */
export async function emitConcourseSignal(
  signal: ConcourseSignal,
  deps: EmitDeps,
): Promise<SignalOutcome> {
  if (!hostSignalEnabled(signal.kind)) return { emitted: false, reason: 'policy-off' }
  const claimed = signal.obligationBacked
    ? await noteObligationEmission(signal.targetId, 'host', signal.revision, { scope: 'switchboard', ...(deps.dir !== undefined ? { dir: deps.dir } : {}) })
    : await claimEmission(signal.kind, signal.targetId, 'host', signal.revision, deps.dir !== undefined ? { dir: deps.dir } : undefined)
  if (!claimed) return { emitted: false, reason: 'duplicate-revision' }

  // Sibling-settlement coalescing: completed/failed within the window fold
  // into ONE host emission ("N sessions settled") — never a burst.
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

/** Proof seam. */
export function _resetNotificationPolicyForTesting(): void {
  if (settledBucket) {
    clearTimeout(settledBucket.timer)
    settledBucket = null
  }
}
