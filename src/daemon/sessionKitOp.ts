// ============================================================================
//  daemon/sessionKitOp — THE KIT'S ONE WRITER: the sessionControl action
//  'set-kit' (ledger L24(3): /mcp + /skills inside a session are THAT
//  session's private dials, both directions — off AND load-on; the menu
//  never hears about it; siblings never feel it).
//
//  Record-edit here; the live effect rides the seat:
//  sessionSeat.setSessionKitDial forwards the post-edit kit whole to the
//  child's kit_edit verb — latch flip, catalogue MCP reconcile, command
//  table re-derive — or parks the edit for the turn's end. This door writes
//  the durable fact every later reader (a respawn, a resume's receipt, the
//  facts projection) reads, and receipts the dial on the session's own
//  sidecar (kind 'kit-dial' — the ruling-6 widening precedent).
//
//  MATERIALIZE-THEN-EDIT: a session born before the kit existed carries NO
//  kit (whole-config behaviour). Its first dial must be an EDIT, never a
//  refusal — so the writer first materializes the kit from the record's
//  whole-config reality (an UNRESOLVED kit whose deltas carry the
//  workspace's STANDING MCP off-record — exactly what the session's
//  process was enforcing; D3's defect fix: empty deltas would WIDEN the
//  session on its first dial) and then applies the dial to it. Never a
//  silent whole-config arm either: the applied receipt names the
//  materialization.
//
//  TWO ARMS, ONE GRAMMAR: a RESOLVED kit (the screen composed it — its lists
//  are the membership) edits its closed lists; an UNRESOLVED kit (the daemon
//  derived it — the runner completes) edits its deltas. Identity when
//  nothing changes ⇒ 'noop'. Exactly-once under a retried dial rides the
//  daemon's applied-ops ledger (the clientOpId settle in daemon/main.ts).
//
//  Mirrors sessionContract.ts (its own module beside the record, reached
//  over the wire as one action of the existing sessionControl op — never a
//  new op verb). The record's `.kit` is assigned ONLY inside sessionKit.ts
//  (setSessionKit) — the one-writer census prove-session-kit pins.
// ============================================================================
import { mkdirSync } from 'node:fs'
import { logForDebugging } from '../utils/debug.js'
import { getProjectDir } from '../utils/sessionStorage/paths.js'
import { appendSessionReceipt } from '../services/switchboard/sessionReceipts.js'
import { updateConcourseWorkers } from './concourseSupervisor.js'
import {
  applyKitEdit,
  cloneSessionKit,
  materializedKitForWorkspace,
  setSessionKit,
  type SessionKitEditV1,
} from './sessionKit.js'

export type KitOpOutcome = { outcome: 'applied' | 'noop' | 'refused'; detail?: string }

function describeEdit(edit: SessionKitEditV1): string {
  const words: string[] = []
  for (const dial of edit.mcp ?? []) words.push(`mcp ${dial.name} ${dial.on ? 'on' : 'off'}`)
  for (const dial of edit.skills ?? []) words.push(`skill ${dial.name} ${dial.state}`)
  for (const dial of edit.extensions ?? []) words.push(`extension ${dial.name} ${dial.on ? 'on' : 'off'}`)
  return words.join(' · ')
}

/**
 * THE ONE VERB, adjudicated at the record's one writer.
 *   unknown session      ⇒ refused (typed)
 *   pre-kit record       ⇒ materialize from whole-config reality, then edit
 *                           (applied, the receipt names the materialization)
 *   nothing changes      ⇒ noop (the record is untouched)
 *   otherwise            ⇒ applied, the receipt names every dial
 */
export function applyConcourseKitOp(sessionId: string, edit: SessionKitEditV1, by: string, dir?: string): KitOpOutcome {
  let out: KitOpOutcome = {
    outcome: 'refused',
    detail: 'unknown-session: no live worker record owns this session',
  }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    const materialized = rec.kit === undefined
    const standing = rec.kit ?? materializedKitForWorkspace(rec.workspaceId)
    const next = applyKitEdit(standing, edit)
    if (next === standing && !materialized) {
      out = { outcome: 'noop', detail: `the kit already reads so (${describeEdit(edit)})` }
      return
    }
    setSessionKit(rec, next === standing ? cloneSessionKit(standing) : next)
    out = {
      outcome: 'applied',
      detail: `${describeEdit(edit)}${materialized ? " — the kit was materialized from this session's whole-config reality first (a pre-kit record); the dial edits it" : ''}`,
    }
    // THE DIAL'S RECEIPT ROW (the ruling-6 widening precedent
    // beside kit-restamp/kit-refused): the session's own sidecar records
    // the dial durably. Fail-soft — the receipt is the honesty valve, the
    // record write above is the law.
    try {
      const home = getProjectDir(rec.workspaceId)
      mkdirSync(home, { recursive: true })
      appendSessionReceipt(home, rec.sessionId, {
        at: new Date().toISOString(),
        by,
        kind: 'kit-dial',
        summary: `kit dial: ${out.detail}`,
        details: { by, dials: describeEdit(edit), ...(materialized ? { materialized: true } : {}) },
      })
    } catch (err) {
      logForDebugging(`[kit] dial receipt failed for ${rec.sessionId}: ${err}`)
    }
  }, dir)
  return out
}
