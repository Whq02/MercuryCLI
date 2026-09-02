// ============================================================================
// crew/obligations — durable needs-you
//  OBLIGATIONS at the crew-conversation owner family.
//
//  The attention module stays a pure ephemeral projection BY WRITTEN LAW
// the conversation
//  ring EVICTS at 100 events. So an unresolved human question lives HERE:
//  one obligation = one durable row, stored per-obligation (never per-event),
//  minted/updated through atomic single-store mutations (the conversations
//  idiom — dedupe and append are ONE mutation, so racing mirrors can never
//  double-post). attention/ consumes these rows through
//  registerAttentionGatherer (obligationsBridge.ts) as a per-principal
//  projection; the notification policy layer rides the per-
//  destination EMISSION + acknowledgement state carried on each row —
//  emission ≠ delivery is product law, "delivered" is never claimed.
//
// Race law: an answer racing a withdrawal settles DETERMINISTICALLY —
//  the first store mutation wins the status transition; the loser's attempt
//  is PRESERVED on the row's bounded settlementAttempts ledger (both events
//  visible, exactly one settlement).
// ============================================================================

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getCwd } from '../../utils/cwd.js'
import { crewStoreRoot } from './identity.js'

export const OBLIGATION_STATUSES = ['open', 'answered', 'resolved', 'withdrawn', 'superseded'] as const
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number]

export type ObligationSettlementKind = Exclude<ObligationStatus, 'open'>

export interface ObligationNotificationStateV1 {
  /** The row revision this destination last EMITTED at (never 'delivered' —
   *  the notifier's law). */
  emittedRevision: number
  emittedAtMs: number
  /** The row revision the operator ACKNOWLEDGED at this destination. */
  acknowledgedRevision?: number
  acknowledgedAtMs?: number
}

export interface ObligationSettlementAttemptV1 {
  kind: ObligationSettlementKind
  by?: string
  atMs: number
  /** True on the attempt that WON the transition; a losing racer stays
   *  preserved with applied=false (both events visible, one settlement). */
  applied: boolean
}

export interface ObligationV1 {
  schema: 1
  /** Stable durable identity — never re-minted by an idempotent re-raise. */
  obligationId: string
  /** The idempotency identity (receipt:<clientMessageId>, frame id, …) —
   *  ONE OPEN row per ref; a re-raise updates it in place. */
  ref: string
  /** Source session identity (the runtime SessionId of the asking session). */
  sessionId: string
  /** The crew conversation carrying the question event, when known. */
  conversationId?: string
  /** The owning surface's own event/receipt id (the authoritative source —
   *  needs-you is never prose-inferred). */
  sourceEventRef?: string
  /** ONE explicit question / decision request. */
  question: string
  /** Allowed answer shape where known ('free-text', 'choice:a|b', …). */
  answerShape?: string
  /** Addressed principal(s); empty = the session's operator. */
  principals: string[]
  /** The current human owner (redirect moves it). */
  owner: string
  status: ObligationStatus
  /** Monotonic per-store mint ordinal — the oldest-unread-first basis. */
  createdOrdinal: number
  /** Bumps on EVERY mutation — the notification dedup key. */
  revision: number
  createdAtMs: number
  updatedAtMs: number
  settledAtMs?: number
  settlement?: {
    kind: ObligationSettlementKind
    by?: string
    /** The answer event/receipt identity (crew dispatch vocabulary). */
    answerRef?: string
    /** The resumption receipt (the dispatch that resumed the session). */
    resumptionRef?: string
    supersededBy?: string
  }
  /** Bounded (8) — every settlement attempt incl. race losers. */
  settlementAttempts: ObligationSettlementAttemptV1[]
  /** destination ('in-app', 'host', …) → emission/ack state. */
  notifications: Record<string, ObligationNotificationStateV1>
  urgency?: 'normal' | 'high'
  expiresAtMs?: number
}

interface ObligationFileV1 {
  /** obligationId → row (per-obligation storage — the ring can never evict). */
  obligations: Record<string, ObligationV1>
  /** The mint ordinal counter (never rewinds). */
  lastOrdinal: number
}

const MAX_SETTLED_RETAINED = 200
const MAX_SETTLEMENT_ATTEMPTS = 8

function projectKey(): string {
  return createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
}

/** The switchboard's rows live
 *  in ONE cwd-independent file — the ambient name hashes getCwd(), so the
 *  daemon (its own boot cwd) and a re-grounded UI (GroundPicker chdirs live)
 *  silently read DIFFERENT files and the board lost rows the daemon minted.
 *  crewStoreRoot() is home-anchored, so the scoped path never moves. */
export type ObligationStoreScope = 'switchboard'

const obligationStore = defineStore<ObligationFileV1, [dir?: string, scope?: ObligationStoreScope]>({
  name: 'crew-obligations',
  path: (dir?: string, scope?: ObligationStoreScope) =>
    join(crewStoreRoot(dir), scope === 'switchboard' ? 'obligations-switchboard.json' : `obligations-${projectKey()}.json`),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<ObligationFileV1>
    const out: ObligationFileV1 = { obligations: {}, lastOrdinal: 0 }
    if (r.obligations && typeof r.obligations === 'object' && !Array.isArray(r.obligations)) {
      for (const [id, o] of Object.entries(r.obligations)) {
        if (o && typeof o === 'object' && typeof (o as ObligationV1).ref === 'string') {
          out.obligations[id] = o as ObligationV1
        }
      }
    }
    if (typeof r.lastOrdinal === 'number' && Number.isFinite(r.lastOrdinal)) {
      out.lastOrdinal = r.lastOrdinal
    }
    return out
  },
  empty: () => ({ obligations: {}, lastOrdinal: 0 }),
  onReadFailure: 'empty',
})

export interface UpsertObligationArgs {
  ref: string
  sessionId: string
  question: string
  owner: string
  principals?: string[]
  conversationId?: string
  sourceEventRef?: string
  answerShape?: string
  urgency?: 'normal' | 'high'
  expiresAtMs?: number
  dir?: string
  scope?: ObligationStoreScope
}

/** Retention: settled rows beyond the cap drop oldest-settled-first; OPEN
 *  rows are never dropped (an unresolved question outlives any noise). */
function retainBounded(obligations: Record<string, ObligationV1>): Record<string, ObligationV1> {
  const settled = Object.values(obligations).filter(o => o.status !== 'open')
  if (settled.length <= MAX_SETTLED_RETAINED) return obligations
  const drop = new Set(
    settled
      .sort((a, b) => (a.settledAtMs ?? 0) - (b.settledAtMs ?? 0))
      .slice(0, settled.length - MAX_SETTLED_RETAINED)
      .map(o => o.obligationId),
  )
  return Object.fromEntries(Object.entries(obligations).filter(([id]) => !drop.has(id)))
}

/**
 * Raise (or idempotently re-raise) one durable obligation. ONE open row per
 * ref: a re-raise answers the SAME obligationId; changed content (question/
 * owner/urgency) updates the row IN PLACE with a revision bump — reconnect,
 * restart, screen change or provider switch can never duplicate it.
 * A ref whose previous row already SETTLED mints a fresh row (a genuinely
 * new question under a reused ref is a new obligation).
 */
export async function upsertObligation(
  args: UpsertObligationArgs,
): Promise<{ obligationId: string; revision: number; reraised: boolean }> {
  const store = obligationStore(args.dir, args.scope)
  return store.update<{ obligationId: string; revision: number; reraised: boolean }>(current => {
    const now = Date.now()
    const existing = Object.values(current.obligations).find(
      o => o.ref === args.ref && o.status === 'open',
    )
    if (existing) {
      const changed =
        existing.question !== args.question ||
        existing.owner !== args.owner ||
        (args.urgency !== undefined && existing.urgency !== args.urgency)
      if (!changed) {
        return {
          next: current,
          result: { obligationId: existing.obligationId, revision: existing.revision, reraised: true },
        }
      }
      const updated: ObligationV1 = {
        ...existing,
        question: args.question,
        owner: args.owner,
        ...(args.urgency !== undefined ? { urgency: args.urgency } : {}),
        revision: existing.revision + 1,
        updatedAtMs: now,
      }
      return {
        next: {
          ...current,
          obligations: { ...current.obligations, [existing.obligationId]: updated },
        },
        result: { obligationId: updated.obligationId, revision: updated.revision, reraised: true },
      }
    }
    const obligationId = `obl-${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const ordinal = current.lastOrdinal + 1
    const row: ObligationV1 = {
      schema: 1,
      obligationId,
      ref: args.ref,
      sessionId: args.sessionId,
      ...(args.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
      ...(args.sourceEventRef !== undefined ? { sourceEventRef: args.sourceEventRef } : {}),
      question: args.question,
      ...(args.answerShape !== undefined ? { answerShape: args.answerShape } : {}),
      principals: args.principals ?? [],
      owner: args.owner,
      status: 'open',
      createdOrdinal: ordinal,
      revision: 1,
      createdAtMs: now,
      updatedAtMs: now,
      settlementAttempts: [],
      notifications: {},
      ...(args.urgency !== undefined ? { urgency: args.urgency } : {}),
      ...(args.expiresAtMs !== undefined ? { expiresAtMs: args.expiresAtMs } : {}),
    }
    return {
      next: {
        ...current,
        lastOrdinal: ordinal,
        obligations: retainBounded({ ...current.obligations, [obligationId]: row }),
      },
      result: { obligationId, revision: 1, reraised: false },
    }
  })
}

export interface OpenObligationsScope {
  sessionId?: string
  owner?: string
  /** Addressed-principal filter: matches rows naming the principal OR rows
   *  addressed to nobody in particular (the session operator's default). */
  principal?: string
  dir?: string
  scope?: ObligationStoreScope
}

/** OPEN rows, oldest createdOrdinal first (the oldest-unread law). */
export async function openObligations(scope?: OpenObligationsScope): Promise<ObligationV1[]> {
  const file = await obligationStore(scope?.dir, scope?.scope).read()
  return Object.values(file.obligations)
    .filter(o => o.status === 'open')
    .filter(o => (scope?.sessionId !== undefined ? o.sessionId === scope.sessionId : true))
    .filter(o => (scope?.owner !== undefined ? o.owner === scope.owner : true))
    .filter(o =>
      scope?.principal !== undefined
        ? o.principals.length === 0 || o.principals.includes(scope.principal)
        : true,
    )
    .sort((a, b) => a.createdOrdinal - b.createdOrdinal)
}

export async function obligationOf(
  obligationId: string,
  opts?: { dir?: string; scope?: ObligationStoreScope },
): Promise<ObligationV1 | null> {
  const file = await obligationStore(opts?.dir, opts?.scope).read()
  return file.obligations[obligationId] ?? null
}

export interface ResolveObligationOutcome {
  kind: ObligationSettlementKind
  by?: string
  answerRef?: string
  resumptionRef?: string
  supersededBy?: string
  dir?: string
  scope?: ObligationStoreScope
}

/**
 * Settle exactly once. The first mutation wins the open→terminal transition;
 * every later attempt answers {settled:false} with the standing status AND
 * is preserved on the row's bounded attempt ledger (the answer-vs-withdrawal
 * race law: deterministic winner, both events visible). Unknown targets are
 * rejected without touching anything (stale-target law — never starts work).
 */
export async function resolveObligation(
  obligationId: string,
  outcome: ResolveObligationOutcome,
): Promise<{ settled: boolean; status: ObligationStatus | 'unknown' }> {
  const store = obligationStore(outcome.dir, outcome.scope)
  return store.update<{ settled: boolean; status: ObligationStatus | 'unknown' }>(current => {
    const row = current.obligations[obligationId]
    if (!row) return { next: current, result: { settled: false, status: 'unknown' } }
    const now = Date.now()
    const attempt: ObligationSettlementAttemptV1 = {
      kind: outcome.kind,
      ...(outcome.by !== undefined ? { by: outcome.by } : {}),
      atMs: now,
      applied: row.status === 'open',
    }
    const attempts = [...row.settlementAttempts, attempt].slice(-MAX_SETTLEMENT_ATTEMPTS)
    if (row.status !== 'open') {
      // Already settled — preserve the losing attempt, change nothing else.
      const updated: ObligationV1 = { ...row, settlementAttempts: attempts }
      return {
        next: { ...current, obligations: { ...current.obligations, [obligationId]: updated } },
        result: { settled: false, status: row.status },
      }
    }
    const updated: ObligationV1 = {
      ...row,
      status: outcome.kind,
      settledAtMs: now,
      updatedAtMs: now,
      revision: row.revision + 1,
      settlement: {
        kind: outcome.kind,
        ...(outcome.by !== undefined ? { by: outcome.by } : {}),
        ...(outcome.answerRef !== undefined ? { answerRef: outcome.answerRef } : {}),
        ...(outcome.resumptionRef !== undefined ? { resumptionRef: outcome.resumptionRef } : {}),
        ...(outcome.supersededBy !== undefined ? { supersededBy: outcome.supersededBy } : {}),
      },
      settlementAttempts: attempts,
    }
    return {
      next: {
        ...current,
        obligations: retainBounded({ ...current.obligations, [obligationId]: updated }),
      },
      result: { settled: true, status: outcome.kind },
    }
  })
}

/**
 * Settle the OPEN obligation carrying `ref` (the resolveEventByRef twin —
 * recovery paths own the ref, not the obligationId). Answers unknown when
 * no open row carries the ref; the find and the settle are ONE mutation.
 */
export async function resolveObligationByRef(
  ref: string,
  outcome: ResolveObligationOutcome,
): Promise<{ settled: boolean; status: ObligationStatus | 'unknown' }> {
  const store = obligationStore(outcome.dir, outcome.scope)
  const open = await store.read().then(f =>
    Object.values(f.obligations).find(o => o.ref === ref && o.status === 'open'),
  )
  if (!open) return { settled: false, status: 'unknown' }
  return resolveObligation(open.obligationId, outcome)
}

/**
 * Redirect the obligation to another eligible human — an in-place
 * owner move with a revision bump; the row, its identity and its question
 * are untouched. Settled/unknown targets reject with a receipt.
 */
export async function redirectObligation(
  obligationId: string,
  toOwner: string,
  opts?: { by?: string; dir?: string; scope?: ObligationStoreScope },
): Promise<{ redirected: boolean; status: ObligationStatus | 'unknown' }> {
  const store = obligationStore(opts?.dir, opts?.scope)
  return store.update<{ redirected: boolean; status: ObligationStatus | 'unknown' }>(current => {
    const row = current.obligations[obligationId]
    if (!row) return { next: current, result: { redirected: false, status: 'unknown' } }
    if (row.status !== 'open') return { next: current, result: { redirected: false, status: row.status } }
    const updated: ObligationV1 = {
      ...row,
      owner: toOwner,
      revision: row.revision + 1,
      updatedAtMs: Date.now(),
    }
    return {
      next: { ...current, obligations: { ...current.obligations, [obligationId]: updated } },
      result: { redirected: true, status: 'open' },
    }
  })
}

/** Record a notification EMISSION for one destination at one revision —
 * the policy layer writes through the owner (obligation state lives
 *  per-obligation; emission ≠ delivery, never 'delivered'). */
export async function noteObligationEmission(
  obligationId: string,
  destination: string,
  revision: number,
  opts?: { dir?: string; scope?: ObligationStoreScope },
): Promise<boolean> {
  const store = obligationStore(opts?.dir, opts?.scope)
  return store.update<boolean>(current => {
    const row = current.obligations[obligationId]
    if (!row) return { next: current, result: false }
    const prev = row.notifications[destination]
    if (prev && prev.emittedRevision >= revision) return { next: current, result: false }
    const updated: ObligationV1 = {
      ...row,
      notifications: {
        ...row.notifications,
        [destination]: {
          emittedRevision: revision,
          emittedAtMs: Date.now(),
          ...(prev?.acknowledgedRevision !== undefined
            ? { acknowledgedRevision: prev.acknowledgedRevision, acknowledgedAtMs: prev.acknowledgedAtMs! }
            : {}),
        },
      },
    }
    return {
      next: { ...current, obligations: { ...current.obligations, [obligationId]: updated } },
      result: true,
    }
  })
}

/** Record the operator's ACKNOWLEDGEMENT at a destination (reconnect replay
 *  never re-emits an acknowledged revision — the basis). */
export async function acknowledgeObligation(
  obligationId: string,
  destination: string,
  revision: number,
  opts?: { dir?: string; scope?: ObligationStoreScope },
): Promise<boolean> {
  const store = obligationStore(opts?.dir, opts?.scope)
  return store.update<boolean>(current => {
    const row = current.obligations[obligationId]
    if (!row) return { next: current, result: false }
    const prev = row.notifications[destination] ?? { emittedRevision: 0, emittedAtMs: 0 }
    if (prev.acknowledgedRevision !== undefined && prev.acknowledgedRevision >= revision) {
      return { next: current, result: false }
    }
    const updated: ObligationV1 = {
      ...row,
      notifications: {
        ...row.notifications,
        [destination]: { ...prev, acknowledgedRevision: revision, acknowledgedAtMs: Date.now() },
      },
    }
    return {
      next: { ...current, obligations: { ...current.obligations, [obligationId]: updated } },
      result: true,
    }
  })
}

/** Every row (settled included, bounded by retention) — diagnostics/boards. */
export async function listObligations(opts?: { dir?: string; scope?: ObligationStoreScope }): Promise<ObligationV1[]> {
  const file = await obligationStore(opts?.dir, opts?.scope).read()
  return Object.values(file.obligations).sort((a, b) => a.createdOrdinal - b.createdOrdinal)
}

/** Subscription seam (the gatherer bridge + boards). */
export function subscribeObligations(cb: () => void, opts?: { dir?: string; scope?: ObligationStoreScope }): () => void {
  return obligationStore(opts?.dir, opts?.scope).subscribe(() => cb(), { immediate: false })
}

/** The one-time legacy fold: OPEN rows minted under THIS process's
 *  ambient cwd-hash file move into the switchboard scope (upsert by ref —
 *  the dedupe law holds), and the source row settles 'superseded' so no
 *  surface double-paints. Best-effort, once per process: the operator was
 *  mid-drive when the scope landed; live questions must survive it. */
let legacyFoldDone = false
export async function foldLegacyObligationsIntoSwitchboardScope(dir?: string): Promise<number> {
  if (legacyFoldDone) return 0
  legacyFoldDone = true
  try {
    const ambient = await obligationStore(dir).read()
    const open = Object.values(ambient.obligations).filter(o => o.status === 'open')
    let moved = 0
    for (const row of open) {
      await upsertObligation({
        ref: row.ref,
        sessionId: row.sessionId,
        question: row.question,
        owner: row.owner,
        ...(row.principals.length > 0 ? { principals: row.principals } : {}),
        ...(row.urgency !== undefined ? { urgency: row.urgency } : {}),
        ...(row.expiresAtMs !== undefined ? { expiresAtMs: row.expiresAtMs } : {}),
        ...(dir !== undefined ? { dir } : {}),
        scope: 'switchboard',
      })
      await resolveObligation(row.obligationId, {
        kind: 'superseded',
        by: 'switchboard-scope-fold',
        ...(dir !== undefined ? { dir } : {}),
      })
      moved += 1
    }
    return moved
  } catch {
    return 0
  }
}
