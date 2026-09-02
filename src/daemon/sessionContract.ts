// ============================================================================
//  daemon/sessionContract — THE ADVISORY CONTRACT RECORD and its one verb
//  (the coordinator-tooling contracts T1–T6).
//
//  A contract is the soft "for what" of a session — the work agreement the
//  operator or the coordinator writes and the worker acknowledges by
//  restating. ADVISORY ALWAYS (T2, operator-ruled: "give the agent some
//  [latitude]… not enforce it"): nothing anywhere gates on contract state —
//  no tool, no dispatch, no admission ever consults it to refuse. The hard
//  walls stay where they already are (lease/slot/tools enforce themselves).
//
//  The record rides the durable session record ADDITIVELY (the pendingEffort
//  precedent: old readers unaffected) and is NEVER deleted — it amends or
//  closes, and even a re-draft over a closed contract pushes the closed text
//  into amendments[] first (the retention law). One writer: the daemon —
//  every mutation comes through applyConcourseContractOp below, reached over
//  the wire as the sessionControl action 'contract' (op set|ack|amend|close).
//
//  Lifecycle (T2 confirmed): drafted → acknowledged by worker → active →
//  amended (re-ACK) → closed. The one invention the five-status cycle needed
//  (strike-able at the operator's look): acknowledged → active promotes at
//  the daemon's EXISTING delivery seam — a delivery landing on an
//  acknowledged contract means the session kept working under it (the
//  inline promotion in markConcourseWorkerDelivery, concourseSupervisor.ts).
//  Bookkeeping only; the promotion gates nothing.
// ============================================================================

import { updateConcourseWorkers } from './concourseSupervisor.js'

/** One superseded text — amend (and a re-draft over closed) pushes the
 *  outgoing words here, oldest first. Never pruned: the amendments array IS
 *  the record's own retention. */
export interface SessionContractAmendmentV1 {
  text: string
  at: number
  by: string
}

/** The advisory contract riding the session record (additive — absent on
 *  every pre-contract record; old readers unaffected). */
export interface SessionContractV1 {
  /** The CURRENT agreement text (drafts included). */
  text: string
  /** drafted → acknowledged by worker → active → amended (re-ACK) → closed. */
  status: 'draft' | 'acknowledged' | 'active' | 'amended' | 'closed'
  /** The worker's latest acknowledgment moment (a re-ack refreshes it). */
  ackAt?: number
  /** The latest amendment moment. */
  amendedAt?: number
  /** Superseded texts, oldest first — never deleted. */
  amendments: SessionContractAmendmentV1[]
}

export type ContractOp = 'set' | 'ack' | 'amend' | 'close'

/** The wire's contract payload (sessionControl action 'contract'). */
export interface ContractOpRequestV1 {
  op: ContractOp
  /** set/amend: the agreement text. */
  text?: string
}

export type ContractOpOutcome = { outcome: 'applied' | 'noop' | 'refused'; detail?: string }

/** Bounds: a contract is prose, not a payload — one text tops out well under
 *  the 1 MiB control frame; amendment COUNT is unbounded by law (never-
 *  delete), each entry bounded by the same text cap. */
export const CONTRACT_TEXT_CAP = 20_000

/** A contract standing IN FORCE (the worker acknowledged it and it has not
 *  closed). Readers asking "does this session work under an agreement right
 *  now" use this — never to gate anything (the advisory law). */
export function contractInForce(c: SessionContractV1 | undefined): boolean {
  return c !== undefined && (c.status === 'acknowledged' || c.status === 'active')
}

/**
 * THE ONE VERB's four ops, adjudicated at the record's one writer.
 *   set    — author the draft: none/closed ⇒ a fresh 'draft' (a closed text
 *            moves into amendments first — never deleted); a standing draft
 *            revises in place; an in-force/amended contract refuses with the
 *            pointer to amend (history must be kept, set would drop it).
 *   ack    — the WORKER's signature (its restatement lives in its own
 *            transcript, where it was spoken): draft/amended ⇒ 'acknowledged'
 *            with ackAt stamped; already in force ⇒ noop.
 *   amend  — change under acknowledgment: the outgoing text is pushed into
 *            amendments, status 'amended', re-ack owed. A draft refuses (set
 *            revises a draft); closed refuses (a new contract sets afresh).
 *   close  — end the agreement: any standing status ⇒ 'closed', text and
 *            amendments kept whole. Already closed ⇒ noop.
 */
export function applyConcourseContractOp(
  sessionId: string,
  req: ContractOpRequestV1,
  by: string,
  dir?: string,
): ContractOpOutcome {
  const text = (req.text ?? '').replace(/\r\n/g, '\n').trim().slice(0, CONTRACT_TEXT_CAP)
  let out: ContractOpOutcome = {
    outcome: 'refused',
    detail: 'unknown-session: no live worker record owns this session',
  }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    const standing = rec.contract
    switch (req.op) {
      case 'set': {
        if (text.length === 0) {
          out = { outcome: 'refused', detail: 'a contract needs words' }
          return
        }
        if (standing === undefined || standing.status === 'closed') {
          rec.contract = {
            text,
            status: 'draft',
            amendments:
              standing === undefined
                ? []
                : // Never-delete: the closed agreement survives inside the
                  // fresh one's history.
                  [...standing.amendments, { text: standing.text, at: Date.now(), by }],
          }
          out = { outcome: 'applied', detail: standing === undefined ? 'contract drafted' : 'contract drafted anew — the closed text is kept in its history' }
          return
        }
        if (standing.status === 'draft') {
          standing.text = text
          out = { outcome: 'applied', detail: 'draft revised' }
          return
        }
        out = { outcome: 'refused', detail: `the contract is ${standing.status} — amend it (history is kept); set only authors drafts` }
        return
      }
      case 'ack': {
        if (standing === undefined) {
          out = { outcome: 'refused', detail: 'no contract to acknowledge' }
          return
        }
        if (standing.status === 'acknowledged' || standing.status === 'active') {
          out = { outcome: 'noop', detail: 'already acknowledged' }
          return
        }
        if (standing.status === 'closed') {
          out = { outcome: 'refused', detail: 'the contract is closed' }
          return
        }
        standing.status = 'acknowledged'
        standing.ackAt = Date.now()
        out = { outcome: 'applied', detail: 'acknowledged — the agreement is in force' }
        return
      }
      case 'amend': {
        if (standing === undefined) {
          out = { outcome: 'refused', detail: 'no contract to amend — set drafts one' }
          return
        }
        if (text.length === 0) {
          out = { outcome: 'refused', detail: 'an amendment needs words' }
          return
        }
        if (standing.status === 'draft') {
          out = { outcome: 'refused', detail: 'a draft is not in force — set revises it' }
          return
        }
        if (standing.status === 'closed') {
          out = { outcome: 'refused', detail: 'the contract is closed — a new contract sets afresh' }
          return
        }
        standing.amendments.push({ text: standing.text, at: Date.now(), by })
        standing.text = text
        standing.status = 'amended'
        standing.amendedAt = Date.now()
        out = { outcome: 'applied', detail: 'amended — the worker re-acknowledges through its contract tool' }
        return
      }
      case 'close': {
        if (standing === undefined) {
          out = { outcome: 'refused', detail: 'no contract to close' }
          return
        }
        if (standing.status === 'closed') {
          out = { outcome: 'noop', detail: 'already closed' }
          return
        }
        standing.status = 'closed'
        out = { outcome: 'applied', detail: 'contract closed — text and history kept' }
        return
      }
    }
  }, dir)
  return out
}
