// ============================================================================
//  seatReceipts — ONE receipt row per APPLIED operator reslot.
//
//  The wait-doctrine means an operator reslot of an ENGAGED daemon seat may
//  apply LATER.
//  The request ACK ("queued — applies when idle") is not the APPLY. This module
//  closes the loop honestly: the apply surfaces (operatorReslot/reconfigure
//  callers) register an EXPECTATION; an observer watches seat TRUTH (the
//  daemon roster RPC for the Implementer) and mints exactly ONE receipt when
//  the running spec matches the request — or ONE honest timeout note when
//  it never lands.
//
//  Display truth = dispatch truth: observation keys on the RUNNING spec (the
//  roster's running-vs-pending split), never the requested spec, so a receipt
//  can never fire off the queued value itself.
//
//  Zero standing cost: observers arm only while expectations are pending and
//  disarm when the registry empties. The LOCAL seat (scribe — a foreground
//  pin) applies synchronously, so its caller mints the receipt directly.
//
//  The REPL hook (useSeatReceipts) subscribes and appends each receipt as one
//  informational system row; receipts minted before the hook mounts queue
//  (bounded) and drain on subscribe.
// ============================================================================
import { daemonRosterSnapshot } from '../cockpit/daemonRosterSnapshot.js'
import { resolveOpenaiAccount } from '../../services/providers/openai/openaiAccounts.js'
import { providerFamilyOfSetting } from './modelTransition.js'
import type { SlotRole } from './seatSlotStore.js'

export type SeatReceipt = {
  text: string
  level: 'info' | 'warning'
}

export type ReslotExpectation = {
  role: SlotRole
  /** Requested RESOLVED model id (validated upstream); absent = model unchanged. */
  model?: string
  /** Requested effort token; absent = effort unchanged. */
  effort?: string
  registeredAt: number
}

/** How long an unapplied expectation waits before the honest timeout receipt.
 *  Wait-doctrine: seats turn in MINUTES — 10m covers a deep turn without
 *  letting a dead daemon hold a phantom expectation forever. */
export const RESLOT_RECEIPT_DEADLINE_MS = 10 * 60_000

const RECEIPT_QUEUE_CAP = 20
const OBSERVER_TICK_MS = 5_000

/** PURE: does observed running truth satisfy the expectation? Exact-id match —
 *  the roster stores the validated resolved id, and the request carries the
 *  same resolution, so string equality is the honest comparator. */
export function expectationSatisfied(
  exp: Pick<ReslotExpectation, 'model' | 'effort'>,
  truth: { model?: string; effort?: string },
): boolean {
  const mOk = exp.model === undefined || truth.model === exp.model
  const eOk = exp.effort === undefined || truth.effort === exp.effort
  return mOk && eOk
}

/** A6 binding-record fact: name the backend when a seat leaves the Anthropic
 *  main loop (an engine slot is a deliberate cross-provider composition —
 *  the receipt records where the work actually runs). Since (the
 *  lm-studio-residue incident) the OpenAI note also names the ACCOUNT SOURCE
 *  the dispatch will bill — "backend: native OpenAI Responses" alone let a
 *  leftover env OPENAI_API_KEY silently stand in for the operator's expected
 *  ChatGPT subscription; and a MISSING source is named loudly instead of
 *  discovered as a silent child crash-loop. */
export function seatBackendNote(model: string | undefined): string {
  if (!model) return ''
  const family = providerFamilyOfSetting(model)
  if (family === 'openai') {
    let source: string | undefined
    try {
      source = resolveOpenaiAccount()?.label
    } catch {
      source = undefined
    }
    return ` · backend: native OpenAI Responses · ${source ?? 'NO OpenAI account connected — /logins before this seat can serve'}`
  }
  if (family === 'zai') return ' · backend: native Z.AI'
  return ''
}

/** PURE: the one receipt-row spelling (glyph from the kit vocabulary — no emoji). */
export function composeAppliedReceipt(exp: Pick<ReslotExpectation, 'role' | 'model' | 'effort'>): string {
  const parts = [exp.model, exp.effort ? `@${exp.effort}` : undefined].filter(Boolean).join(' ')
  return `⇄ reslot applied — ${exp.role} → ${parts || 'spec'}${seatBackendNote(exp.model)}`
}

/** PURE: the honest never-observed spelling. */
export function composeTimeoutReceipt(exp: Pick<ReslotExpectation, 'role' | 'model' | 'effort'>): string {
  const parts = [exp.model, exp.effort ? `@${exp.effort}` : undefined].filter(Boolean).join(' ')
  return `▲ reslot pending — ${exp.role} → ${parts || 'spec'} not observed applied after 10m (seat busy or daemon down — check /daemon)`
}

// ── registry + emission ──────────────────────────────────────────────────────

const expectations: ReslotExpectation[] = []
const queue: SeatReceipt[] = []
const listeners = new Set<(r: SeatReceipt) => void>()

function emit(r: SeatReceipt): void {
  if (listeners.size === 0) {
    queue.push(r)
    if (queue.length > RECEIPT_QUEUE_CAP) queue.shift()
    return
  }
  for (const l of listeners) l(r)
}

/** Subscribe the transcript emitter (the REPL hook). Queued receipts drain
 *  immediately, in order. Returns the unsubscribe. */
export function subscribeSeatReceipts(cb: (r: SeatReceipt) => void): () => void {
  listeners.add(cb)
  while (queue.length > 0) {
    const r = queue.shift()!
    for (const l of listeners) l(r)
  }
  return () => {
    listeners.delete(cb)
  }
}

/** Mint a receipt for a SYNCHRONOUS apply (local foreground seats, or a
 *  persist-only reslot that names its own outcome). One row, immediately. */
export function mintImmediateReceipt(text: string, level: SeatReceipt['level'] = 'info'): void {
  emit({ text, level })
}

// ── observers (armed only while expectations pend) ──────────────────────────

let implementerTimer: ReturnType<typeof setInterval> | null = null
let deadlineTimer: ReturnType<typeof setInterval> | null = null

function settle(exp: ReslotExpectation, receipt: SeatReceipt): void {
  const i = expectations.indexOf(exp)
  if (i < 0) return // already settled (double observation)
  expectations.splice(i, 1)
  emit(receipt)
  rearmObservers()
}

async function pollImplementer(): Promise<void> {
  if (!expectations.some(e => e.role === 'implementer')) return
  const snap = await daemonRosterSnapshot('implementer').catch(() => null)
  if (!snap?.ok || !snap.entry) return
  const truth = { model: snap.entry.model, effort: snap.entry.effort }
  for (const exp of [...expectations]) {
    if (exp.role !== 'implementer') continue
    if (expectationSatisfied(exp, truth)) {
      settle(exp, { text: composeAppliedReceipt(exp), level: 'info' })
    }
  }
}

function sweepDeadlines(): void {
  const now = Date.now()
  for (const exp of [...expectations]) {
    if (now - exp.registeredAt >= RESLOT_RECEIPT_DEADLINE_MS) {
      settle(exp, { text: composeTimeoutReceipt(exp), level: 'warning' })
    }
  }
}

function rearmObservers(): void {
  const wantImplementer = expectations.some(e => e.role === 'implementer')
  const wantDeadline = expectations.length > 0
  if (wantImplementer && implementerTimer === null) {
    void pollImplementer()
    implementerTimer = setInterval(() => void pollImplementer(), OBSERVER_TICK_MS)
    implementerTimer.unref?.()
  } else if (!wantImplementer && implementerTimer !== null) {
    clearInterval(implementerTimer)
    implementerTimer = null
  }
  if (wantDeadline && deadlineTimer === null) {
    deadlineTimer = setInterval(sweepDeadlines, OBSERVER_TICK_MS)
    deadlineTimer.unref?.()
  } else if (!wantDeadline && deadlineTimer !== null) {
    clearInterval(deadlineTimer)
    deadlineTimer = null
  }
}

/**
 * Register an expectation for an ASYNC apply (a daemon-seat reconfigure that
 * ACKed respawning/queued). Observation arms now; the receipt mints when the
 * seat's RUNNING truth matches, or the timeout note fires at the deadline.
 * A newer expectation for the same role supersedes the older one silently
 * (the operator changed their mind — only the final state deserves a row).
 */
export function registerReslotExpectation(exp: Omit<ReslotExpectation, 'registeredAt'>): void {
  for (let i = expectations.length - 1; i >= 0; i--) {
    if (expectations[i]!.role === exp.role) expectations.splice(i, 1)
  }
  expectations.push({ ...exp, registeredAt: Date.now() })
  rearmObservers()
}

/** Test seam: run one deadline sweep now (the 5s interval owns it live). */
export function __sweepDeadlinesForTests(): void {
  sweepDeadlines()
}

/** Test seam: clear registry, queue, listeners, observers. */
export function __resetSeatReceiptsForTests(): void {
  expectations.length = 0
  queue.length = 0
  listeners.clear()
  rearmObservers()
}

/** Test seam: the pending expectations (read-only view). */
export function __pendingExpectationsForTests(): readonly ReslotExpectation[] {
  return [...expectations]
}
