// ============================================================================
// services/concourse/coordinatorLane — the
//  Agent-assisted coordinator's ONE governed model lane.
//
//  · Event-triggered or operator-invoked ONLY: no resident loop, no
//    timer. Equivalent triggers dedupe on a bounded fingerprint set BEFORE
//    any permit is taken.
//  · The turn holds ONE visible 'coordinator' permit under the governor for
//    exactly the call (the single global lane; released in finally).
// Input is the BOUNDED board: the coordinatorBoard projection —
//    ids/titles/states with their plain meaning, brief heads, activity
//    tails, model/effort, fork facts, obligations, counts — never a raw
//    transcript; the versioned behavior contract rides every call (digest
//    in the receipt).
//  · Output is VALIDATED against the kernel's closed vocabulary: only
//    kernel-permitted decisions execute, through the SAME
//    executeKernelDecision path the operator's own controls use (the
//    parity); anything else is refused with a receipt (no
//    self-authority — the model proposes, code disposes).
//  · law (through the real owner's fingerprint machinery):
//    a proposal batch equivalent to a previously FAILED batch is refused
//    ('no equivalent-failure repetition'); bounded batch size enforces 'at
//    most one bounded proposal/action batch per triggering event'.
//  · The provider call itself is an INJECTED seam (deps.callModel): the
//    live wiring binds it to the streamModel machinery under the validated
//    registry choice; proofs inject a recorder. NO model id is copied here
//    (the composed registry owns availability).
// ============================================================================

import { actionFingerprint } from '../run/progressModel.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  executeKernelDecision,
  kernelObjectRefOf,
  resolveCoordinatorMode,
  runCoordinatorKernel,
  type CoordinatorModeResolution,
  type KernelDecisionV1,
  type KernelDeps,
  type KernelEventV1,
  type KernelReceiptV1,
} from './coordinatorKernel.js'
import { COORDINATOR_PERSONA, COORDINATOR_PERSONA_VERSION } from './coordinatorPersona.js'
import { coordinatorOverflowOf, coordinatorOverflowRefusal } from './coordinatorOverflow.js'
import { overflowRecoveryEnabled } from '../compact/overflowRecovery.js'
import { isAutoCompactEnabled } from '../compact/autoCompact.js'
import type { CoordinatorBoardV1 } from './coordinatorBoard.js'
import type { CoordinatorTurnRuntime } from './coordinatorTools.js'
import { decodeManagerAsk, decodeManagerPlan, type ManagerAskV1, type ManagerPlanV1 } from './managerMode.js'

// ── the versioned behavior contract (concise, testable) ──────────────

// v2: signal.emit LEFT the model vocabulary — host-signal
// emission has exactly ONE live owner (the hook with a real sender);
// a model-proposed emission reached the kernel's no-sender stub, whose
// 'applied' claim burned the revision and ATE the real toast. The kernel
// keeps the verb for its own rules; the model can never propose it.
// v3: the session verbs JOIN — pause/resume drive the
// delivery valve, redirect delivers an instruction to an existing live
// session; all three execute at the owners with typed refusals.
// v4 → v5 (sheet): the 15-line JSON-proposal contract is
// named and replaced — the contract IS the coordinator persona
// (coordinatorPersona.ts, the one home), because the live turn now holds
// real tools: verbs execute mid-turn through the same daemon doors, so the
// "propose, code disposes" JSON answer shape retired with the one-shot.
// The validator below survives for the injected-proposal seam (proofs and
// programmatic callers); the live vocabulary is the closed tool set.
/** Drive-12 (the clipped-refusal law): receipt labels lead with OUTCOME +
 *  REASON and carry an 8-char ref — the pane truncates the tail, so a
 *  36-char uuid before the reason pushed every reason off-screen ("(this …")
 *  and the coordinator's own reading of its receipts lost the why. */
function receiptLabel(r: { verb: string; objectRef: string; outcome: string; detail?: string }): string {
  const ref = r.objectRef.length > 12 ? `${r.objectRef.slice(0, 8)}…` : r.objectRef
  const why = r.detail !== undefined && r.detail.length > 0 ? ` — ${r.detail}` : ''
  return `${r.verb} ${r.outcome}${why} · ${ref}`.slice(0, 240)
}

export const COORDINATOR_CONTRACT_VERSION = COORDINATOR_PERSONA_VERSION
export const COORDINATOR_CONTRACT = COORDINATOR_PERSONA

export function coordinatorContractDigest(): string {
  // A stable structural digest (length + version) — enough to bind receipts
  // to the contract revision without hashing machinery here.
  return `cc${COORDINATOR_CONTRACT_VERSION}-${COORDINATOR_CONTRACT.length}`
}

// ── lane readiness (the mode lift, in reverse) ───────────────────────

export interface EffectiveCoordinator {
  resolution: CoordinatorModeResolution
  /** Present exactly when the lane may take a turn: the validated model. */
  assistModelId?: string
  /** Display projection of the validated choice (the registry displayName —
   *  the ONE label consumers paint; the raw model id never reaches a
   *  surface). */
  assistModelLabel?: string
  /** The validated row's truthful label, typed and spelled
   *  (coordinatorModelStatusLabel) — present exactly when the row is not
   *  'ready'. The lane still lifts: the wire decides the turn, and every
   *  surface paints this beside the model so the operator knows what the
   *  next turn needs. */
  assistModelAvailability?: import('./coordinatorModels.js').CoordinatorModelAvailability
  assistModelStatus?: string
}

/** The ONE effective-mode composition: config mode × the composed-registry
 *  validation. agent-assisted holds with any model the registry LISTS —
 *  the row's truthful label rides along (a credential or qualification gap
 *  is the wire's to refuse, stated plainly in the turn's own reply); only
 *  an absent or unlisted choice downgrades to rules-only naming the exact
 *  blocker (typed, visible; never a silent account/model substitution). */
export async function resolveEffectiveCoordinator(): Promise<EffectiveCoordinator> {
  const { getGlobalConfig } = await import('../../utils/config.js')
  const cfg = getGlobalConfig().concourseCoordinator
  const base = resolveCoordinatorMode(cfg?.mode)
  if (base.requested !== 'agent-assisted') return { resolution: base }
  const { validateCoordinatorModelChoice, coordinatorModelStatusLabel } = await import('./coordinatorModels.js')
  const validated = await validateCoordinatorModelChoice(cfg?.assistModel)
  if (!validated.ok) {
    return {
      resolution: {
        requested: 'agent-assisted',
        effective: 'rules-only',
        fallbackReason:
          validated.reason === 'no-choice'
            ? 'agent-assisted needs a coordinator model — pick one from the composed registry'
            : `the chosen coordinator model (${cfg?.assistModel ?? ''}) is not in the registry — pick one from the composed registry`,
      },
    }
  }
  // ROUTE HONESTY: every route the registry lists is BOUND — anthropic
  // rides the streaming core; gpt/glm ride routedCallModel's native
  // runtimes, which own their own refusals and state them in the reply.
  const status = coordinatorModelStatusLabel(validated.entry)
  return {
    resolution: { requested: 'agent-assisted', effective: 'agent-assisted' },
    assistModelId: validated.entry.modelId,
    assistModelLabel: validated.entry.displayName,
    ...(status.length > 0 ? { assistModelAvailability: validated.entry.availability, assistModelStatus: status } : {}),
  }
}

// ── bounded turn input (snapshot + delta, never transcripts) ─────────

/** The board the model reads is the coordinatorBoard projection: every row
 *  the operator's screen paints, with its state spelled in plain words,
 *  brief, latest activity, model/effort, folder, stamp branch + worktree +
 *  commit state, and each open question's answerable ref (operator finding
 * without the ref the model could not name the git offer it was
 *  told to say yes to). Proofs inject the three required arrays; the
 *  optional facts ride only when the owners know them. */
export type CoordinatorTurnBoard = CoordinatorBoardV1

export interface CoordinatorTurnInput {
  contractVersion: number
  contract: string
  event: KernelEventV1
  board: CoordinatorTurnBoard
  /** The G wave: the bounded conversation TAIL (newest last) — present only
   *  on operator-message turns; never transcripts, never unbounded. A
   *  coordinator entry carries the receipts it executed, so the next turn
   *  knows what it did and what was refused instead of re-deriving it. The
   *  ONE shaper (coordinatorReplay) owns the row: whose voice it is, how old
   *  it is, and whether the harness already settled it. */
  conversation?: ReadonlyArray<import('./coordinatorReplay.js').CoordinatorReplayRowV1>
  /** MANAGER MODE (ledger T7+T8): this turn runs under the coordinator
   *  composer's manager mode — the call binds the manager addendum and the
   *  two card tools beside the persona's own set. */
  manager?: true
}

/** The ONE receipt → conversation-row label. Reads as a sentence: a human
 *  verb, the session's TITLE (the raw id only when no title is known — a
 *  36-char uuid would otherwise lead the row and pushed the refusal reason off the
 *  pane: the operator saw "session.redirect 3f2a… — refused (this …"), the
 *  outcome, then the full detail. Both the streamed partial rows and the
 *  final entry speak through this. */
const RECEIPT_VERB_WORDS: Record<string, string> = {
  'session.launch': 'launch',
  'session.redirect': 'message to',
  'session.pause': 'pause',
  'session.resume': 'resume',
  'session.stop': 'stop',
  'workflows.grant': 'workflows allowed for',
  'workflows.revoke': 'workflows revoked for',
  'permission.answer': 'permission answer',
  'attention.raise': 'raised a question',
  'attention.supersede': 'closed a question',
  'obligation.answer': 'answered',
  'signal.emit': 'signalled',
}

/** COMPACT REFUSAL LAW (ruled): a refused/failed row is ONE pane line —
 *  what · why · the one fix; the full daemon sentence goes to the debug log
 *  (the door logs it beside the append). The squeeze: minted op-ids never
 *  lead the row, typed-class parentheticals and `(got …)` micrometadata
 *  drop, a dispatchable roll-call yields to a `did you mean` fix (capped at
 *  three ids otherwise), and clauses that repeat collapse. */
export function compactRefusalWhy(detail: string | undefined): string {
  if (detail === undefined || detail.trim().length === 0) return 'no reason came back'
  // A daemon error can arrive MULTI-LINE (raw git stderr in the live
  // fork-collision sighting); a receipt row is ONE pane line — fold breaks
  // into clause separators before any other pass.
  detail = detail.replace(/\s*\r?\n+\s*/g, ' · ')
  // Pass 1 — re-fold the roll-call: the ' · ' split scatters a
  // 'dispatchable:'/'pick one of:' list into bare-id clauses behind its
  // header; a header absorbs the bare ids that follow it.
  const bareId = /^[a-z0-9][\w./:-]*$/i
  const folded: Array<{ text: string; roll: boolean }> = []
  for (const raw of detail.split(' · ')) {
    const c = raw.replace(/^next:\s*/, '').trim()
    if (c.length === 0) continue
    const header = /^(?:dispatchable:|pick one of:?)\s*(.*)$/i.exec(c)
    if (header !== null) {
      folded.push({ text: (header[1] ?? '').trim(), roll: true })
      continue
    }
    const last = folded[folded.length - 1]
    if (last !== undefined && last.roll && bareId.test(c)) {
      last.text = last.text === '' ? c : `${last.text} · ${c}`
      continue
    }
    folded.push({ text: c, roll: false })
  }
  // Pass 2 — compose: the one fix outranks the roll-call; the roll-call
  // caps at three ids; typed-class parentheticals and `(got …)` drop;
  // repeated clauses collapse.
  const hasFix = folded.some(f => !f.roll && /did you mean/i.test(f.text))
  const out: string[] = []
  const seen = new Set<string>()
  for (const f of folded) {
    let c: string
    if (f.roll) {
      if (hasFix) continue
      const ids = f.text.split(' · ').filter(s => s !== '')
      if (ids.length === 0) continue
      c = `pick one of: ${ids.slice(0, 3).join(' · ')}${ids.length > 3 ? ` (+${ids.length - 3} more)` : ''}`
    } else {
      c = f.text
        .replace(/\s*\(got [^)]*\)/, '')
        .replace(/^model (?:refused|unavailable) \([a-z0-9:-]+\)\s*(?:—\s*)?/i, '')
        .trim()
    }
    if (c.length === 0) continue
    const key = c.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return (out.length > 0 ? out.join(' · ') : detail).slice(0, 200)
}

export function receiptLabelOf(
  r: { verb: string; objectRef: string; outcome: string; detail?: string },
  titleOf: (objectRef: string) => string | undefined = () => undefined,
): string {
  const verbWord = RECEIPT_VERB_WORDS[r.verb] ?? r.verb
  const title = titleOf(r.objectRef)
  // A minted durable-op id (coord-launch-<uuid> …) is bookkeeping, never a
  // subject — the operator read "launch coord-launch-3f2a…" leading their
  // own refusal rows (the ruled screenshot).
  const opaqueRef = /^coord-[a-z]+-[0-9a-f-]{8,}$/i.test(r.objectRef)
  const subject =
    title !== undefined
      ? `"${title}"`
      : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(r.objectRef)
        ? `session ${r.objectRef.slice(0, 8)}`
        : opaqueRef
          ? null
          : r.objectRef
  if (r.outcome === 'refused' || r.outcome === 'failed') {
    return `${verbWord}${subject !== null ? ` ${subject}` : ''} ${r.outcome} — ${compactRefusalWhy(r.detail)}`.slice(0, 220)
  }
  const detail = r.detail !== undefined && r.detail.length > 0 ? ` — ${r.detail}` : ''
  // A null subject is an OPAQUE minted op-id (held-open launches have no
  // session yet) — bookkeeping never leads a row; the detail carries the
  // launch's own quoted title instead.
  return `${verbWord}${subject !== null ? ` ${subject}` : ''}: ${r.outcome}${detail}`.slice(0, 400)
}

export interface CoordinatorTurnProposal {
  decisions: KernelDecisionV1[]
  /** "asks the smallest missing priority" — surfaced, never executed. */
  smallestQuestion?: string
  /** The G wave: the conversational reply to an operator-message turn —
   *  plain prose, appended to the durable conversation beside the executed
   *  receipts. */
  reply?: string
  /** THE CONTEXT GAUGE (chat-relief): the turn's real context size from the
   *  provider's own usage envelope (the largest round's input + cache reads
   *  + cache writes). Absent when the runtime reported no input usage — the
   *  gauge then honestly does not stamp. */
  turnUsage?: { contextTokens: number }
  /** MANAGER MODE: the question card this turn landed (ask_operator) — the
   *  door writes it onto the reply entry; the pane paints the card. */
  ask?: ManagerAskV1
  /** MANAGER MODE: the plan card this turn landed (propose_plan). */
  plan?: ManagerPlanV1
}

export interface CoordinatorLaneDeps extends KernelDeps {
  /** The provider seam — absent, the LIVE binding (coordinatorCall) loads
   *  lazily; proofs inject a recorder. The optional runtime
   *  threads streaming deltas + per-verb receipts out of the live
   *  agent turn — 2-arg recorders stay assignable and simply ignore it. */
  callModel?: (
    input: CoordinatorTurnInput,
    modelId: string,
    runtime?: CoordinatorTurnRuntime,
  ) => Promise<CoordinatorTurnProposal>
  /** Injected board facts for proofs; production folds the live snapshot. */
  board?: CoordinatorTurnInput['board']
  /** MANAGER MODE: run this operator-message turn under the manager
   *  addendum + card tools (the composer's shift+tab mode threads here). */
  manager?: boolean
  /** MANAGER MODE in the self-managed world (ledger L22): the composed
   *  coordinator model the manager turn runs on while the coordinator
   *  itself is not agent-assisted (managerMode.resolveManagerModel). Read
   *  only beside `manager`; the coordinator's own mode stays untouched. */
  managerModelId?: string
  /** AUTO-COMPACTION's proof seam (chat-relief item 2): the summarizer the
   *  message door's pre-turn fold rides; production omits it and the live
   *  one-shot binding applies. */
  summarizeForCompact?: import('./coordinatorCompact.js').CoordinatorSummarizer
}

export interface AssistedTurnReceipt {
  outcome: 'executed' | 'deduped' | 'refused' | 'not-assisted'
  reason?: string
  contractDigest: string
  modelId?: string
  receipts: KernelReceiptV1[]
  /** Proposals the validator REFUSED (visible, never silently
   *  dropped, never executed). */
  refusedProposals?: number
  /** The attainable-goal law: the model judged the objective
   *  unattainable and asked the smallest honest question instead — carried
   *  on the receipt AND rowed on the feed, never executed. (SANITY FORK #2
   *  P3 note: the PRODUCTION-visible surface is the 'asked' feed row —
   *  this field is the typed return for provers/programmatic callers.) */
  smallestQuestion?: string
  /** The G wave: the conversational reply for an operator-message turn
   *  (already appended to the durable conversation by the message door). */
  reply?: string
  /** The conversation-row labels for `receipts`, in order — titled from the
   *  board the turn read (the door appends these; it has no board of its own). */
  receiptLabels?: Array<{ verb: string; outcome: string; label: string }>
  /** MANAGER MODE: the cards the turn landed — decoded/bounded; the door
   *  writes them onto the reply entry. */
  ask?: ManagerAskV1
  plan?: ManagerPlanV1
}

// ── the visible reply clip ──────────────────────────────────────────────────

/** The reply ceiling — the conversation store's own entry clip (ONE cap:
 *  a lower lane-side cap silently amputated replies at 4000 while the
 *  store held 8000, the silent-downgrade class). */
export const COORDINATOR_REPLY_CAP = 8000
const REPLY_CLIP_MARKER = '\n\n[reply clipped — it ran past the surface cap; the receipt rows are complete]'

/** The ONE clip site for a coordinator reply entering the durable
 *  conversation: under the cap the text rides whole; over it the cut is
 *  VISIBLE — the marker replaces the tail, inside the cap so the store's
 *  decode never re-cuts silently behind it. */
export function clipCoordinatorReply(raw: string): string {
  if (raw.length <= COORDINATOR_REPLY_CAP) return raw
  return raw.slice(0, COORDINATOR_REPLY_CAP - REPLY_CLIP_MARKER.length) + REPLY_CLIP_MARKER
}

// ── trigger dedupe + failure memory (bounded) ────────────────────

const MAX_REMEMBERED = 64
const seenTriggers: string[] = []
const failedBatches: string[] = []

function remember(list: string[], key: string): void {
  list.push(key)
  if (list.length > MAX_REMEMBERED) list.shift()
}

export function triggerKeyOf(event: KernelEventV1): string {
  switch (event.kind) {
    case 'dispatch-refused':
      return actionFingerprint(`refused:${event.clientMessageId}`)
    case 'worker-settled':
      return actionFingerprint(`settled:${event.sessionId}`)
    case 'obligation-open':
      return actionFingerprint(`open:${event.obligationId}`)
    case 'operator-message':
      // Every send is its own trigger (the messageId is minted per send) —
      // dedupe only guards replays of the SAME send, never repeated asks.
      return actionFingerprint(`msg:${event.messageId}`)
  }
}

export function batchKeyOf(decisions: readonly KernelDecisionV1[]): string {
  return actionFingerprint(JSON.stringify(decisions))
}

export function _resetCoordinatorLaneForTesting(): void {
  seenTriggers.length = 0
  failedBatches.length = 0
}

/** The validator: only decisions the KERNEL could have produced for
 *  some event are executable — shape-checked against the closed MODEL
 *  vocabulary (never a generic command escape hatch). signal.emit is
 *  DELIBERATELY absent (contract v2, D1): kernel rules may emit signals,
 *  the model may not propose them. A2: attention.raise fields carry caps
 *  and the owner pins to 'operator' — the kernel itself never raises for
 *  any other owner, and an unvalidated model string must not mint an
 *  arbitrarily-owned or unbounded durable obligation. */
export function validateProposal(d: unknown): d is KernelDecisionV1 {
  if (typeof d !== 'object' || d === null) return false
  const v = (d as { verb?: unknown }).verb
  if (v === 'attention.raise') {
    const r = d as Record<string, unknown>
    return (
      typeof r.ref === 'string' &&
      r.ref.length > 0 &&
      r.ref.length <= 200 &&
      typeof r.sessionId === 'string' &&
      r.sessionId.length > 0 &&
      r.sessionId.length <= 128 &&
      typeof r.question === 'string' &&
      r.question.length > 0 &&
      r.question.length <= 500 &&
      r.owner === 'operator'
    )
  }
  if (v === 'attention.supersede') {
    const r = d as Record<string, unknown>
    return typeof r.obligationId === 'string' && typeof r.reason === 'string' && r.reason.length <= 500
  }
  // The session verbs — bounded fields, same closed posture.
  if (v === 'session.pause') {
    const r = d as Record<string, unknown>
    return (
      typeof r.sessionId === 'string' &&
      r.sessionId.length > 0 &&
      r.sessionId.length <= 128 &&
      typeof r.by === 'string' &&
      r.by.length <= 128 &&
      typeof r.reason === 'string' &&
      r.reason.length <= 500
    )
  }
  if (v === 'session.resume') {
    const r = d as Record<string, unknown>
    return typeof r.sessionId === 'string' && r.sessionId.length > 0 && r.sessionId.length <= 128 && typeof r.by === 'string' && r.by.length <= 128
  }
  if (v === 'session.redirect') {
    const r = d as Record<string, unknown>
    return (
      typeof r.sessionId === 'string' &&
      r.sessionId.length > 0 &&
      r.sessionId.length <= 128 &&
      typeof r.clientMessageId === 'string' &&
      r.clientMessageId.length > 0 &&
      r.clientMessageId.length <= 128 &&
      typeof r.instruction === 'string' &&
      r.instruction.length > 0 &&
      r.instruction.length <= 4000 &&
      typeof r.by === 'string' &&
      r.by.length <= 128
    )
  }
  return false
}

export const MAX_PROPOSALS_PER_TURN = 5

// ── the assisted turn ───────────────────────────────────────────────────────

export async function runAssistedTurn(
  event: KernelEventV1,
  deps: CoordinatorLaneDeps,
): Promise<AssistedTurnReceipt> {
  const contractDigest = coordinatorContractDigest()
  // THE GHOST FIX: EVENT turns never run
  // the model. A stale obligation re-opening at boot ran a full model turn
  // whose persona re-acted on the conversation's last ask — ghost launches
  // the operator never asked for (the in-memory trigger dedupe dies with
  // the process, so every relaunch re-fired it). Events ride the pure
  // kernel; the model converses ONLY on live operator messages.
  if (event.kind !== 'operator-message') {
    const receipts = await runCoordinatorKernel(event, { ...deps, mode: 'rules-only' })
    return { outcome: 'executed', contractDigest, receipts }
  }
  // MANAGER MODE in the self-managed world (L22): the manager's turn runs on
  // the composed coordinator model the caller resolved, whatever the
  // coordinator's own mode says — the mode itself is not lifted.
  const effective: EffectiveCoordinator =
    deps.manager === true && deps.managerModelId !== undefined
      ? { resolution: { requested: 'agent-assisted', effective: 'agent-assisted' }, assistModelId: deps.managerModelId }
      : await resolveEffectiveCoordinator()
  if (effective.resolution.effective !== 'agent-assisted' || effective.assistModelId === undefined) {
    return {
      outcome: 'not-assisted',
      reason: effective.resolution.fallbackReason ?? `mode is ${effective.resolution.effective}`,
      contractDigest,
      receipts: [],
    }
  }
  // Equivalent triggers dedupe BEFORE any permit/model spend.
  const trigger = triggerKeyOf(event)
  if (seenTriggers.includes(trigger)) {
    return { outcome: 'deduped', reason: 'equivalent trigger already coordinated', contractDigest, receipts: [] }
  }
  remember(seenTriggers, trigger)

  try {
    return await runAssistedTurnGoverned(event, deps, effective.assistModelId, contractDigest)
  } catch (err) {
    // A4: a throwing turn must NOT burn its trigger forever — the
    // dedupe held while the turn ran (concurrent equivalents stayed
    // deduped), and this catch un-remembers so the SAME event may retry
    // after a transient failure. The failure is a typed, VISIBLE refusal,
    // never a silent burn.
    const at = seenTriggers.indexOf(trigger)
    if (at >= 0) seenTriggers.splice(at, 1)
    const reason = `coordinator turn failed — ${err instanceof Error ? err.message : String(err)}`
    try {
      await (await import('./coordinatorReceipts.js')).ingestCoordinatorTurnRefusal({
        reason,
        modelId: effective.assistModelId,
        ...(deps.crewDir !== undefined ? { crewDir: deps.crewDir } : {}),
      })
    } catch {
      /* projection only */
    }
    return {
      outcome: 'refused',
      reason,
      contractDigest,
      modelId: effective.assistModelId,
      receipts: [],
    }
  }
}

/** The governed turn body (permit-scoped; the caller's A4 catch owns
 *  trigger un-remembering for anything thrown here). */
async function runAssistedTurnGoverned(
  event: KernelEventV1,
  deps: CoordinatorLaneDeps,
  assistModelId: string,
  contractDigest: string,
): Promise<AssistedTurnReceipt> {
  const governor = await import('../capacity/governor.js')
  const callId = `coordinator:${triggerKeyOf(event)}`
  const permit = await governor.acquireModelPermit({ lane: 'coordinator', callId })
  try {
    // THE PRE-TURN STATE INJECTION: the model's board is the coordinatorBoard
    // projection — the same rows the operator's screen paints, joined with
    // the records and each fork's commit state — assembled fresh every turn
    // and handed over WHOLE (never queried piecemeal, so the model knows
    // instead of guessing). deps.board is the proof seam.
    const board: CoordinatorTurnInput['board'] =
      deps.board ??
      (await (await import('./coordinatorBoard.js'))
        .coordinatorBoardView(deps.crewDir !== undefined ? { crewDir: deps.crewDir } : {})
        .catch(
          (err): CoordinatorTurnInput['board'] => ({
            counts: {},
            sessions: [],
            openObligations: [],
            degraded: `the board could not be read — ${err instanceof Error ? err.message : String(err)}`,
          }),
        ))
    const titleOf = (objectRef: string): string | undefined =>
      board.sessions.find(s => s.sessionId === objectRef)?.title
    const callModel =
      deps.callModel ?? (await import('./coordinatorCall.js')).liveCoordinatorCallModel
    // The G wave: an operator-message turn carries the bounded conversation
    // TAIL (newest last, clipped per entry) — the coordinator CONVERSES
    // with memory; event turns stay snapshot+delta only. Coordinator
    // entries carry their receipt rows so the next turn KNOWS what it did
    // and what was refused (the live transcript that motivated this: the
    // model re-asked whether to launch a session it had already launched).
    const conv = await import('./coordinatorConversation.js')
    const { buildCoordinatorReplay } = await import('./coordinatorReplay.js')
    const conversation =
      event.kind === 'operator-message'
        ? buildCoordinatorReplay(await conv.readCoordinatorConversation(), Date.now())
        : undefined
    // The acting seat resolves BEFORE the call: the live
    // turn's tools stamp it on every daemon op, and its receipts row the
    // feed the moment each verb settles — attribution can't wait for the
    // proposal path's post-hoc resolve.
    const { coordinatorAgentId } = await import('./coordinatorIdentity.js')
    const actor = await coordinatorAgentId(
      deps.crewDir !== undefined ? { dir: deps.crewDir } : undefined,
    ).catch(() => 'coordinator-unresolved' as never)
    const feed = await import('./coordinatorReceipts.js').catch(() => null)
    // ── the IP-5 turn runtime: deltas stream into the conversation store as
    // a PARTIAL co:<messageId> entry updated in place (the store's append is
    // a filter-replace by id — the message door's FINAL append supersedes
    // it); tool receipts row as each verb settles. Event turns have no
    // conversation entry — receipts still row, deltas go nowhere.
    const messageId = event.kind === 'operator-message' ? event.messageId : undefined
    const toolReceipts: KernelReceiptV1[] = []
    const partialRows: Array<{ verb: string; outcome: string; label: string }> = []
    // Operator finding 2: the runtime's
    // deltas are cumulative PER SEGMENT — a tool call starts a fresh
    // segment, and painting only the current one made pre-tool text ("Got
    // it —") vanish mid-turn. Segments FOLD: everything painted stays.
    let settledSegments = ''
    let segmentText = ''
    let partialText = ''
    let turnClosed = false
    let appendChain: Promise<unknown> = Promise.resolve()
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    const flushPartial = (): void => {
      if (turnClosed || messageId === undefined) return
      const text = partialText
      const rows = partialRows.slice(-24)
      appendChain = appendChain
        .then(() =>
          conv.appendCoordinatorConversation({
            id: `co:${messageId}`,
            role: 'coordinator',
            text,
            ts: Date.now(),
            ...(rows.length > 0 ? { receipts: rows } : {}),
          }),
        )
        .catch(() => undefined)
    }
    const scheduleFlush = (): void => {
      // Throttled (~8 writes/s): the store is a durable file — per-token
      // writes would grind; the trailing edge repaints subscribers live.
      if (turnClosed || messageId === undefined || flushTimer !== undefined) return
      flushTimer = setTimeout(() => {
        flushTimer = undefined
        flushPartial()
      }, 120)
      flushTimer.unref?.()
    }
    const runtime: CoordinatorTurnRuntime = {
      by: actor,
      ...(deps.crewDir !== undefined ? { crewDir: deps.crewDir } : {}),
      onDelta: text => {
        if (segmentText.length > 0 && !text.startsWith(segmentText)) {
          // A non-extension is a NEW segment (the cumulative invariant
          // broke) — fold the finished one; it never un-paints.
          settledSegments = settledSegments === '' ? segmentText : `${settledSegments}\n\n${segmentText}`
        }
        segmentText = text
        partialText = settledSegments === '' ? segmentText : `${settledSegments}\n\n${segmentText}`
        scheduleFlush()
      },
      onReceipt: r => {
        // ONE boundary cast: switchboard tool verbs (session.launch ·
        // session.stop · workflows.* · permission.answer) extend the kernel
        // receipt union; every consumer reads verb/outcome structurally.
        const stamped = { ...r, actorAgentId: actor } as unknown as KernelReceiptV1
        toolReceipts.push(stamped)
        partialRows.push({
          verb: r.verb,
          outcome: r.outcome,
          label: receiptLabelOf(r, titleOf),
        })
        if (r.feedEligible === true && feed !== null) {
          try {
            feed.ingestCoordinatorReceipts([stamped])
          } catch {
            /* projection only */
          }
        }
        scheduleFlush()
      },
    }
    let proposal: CoordinatorTurnProposal
    const inputFor = (tail: typeof conversation): CoordinatorTurnInput => ({
      contractVersion: COORDINATOR_CONTRACT_VERSION,
      contract: COORDINATOR_CONTRACT,
      event,
      board,
      ...(tail !== undefined ? { conversation: tail } : {}),
      ...(deps.manager === true ? { manager: true as const } : {}),
    })
    try {
      try {
        proposal = await callModel(inputFor(conversation), assistModelId, runtime)
      } catch (err) {
        // ── THE OVERFLOW LADDER on the coordinator's chair ──────────────
        // The live call throws the typed overflow when a round settled
        // only as the provider's "does not fit" refusal. Fold the durable
        // conversation ONCE through the landed summarize-in-place owner
        // (the newest turns kept, the marker naming the overflow), rebuild
        // the replay from the store, retry the turn ONCE; a second refusal
        // or an unavailable fold is the typed exhaustion — the A4 catch
        // rows it as a visible refusal receipt, never a raw sentence. The
        // main chat's switches stand: the flag, DISABLE_COMPACT and the
        // automatic-fold toggle (off ⇒ the refusal names /compact).
        const overflow = coordinatorOverflowOf(err)
        if (overflow === null || !overflowRecoveryEnabled() || event.kind !== 'operator-message') throw err
        if (!isAutoCompactEnabled()) throw new Error(coordinatorOverflowRefusal(overflow, 'auto-compact-off'))
        const compact = await import('./coordinatorCompact.js')
        const folded = await compact.summarizeCoordinatorConversation({
          trigger: 'overflow',
          modelId: assistModelId,
          overflow,
          ...(deps.summarizeForCompact !== undefined ? { summarize: deps.summarizeForCompact } : {}),
        })
        if (folded.refused !== undefined) throw new Error(coordinatorOverflowRefusal(overflow, 'fold-refused', folded.refused))
        if (folded.compacted === 0) throw new Error(coordinatorOverflowRefusal(overflow, 'nothing-to-fold'))
        logForDebugging(`[coordinator/overflow] folded ${folded.compacted} turns after ${overflow.family} refused (${overflow.shape}) — retrying the turn once`)
        const refolded = buildCoordinatorReplay(await conv.readCoordinatorConversation(), Date.now())
        try {
          proposal = await callModel(inputFor(refolded), assistModelId, runtime)
        } catch (again) {
          const still = coordinatorOverflowOf(again)
          if (still === null) throw again
          throw new Error(coordinatorOverflowRefusal(still, 'retry-overflowed'))
        }
      }
    } finally {
      // No stale partial may land AFTER the message door's final entry (the
      // same id would filter-replace the finished reply with a torn tail).
      turnClosed = true
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      await appendChain
    }
    // THE CONTEXT GAUGE STAMP — the one writer: every assisted turn that
    // reported input usage stamps the real context size beside the model it
    // ran on. The pane's warning line and the message door's auto-compact
    // decision both read THIS fact (never a parallel estimate). A store
    // hiccup never fails the turn.
    if (proposal.turnUsage !== undefined) {
      await conv
        .stampCoordinatorGauge({
          contextTokens: proposal.turnUsage.contextTokens,
          modelId: assistModelId,
          ts: Date.now(),
        })
        .catch(() => undefined)
    }
    // A8: the two drop reasons are DISTINCT facts — a proposal the
    // vocabulary refused vs a lawful proposal beyond the per-turn bound.
    // The receipt field stays the total (its consumers count drops), the
    // feed wording names each count truthfully.
    const shaped = proposal.decisions.filter(validateProposal)
    const validated = shaped.slice(0, MAX_PROPOSALS_PER_TURN)
    const vocabularyRefused = proposal.decisions.length - shaped.length
    const capDropped = shaped.length - validated.length
    const refusedProposals = vocabularyRefused + capDropped
    // (the attainable-goal law): a proposed smallest question SURFACES —
    // bounded like every model string, rowed on the feed, never executed.
    const smallestQuestion =
      typeof proposal.smallestQuestion === 'string' && proposal.smallestQuestion.length > 0
        ? proposal.smallestQuestion.slice(0, 500)
        : undefined
    if (smallestQuestion !== undefined) {
      try {
        await (await import('./coordinatorReceipts.js')).ingestCoordinatorSmallestQuestion({
          question: smallestQuestion,
          modelId: assistModelId,
          ...(deps.crewDir !== undefined ? { crewDir: deps.crewDir } : {}),
        })
      } catch {
        /* projection only */
      }
    }
    // An equivalent previously-FAILED batch never repeats. Scoped to
    // NON-EMPTY decision batches: the live agent turn
    // executes verbs as tools and returns zero decisions, so the empty
    // batch's constant fingerprint must never be rememberable — one refused
    // tool would otherwise poison every later turn.
    const batch = batchKeyOf(validated)
    if (validated.length > 0 && failedBatches.includes(batch)) {
      const reason = 'an equivalent proposal batch already failed — a genuinely changed strategy is required'
      // the refusal is a visible feed row, never a silent drop.
      try {
        await (await import('./coordinatorReceipts.js')).ingestCoordinatorTurnRefusal({
          reason,
          modelId: assistModelId,
          ...(deps.crewDir !== undefined ? { crewDir: deps.crewDir } : {}),
        })
      } catch {
        /* projection only */
      }
      return {
        outcome: 'refused',
        reason,
        contractDigest,
        modelId: assistModelId,
        receipts: toolReceipts,
        refusedProposals,
      }
    }
    // The KERNEL cross-check: injected-proposal decisions still
    // execute through the SAME owner path as Rules-only and the operator's
    // own controls (the live turn returns none — its verbs already settled
    // as tool receipts above).
    const decisionReceipts: KernelReceiptV1[] = []
    for (const d of validated) {
      // A5: a throwing owner mid-batch must not leave an INVISIBLE
      // half-batch — the thrown decision lands as a typed refused receipt
      // and the remaining decisions still execute (owners are idempotent;
      // every row stays visible). The refused row also marks the batch
      // failed via the existing refusal check below.
      try {
        // 3-3-3 validator: `by` became load-bearing attribution truth (the
        // attached [user]/[coordinator] plates read the persisted origin) —
        // the LANE's identity stamps every lane-executed decision; a model
        // proposal can never spoof by:'operator'.
        const stamped = 'by' in d ? ({ ...d, by: actor } as typeof d) : d
        decisionReceipts.push({ ...(await executeKernelDecision(stamped, deps)), actorAgentId: actor })
      } catch (err) {
        decisionReceipts.push({
          verb: d.verb,
          objectRef: kernelObjectRefOf(d),
          outcome: 'refused',
          detail: `owner threw — ${err instanceof Error ? err.message : String(err)}`,
          actorAgentId: actor,
        })
      }
    }
    if (validated.length > 0 && decisionReceipts.some(r => r.outcome === 'refused'))
      remember(failedBatches, batch)
    // Every executed action rows on the semantic activity feed
    // (tool receipts already rowed at settle); vocabulary-refused and
    // cap-dropped proposals row VISIBLY too.
    try {
      if (feed !== null) {
        feed.ingestCoordinatorReceipts(decisionReceipts)
        // The two drop reasons are DISTINCT facts — one row each (A8), so
        // neither truth hides behind the other or a display clamp.
        if (vocabularyRefused > 0) {
          await feed.ingestCoordinatorTurnRefusal({
            reason: `${vocabularyRefused} proposal(s) outside the closed vocabulary — refused, not executed`,
            refusedProposals: vocabularyRefused,
            modelId: assistModelId,
            actorAgentId: actor,
          })
        }
        if (capDropped > 0) {
          await feed.ingestCoordinatorTurnRefusal({
            reason: `${capDropped} proposal(s) beyond the per-turn bound (${MAX_PROPOSALS_PER_TURN}) — dropped, not executed`,
            refusedProposals: capDropped,
            modelId: assistModelId,
            actorAgentId: actor,
          })
        }
      }
    } catch {
      /* projection only */
    }
    // Finding 2's settle half: the final entry must never show LESS than
    // the stream painted — the accumulated segments win over a
    // final-segment-only reply, so the settle repaint can't eat text.
    const streamedWhole = partialText.trim()
    const proposalReply =
      typeof proposal.reply === 'string' && proposal.reply.trim().length > 0
        ? proposal.reply.trim()
        : undefined
    const rawReply =
      proposalReply !== undefined
        ? streamedWhole.length > proposalReply.length
          ? streamedWhole
          : proposalReply
        : streamedWhole.length > 0
          ? streamedWhole
          : undefined
    const reply = rawReply !== undefined ? clipCoordinatorReply(rawReply) : undefined
    const receipts = [...toolReceipts, ...decisionReceipts]
    // COMPACT REFUSAL LAW's other half: the pane paints ONE line per
    // refusal; the daemon's FULL sentence lives here for whoever digs.
    for (const r of receipts) {
      if ((r.outcome === 'refused' || r.outcome === 'failed') && r.detail !== undefined && r.detail.length > 0) {
        logForDebugging(`[coordinator/receipt] ${r.verb} ${r.objectRef} ${r.outcome} — ${r.detail}`)
      }
    }
    // MANAGER MODE: the cards ride the receipt DECODED — the model-facing
    // tool already validated, but the bound here is the door's (an injected
    // callModel proposal gets the same strict decode, never a raw object).
    const managerAsk = proposal.ask !== undefined ? decodeManagerAsk(proposal.ask) : null
    const managerPlan = proposal.plan !== undefined ? decodeManagerPlan(proposal.plan) : null
    return {
      outcome: 'executed',
      contractDigest,
      modelId: assistModelId,
      receipts,
      receiptLabels: receipts.map(r => ({ verb: r.verb, outcome: r.outcome, label: receiptLabelOf(r, titleOf) })),
      ...(reply !== undefined ? { reply } : {}),
      ...(refusedProposals > 0 ? { refusedProposals } : {}),
      ...(smallestQuestion !== undefined ? { smallestQuestion } : {}),
      ...(managerAsk !== null ? { ask: managerAsk } : {}),
      ...(managerPlan !== null ? { plan: managerPlan } : {}),
    }
  } finally {
    governor.releaseModelPermit(permit.permitId)
  }
}


/** (operator-answered Q1): with the coordinator not
 *  agent-assisted — the boot row's "off" — the composer is a SELF-MANAGED
 *  LAUNCHER. The lane returns this typed signal instead of a coordinator
 *  reply; the composer's OWNER dispatches the text as a direct session
 *  launch (the text becomes the session's task and its title). */
export interface SelfManagedLaunchSignal {
  kind: 'self-managed-launch'
  /** The operator's message, bounded exactly as the conversation stores it. */
  text: string
}

/** The G wave's CONVERSATION door (the Coordinator is a
 *  persistent conversational surface): appends the operator's message to
 *  the durable conversation, runs the assisted turn with the bounded tail,
 *  and appends the coordinator's reply BESIDE its executed receipts.
 *  Not-agent-assisted: the operator entry still appends —
 *  the chat records what was sent — but NO coordinator reply follows; the
 *  door answers the typed SelfManagedLaunchSignal, and the FIRST such
 *  message also appends the one-time hint entry. Returns the turn
 *  receipt (or the signal) for programmatic callers. */
export async function runOperatorMessageTurn(
  text: string,
  deps: CoordinatorLaneDeps,
  // AT-07: the CALLER may hold the identity —
  // the operator entry appends durably BEFORE the turn runs, so a retry
  // after a failed reply append must REPLAY the same op:<id> (the store
  // dedups by id) instead of appending the same text as a new message.
  // onAccepted: fires the
  // moment the operator entry is durably down — the composer clears at THIS
  // point, in the same beat the transcript echo paints, while the assisted
  // turn keeps running on the returned promise.
  opts: { clientMessageId?: string; onAccepted?: () => void; manager?: boolean } = {},
): Promise<AssistedTurnReceipt | SelfManagedLaunchSignal> {
  const conv = await import('./coordinatorConversation.js')
  const { randomUUID } = await import('../../utils/crypto.js')
  const messageId = opts.clientMessageId ?? randomUUID()
  const bounded = text.slice(0, 4000)
  const now = Date.now()
  // Advisor item 8: the durable conversation IS the replay ledger — a
  // completed turn wrote co:<messageId>, so a replayed id returns without
  // touching either entry (the in-memory seenTriggers guard dies with the
  // process; this half survives restarts, and skipping the op: re-append
  // also stops the filter-replace reorder that moved the operator's line).
  const prior = await conv.readCoordinatorConversation()
  if (prior.some(e => e.id === `co:${messageId}`)) {
    // The replayed op entry is already durable — acceptance holds here too.
    opts.onAccepted?.()
    return {
      outcome: 'deduped',
      reason: 'equivalent trigger already coordinated (durable replay)',
      contractDigest: coordinatorContractDigest(),
      receipts: [],
    }
  }
  if (!prior.some(e => e.id === `op:${messageId}`))
    await conv.appendCoordinatorConversation({ id: `op:${messageId}`, role: 'operator', text: bounded, ts: now })
  opts.onAccepted?.()
  const effective = await resolveEffectiveCoordinator()
  // MANAGER MODE in the self-managed world (ledger L22): the composer's
  // shift+tab mode does not depend on the coordinator's mode — its turn
  // runs on the composed coordinator model; with none chosen the pane's
  // harness row says so and names the pick (the screen's note line said it
  // first and kept the draft), and NOTHING launches in the mode's name —
  // the off-branch below (a direct launch + its hint) is never this send.
  const managerModel =
    opts.manager === true && effective.resolution.effective !== 'agent-assisted'
      ? await (await import('./managerMode.js')).resolveManagerModel()
      : null
  if (managerModel !== null && !managerModel.ok) {
    await conv.appendCoordinatorConversation({
      id: `co:${messageId}`,
      role: 'coordinator',
      text: managerModel.line,
      ts: Date.now(),
      harness: true,
    })
    return { outcome: 'not-assisted', reason: managerModel.line, contractDigest: coordinatorContractDigest(), receipts: [] }
  }
  if (effective.resolution.effective !== 'agent-assisted' && managerModel === null) {
    // not agent-assisted ⇒ self-managed. The
    // operator entry above stays; the coordinator never replies here. The
    // FIRST off-mode message appends ONE hint entry — the once-only marker
    // is config, not the conversation: the CONVERSATION_CAP can evict the
    // entry, and the hint must never paint a second time.
    const { getGlobalConfig, saveGlobalConfig } = await import('../../utils/config.js')
    if (getGlobalConfig().hasSeenCoordinatorOffHint !== true) {
      saveGlobalConfig(c => ({ ...c, hasSeenCoordinatorOffHint: true }))
      await conv.appendCoordinatorConversation({
        id: 'co:hint:coordinator-off',
        role: 'coordinator',
        // pinned copy — byte-exact.
        text: 'coordinator is off — messages here start sessions directly · turn it on in the boot menu',
        ts: Date.now(),
        // The harness saying how the surface behaves — never the coordinator,
        // which is off and has said nothing.
        harness: true,
      })
    }
    return { kind: 'self-managed-launch', text: bounded }
  }
  // AUTO-COMPACTION (chat-relief item 2), BEFORE the model turn: the fold
  // decision and both its arms live at coordinatorCompact
  // (maybeAutoCompactCoordinator — the landed threshold law over the
  // stamped gauge, plus the store-cap arm that pre-empts the silent
  // eviction). The turn that follows re-reads the store, so it runs on the
  // folded tail with the summary in its replay. A refused or throwing fold
  // NEVER blocks the ask — the warning line stays up as the visible state,
  // and a manual /compact then speaks the typed refusal.
  {
    const modelForTurn =
      managerModel !== null && managerModel.ok
        ? managerModel.modelId
        : effective.resolution.effective === 'agent-assisted'
          ? effective.assistModelId
          : undefined
    if (modelForTurn !== undefined) {
      try {
        const compact = await import('./coordinatorCompact.js')
        const folded = await compact.maybeAutoCompactCoordinator(modelForTurn, {
          ...(deps.summarizeForCompact !== undefined ? { summarize: deps.summarizeForCompact } : {}),
        })
        if (folded.refused !== undefined) {
          logForDebugging(`[coordinator/auto-compact] refused — ${folded.refused}`)
        } else if (folded.compacted > 0) {
          logForDebugging(`[coordinator/auto-compact] ${folded.trigger}: folded ${folded.compacted} turns`)
        }
      } catch (e) {
        logForDebugging(`[coordinator/auto-compact] threw — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  const receipt = await runAssistedTurn(
    { kind: 'operator-message', messageId, text: bounded },
    opts.manager === true
      ? { ...deps, manager: true, ...(managerModel !== null && managerModel.ok ? { managerModelId: managerModel.modelId } : {}) }
      : deps,
  )
  const receiptLines =
    receipt.receiptLabels ??
    receipt.receipts.map(r => ({ verb: r.verb, outcome: r.outcome, label: receiptLabelOf(r) }))
  // Belt-and-braces (advisor item 8): an intra-process dedupe means the
  // FIRST run already wrote (or is writing) co:<messageId> — appending the
  // 'did not run' notice under the same id would filter-replace the real
  // reply and reorder the conversation.
  if (receipt.outcome === 'deduped') return receipt
  // The fallbacks are the HARNESS speaking, so they say only what the
  // harness knows: a reply-less turn is named as such — never a board claim
  // ("nothing needed doing") the model did not make (the live transcript
  // that motivated this said exactly that while nothing had launched). The
  // row is STORED marked, so the pane paints it in the harness voice and the
  // next turn replays it as a note instead of as words the model said.
  let replyText: string
  let harnessSpoken = false
  if (receipt.reply !== undefined) {
    replyText = receipt.reply
  } else if (receipt.outcome === 'executed') {
    if (receipt.ask !== undefined) {
      // MANAGER MODE: a card-only turn is normal — the entry speaks the
      // model's own question WITH its options (FC-062): the card was the
      // question's only renderer, so esc took the interview off the screen
      // whole; the entry now carries the full ask readably and the card
      // stays the interactive affordance.
      replyText =
        receipt.ask.options.length > 0
          ? `${receipt.ask.question}\n${receipt.ask.options.map((option, index) => `  ${index + 1}. ${option}`).join('\n')}`
          : receipt.ask.question
    } else if (receipt.plan !== undefined) {
      replyText = `the plan is ready — ${receipt.plan.lanes.length} lane${receipt.plan.lanes.length === 1 ? '' : 's'} on the card below`
      harnessSpoken = true
    } else if (receipt.receipts.length > 0) {
      replyText = 'Done — the receipts below are what executed.'
      harnessSpoken = true
    } else if (receipt.smallestQuestion !== undefined) {
      // The model's own question — its words, its voice.
      replyText = receipt.smallestQuestion
    } else {
      replyText = 'The turn ended without a reply — nothing was changed. Ask again and I will answer from the board.'
      harnessSpoken = true
    }
  } else {
    replyText = `The turn did not run: ${receipt.reason ?? receipt.outcome}.`
    harnessSpoken = true
  }
  await conv.appendCoordinatorConversation({
    id: `co:${messageId}`,
    role: 'coordinator',
    text: replyText,
    ts: Date.now(),
    ...(receiptLines.length > 0 ? { receipts: receiptLines } : {}),
    ...(harnessSpoken ? { harness: true as const } : {}),
    ...(receipt.ask !== undefined ? { ask: receipt.ask } : {}),
    ...(receipt.plan !== undefined ? { plan: receipt.plan } : {}),
  })
  return receipt
}

/** Rules-only twin for callers that hold ONE entry: delegates to the ONE
 *  kernel walker (zero model; the kernel entry owns fold + execute +
 *  attribution + the feed emission — §F-1: a second walk here was a
 *  drift class waiting for the vocabulary to grow). */
export async function runCoordinatorTurn(
  event: KernelEventV1,
  deps: CoordinatorLaneDeps,
): Promise<AssistedTurnReceipt> {
  const effective = await resolveEffectiveCoordinator()
  if (effective.resolution.effective === 'agent-assisted') return runAssistedTurn(event, deps)
  if (effective.resolution.effective === 'off') {
    return { outcome: 'not-assisted', reason: 'coordinator off', contractDigest: coordinatorContractDigest(), receipts: [] }
  }
  const receipts = await runCoordinatorKernel(event, { ...deps, mode: 'rules-only' })
  return { outcome: 'executed', contractDigest: coordinatorContractDigest(), receipts }
}
