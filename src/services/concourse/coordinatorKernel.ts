// ============================================================================
// services/concourse/coordinatorKernel —
//  the DETERMINISTIC coordination layer. Code — not any model — owns the
//  decisions here: evaluation is a PURE fold over bounded facts + one typed
//  event, and execution calls the EXISTING owners (obligations store,
//  notification policy). The kernel never talks to a provider: Rules-only
//  coordination is THIS module alone and costs zero model calls (the
//  zero-call leg is proven structurally over this file's import graph).
//
// Modes: 'off' — the kernel does not run (sessions stay
//  fully valid; every kernel action has direct operator parity so nothing
//  is lost but convenience). 'rules-only' — the default: this module.
//  'agent-assisted' — the ONE governed model lane; the mode owner
//  resolves it as itself (A6), and whether the lane may take a MODEL turn
//  is the separate composition (resolveEffectiveCoordinator — registry
//  validation + route honesty, downgrading TYPED, never a silent
//  paid-account choice). The kernel rules are mode-agnostic. The ENTRY
//  resolves the per-user config when a caller passes no mode (D3);
//  evaluateKernel stays pure.
//
//  v1 rules (each composes existing owner receipts; idempotency lives AT
//  the owners — re-executing a decision is a no-op there):
//    R1 dispatch-refused  → attention.raise: ONE durable operator
//       obligation per refused clientMessageId (ref-idempotent upsert;
//       the preserved-draft refusal becomes a visible question instead of
//       a silent dead end).
//    R2 worker-settled    → attention.supersede: open obligations naming
//       the ended session settle 'superseded' (exactly-once at the
//       obligations owner; a question whose session is absent must not keep
//       demanding an answer).
//    R3 obligation-open   → signal.emit: the needs-you host signal for the
//       row's CURRENT revision (replay-safe: the policy layer's revision
//       dedup makes an equivalent trigger a no-op).
//       PRODUCTION WIRE ADJUDICATION: the useObligationSignals hook
//       IS this rule's one live event source (per-principal, the visible
//       process's terminal sender — host emission cannot ride a headless
//       daemon). The kernel carries the rule as PURE provable vocabulary;
//       wiring it a second time would double-own the emission.
//
//  Every executed decision returns a typed receipt (verb · object ·
// outcome) — the vocabulary, no free-form escape hatch. The receipts
//  feed the semantic activity surface when the wiring lands.
// ============================================================================

import type { ObligationV1 } from '../crew/obligations.js'

// ── modes ───────────────────────────────────────────────────────────────────

export type CoordinatorMode = 'off' | 'rules-only' | 'agent-assisted'

export interface CoordinatorModeResolution {
  /** What the config asked for. */
  requested: CoordinatorMode
  /** What actually runs. */
  effective: CoordinatorMode
  /** Present exactly when effective ≠ requested (the visible fallback —
   *  never a silent downgrade). */
  fallbackReason?: string
}

/** ONE mode owner (the snapshot builder + the kernel runner both read
 *  THIS). The assisted lane EXISTS — agent-assisted resolves as
 *  itself here; whether the lane may actually take a model turn is the
 *  SEPARATE composition (resolveEffectiveCoordinator: registry validation
 *  + route honesty downgrade TYPED there). The kernel's own rules are
 *  mode-agnostic — they run in every non-off mode under their true label;
 *  the lane owns assist. */
export function resolveCoordinatorMode(requested: CoordinatorMode | undefined): CoordinatorModeResolution {
  const asked: CoordinatorMode = requested ?? 'rules-only'
  return { requested: asked, effective: asked }
}

// ── the typed event + decision vocabulary (enumerated, closed) ───────

export type KernelEventV1 =
  | {
      kind: 'dispatch-refused'
      clientMessageId: string
      reason: string
      workspaceDir: string
      promptPreview: string
      /** WHO minted the refused dispatch — coordinator-minted refusals stay
       *  in its own conversation. */
      by?: string
    }
  | {
      kind: 'worker-settled'
      sessionId: string
      runnerId: string
      /** a retained fork's merge-back inputs — the
       *  settle owner computes EVERYTHING here so evaluation stays pure
       *  (same facts + same event ⇒ byte-identical decisions). */
      retained?: {
        workspaceId: string
        title: string
        branchName?: string
        /** The live main-checkout session, when one exists. */
        mainHolderSessionId?: string
        /** Every unconsumed finished branch for this workspace, oldest
         *  first — several finished trees hand off together. */
        batchBranches: string[]
        batchWorkerIds: string[]
        /** Drive-12: where the work is (see the settle owner). */
        worktreePath?: string
        committedAhead?: number
        uncommittedFiles?: string[]
      }
    }
  | { kind: 'obligation-open'; obligationId: string }
  // The G wave (the Coordinator is a persistent CONVERSATIONAL
  // surface): an operator message addressed to the coordinator. The pure
  // kernel proposes NOTHING for language (rules cannot parse prose — an
  // honest empty); the assisted lane converses and proposes vocabulary.
  | { kind: 'operator-message'; messageId: string; text: string }

export type KernelDecisionV1 =
  | {
      verb: 'attention.raise'
      /** Ref-idempotent at the obligations owner. */
      ref: string
      sessionId: string
      question: string
      owner: string
    }
  | { verb: 'attention.supersede'; obligationId: string; reason: string }
  | { verb: 'signal.emit'; obligationId: string; revision: number; title: string; body: string }
  // The session verbs — pause closes the DELIVERY VALVE at
  // the one dispatch owner (the in-flight turn finishes; nothing is
  // signalled or destroyed), resume re-opens it, redirect delivers an
  // instruction to an EXISTING live session through the same idempotent
  // dispatch door. evaluateKernel emits NONE of these — they enter via the
  // operator UI (executeKernelDecision directly — parity) and the
  // assisted lane's validated proposals.
  | { verb: 'session.pause'; sessionId: string; by: string; reason: string; clientOpId?: string }
  | { verb: 'session.resume'; sessionId: string; by: string; clientOpId?: string }
  | { verb: 'session.redirect'; sessionId: string; clientMessageId: string; instruction: string; by: string }
  // the merge-back's second leg — no live main
  // holder means the kernel LAUNCHES a merge-review session on the
  // canonical root through the same idempotent dispatch door (admission
  // rules apply: a full board queues it honestly).
  | {
      verb: 'session.launch'
      workspaceDir: string
      clientMessageId: string
      prompt: string
      title: string
      by: string
    }
  // (the H ruling's answer law): 'answer & resume' carries a TYPED
  // answer — it DELIVERS through the same idempotent dispatch door first,
  // and only a successful delivery receipt settles the exact obligation.
  | {
      verb: 'obligation.answer'
      obligationId: string
      sessionId: string
      clientMessageId: string
      answer: string
      by: string
    }

export interface KernelFacts {
  /** Bounded: the OPEN obligations only (the owner's own projection). */
  openObligations: readonly ObligationV1[]
}

/** PURE evaluation — no I/O, no clocks, no model. Same facts + same event
 *  ⇒ byte-identical decisions (the prover's table leg). */
export function evaluateKernel(facts: KernelFacts, event: KernelEventV1): KernelDecisionV1[] {
  switch (event.kind) {
    case 'dispatch-refused': {
      // Operator fix 3: a refusal of a COORDINATOR-minted
      // dispatch never raises an operator obligation — the coordinator's
      // own conversation carries it and it self-corrects; double-raising
      // was the rail noise the operator hit.
      if (event.by !== undefined && event.by !== 'operator') return []
      const preview = event.promptPreview.length > 60 ? `${event.promptPreview.slice(0, 60)}…` : event.promptPreview
      return [
        {
          verb: 'attention.raise',
          ref: `kernel:capacity:${event.clientMessageId}`,
          // No session exists for a refused admission — the obligation binds
          // to the WORKSPACE intent; the concourse rail carries it.
          sessionId: `dispatch:${event.clientMessageId}`,
          question: `dispatch refused — ${event.reason}; the draft is preserved (“${preview}”). Retry when a seat frees, or withdraw?`,
          owner: 'operator',
        },
      ]
    }
    case 'worker-settled': {
      const decisions: KernelDecisionV1[] = facts.openObligations
        .filter(o => o.sessionId === event.sessionId)
        .map(o => ({
          verb: 'attention.supersede' as const,
          obligationId: o.obligationId,
          reason: `worker ${event.runnerId} ended — the question no longer has a live session`,
        }))
      // finished fork work routes home — hand the batch to the
      // live main-checkout session, or launch a merge-review session when
      // none exists. Idempotent ids; the settle owner marks the evidence
      // consumed only on an APPLIED receipt.
      const r = event.retained
      if (r !== undefined) {
        const branches = r.batchBranches.length > 0 ? r.batchBranches : r.branchName !== undefined ? [r.branchName] : []
        if (branches.length > 0) {
          // Drive-12: name WHERE the work is, not just the branch — a fresh
          // session that only hears a branch name hunts the main checkout
          // ("no commits and no diffs from the three sessions") while the
          // work sits in the fork's worktree, possibly uncommitted.
          const whereBits: string[] = []
          if (r.worktreePath !== undefined) whereBits.push(`worktree ${r.worktreePath}`)
          if (r.committedAhead !== undefined && r.committedAhead > 0) whereBits.push(`${r.committedAhead} commit(s) ahead of main`)
          if (r.uncommittedFiles !== undefined && r.uncommittedFiles.length > 0)
            whereBits.push(`${r.uncommittedFiles.length} uncommitted file(s) in the worktree — read them there, they are not on the branch yet`)
          const whereLine = whereBits.length > 0 ? ` Where: ${whereBits.join('; ')}.` : ''
          const branchLine =
            (branches.length > 1 ? `these branches in order: ${branches.join(', ')}` : `branch ${branches[0]}`) + whereLine
          if (r.mainHolderSessionId !== undefined) {
            decisions.push({
              verb: 'session.redirect',
              sessionId: r.mainHolderSessionId,
              // SB-C7: keyed to the SESSION — worker shorts recycle, and a
              // second settle on a reused short replayed the FIRST receipt,
              // silently dropping the new fork's merge-back.
              clientMessageId: `merge-back:${event.sessionId}`,
              by: 'coordinator',
              instruction: `Review and merge ${branchLine} — finished work from "${r.title}". Verify before merging; resolve conflicts thoughtfully.`,
            })
          } else {
            decisions.push({
              verb: 'session.launch',
              workspaceDir: r.workspaceId,
              clientMessageId: `merge-launch:${event.sessionId}`,
              by: 'coordinator',
              title: branches.length > 1 ? 'merge finished branches' : `merge ${branches[0]}`,
              prompt: `Review and merge ${branchLine} into this repo's main line — finished session work. Verify each change before merging, resolve conflicts thoughtfully, and keep the history clean.`,
            })
          }
        }
      }
      return decisions
    }
    case 'obligation-open': {
      const row = facts.openObligations.find(o => o.obligationId === event.obligationId)
      if (!row) return [] // settled between the trigger and the fold — nothing to emit
      return [
        {
          verb: 'signal.emit',
          obligationId: row.obligationId,
          revision: row.revision,
          title: 'needs you',
          body: row.question,
        },
      ]
    }
    case 'operator-message':
      // Language never parses into rules (the honest empty): the assisted
      // lane owns conversation; Rules-only replies with its typed notice at
      // the conversation owner instead of guessing here.
      return []
  }
}

// ── execution (owner calls; idempotency lives AT the owners) ────────────────

export interface KernelReceiptV1 {
  verb: KernelDecisionV1['verb']
  objectRef: string
  /** 'failed' = transport loss (the daemon may have applied the op): the
   *  caller KEEPS its operation identity and a retry replays the same
   *  request — never a refusal, which releases identities (advisor item 8).
   *  'queued' = the daemon held the op durably (a full board queues it
   *  honestly — the reservation starts on its own when the hold lifts):
   *  the shape the tool layer already speaks; rowing it as 'refused'
   *  replayed "launch refused" into the coordinator's next turn for a
   *  session that later started, and left the merge-back's collision
   *  evidence unconsumed so the next settle re-dispatched the same branch
   *  (FN-017 rank 4). */
  outcome: 'applied' | 'noop' | 'refused' | 'failed' | 'queued'
  detail?: string
  /** The GLOBAL coordinator seat that acted (every kernel action
   *  is attributable to the ONE crew identity). */
  actorAgentId: string
  /** The durable operation identity this receipt settles (advisor item 8):
   *  lets the activity feed suppress duplicate receipts for one op —
   *  replays/retries refresh their row instead of appending N times. */
  opId?: string
}

/** The receipt objectRef for any decision (ONE derivation — the typed
 *  half-batch rows and the executors agree on what a receipt points at). */
export function kernelObjectRefOf(d: KernelDecisionV1): string {
  switch (d.verb) {
    case 'attention.raise':
      return d.ref
    case 'attention.supersede':
    case 'signal.emit':
    case 'obligation.answer':
      return d.obligationId
    case 'session.pause':
    case 'session.resume':
    case 'session.redirect':
      return d.sessionId
    case 'session.launch':
      return d.workspaceDir
  }
}

export interface KernelDeps {
  /** Proof seam — explicit store roots; production omits them. */
  crewDir?: string
  configDir?: string
  /** The notifier seam (the REPL hook's sender); absent ⇒ signal.emit is
   *  REFUSED with the revision left unclaimed (never a recorded claim with
   *  no toast — the burned-revision class, FN-017 rank 8). */
  send?: (args: { message: string; title: string; notificationType: string }) => Promise<string>
}

export async function executeKernelDecision(
  decision: KernelDecisionV1,
  deps: KernelDeps = {},
): Promise<Omit<KernelReceiptV1, 'actorAgentId'>> {
  switch (decision.verb) {
    case 'attention.raise': {
      const obligations = await import('../crew/obligations.js')
      const res = await obligations.upsertObligation({
        ref: decision.ref,
        sessionId: decision.sessionId,
        question: decision.question,
        owner: decision.owner,
        scope: 'switchboard',
        ...(deps.crewDir !== undefined ? { dir: deps.crewDir } : {}),
      })
      return {
        verb: decision.verb,
        objectRef: decision.ref,
        outcome: res.reraised ? 'noop' : 'applied',
        detail: `obligation ${res.obligationId} r${res.revision}`,
      }
    }
    case 'attention.supersede': {
      const obligations = await import('../crew/obligations.js')
      const res = await obligations.resolveObligation(decision.obligationId, {
        kind: 'superseded',
        by: 'coordinator',
        scope: 'switchboard',
        ...(deps.crewDir !== undefined ? { dir: deps.crewDir } : {}),
      } as Parameters<typeof obligations.resolveObligation>[1])
      return {
        verb: decision.verb,
        objectRef: decision.obligationId,
        outcome: res.settled ? 'applied' : 'noop',
        detail: `status ${res.status} — ${decision.reason}`,
      }
    }
    case 'session.pause':
    case 'session.resume': {
      // The record mutation lives at the daemon (daemon-owns-records law) —
      // ONE authed op carries both actions; the table adjudicates at
      // the supervisor and the typed outcome rides back verbatim.
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      const action = decision.verb === 'session.pause' ? 'pause' : 'resume'
      try {
        const reply = (await daemonControlRpc(
          {
            op: 'sessionControl',
            action,
            sessionId: decision.sessionId,
            by: decision.by,
            ...(decision.verb === 'session.pause' ? { reason: decision.reason } : {}),
            ...(decision.clientOpId !== undefined ? { clientOpId: decision.clientOpId } : {}),
          } as never,
          { timeoutMs: 15_000 },
        )) as { ok?: boolean; outcome?: 'applied' | 'noop' | 'refused'; detail?: string; error?: string; code?: string }
        // Transport loss is a SYNTHETIC reply (daemonControlRpc never
        // throws for it) — 'failed' keeps the caller's identity so the
        // retry replays instead of duplicating (advisor item 8).
        const lost = reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN'
        return {
          verb: decision.verb,
          objectRef: decision.sessionId,
          outcome: reply.ok === true ? (reply.outcome ?? 'applied') : lost ? 'failed' : 'refused',
          detail: reply.ok === true ? reply.detail : (reply.error ?? (lost ? 'the daemon did not answer' : 'daemon refused')),
        }
      } catch (e) {
        return {
          verb: decision.verb,
          objectRef: decision.sessionId,
          outcome: 'failed',
          detail: `daemon unreachable — ${e instanceof Error ? e.message : String(e)}`,
        }
      }
    }
    case 'session.launch': {
      // the merge-review launch — the SAME idempotent dispatch
      // door as every other start (admission rules apply; a full board
      // queues the row honestly instead of forcing a seat).
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      try {
        const reply = (await daemonControlRpc(
          {
            op: 'sessionDispatch',
            clientMessageId: decision.clientMessageId,
            prompt: decision.prompt,
            workspaceDir: decision.workspaceDir,
            title: decision.title,
            by: decision.by,
          } as never,
          { timeoutMs: 20_000 },
        )) as { ok?: boolean; state?: string; error?: string; code?: string; sessionId?: string; heldReason?: string }
        const lost = reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN'
        const heldOpen = reply.ok !== true && reply.state === 'queued' && typeof reply.heldReason === 'string'
        return {
          verb: decision.verb,
          objectRef: decision.workspaceDir,
          outcome: reply.ok === true ? 'applied' : lost ? 'failed' : heldOpen ? 'queued' : 'refused',
          detail:
            reply.ok === true
              ? `merge review launched (${reply.sessionId?.slice(0, 8) ?? reply.state ?? 'starting'})`
              : heldOpen
                ? `merge review queued (${reply.heldReason}) — it starts when the hold lifts`
                : (reply.error ?? (lost ? 'the daemon did not answer' : 'launch refused')),
        }
      } catch (e) {
        return {
          verb: decision.verb,
          objectRef: decision.workspaceDir,
          outcome: 'failed',
          detail: `daemon unreachable — ${e instanceof Error ? e.message : String(e)}`,
        }
      }
    }
    case 'session.redirect': {
      // The SAME idempotent dispatch door (never a second delivery path):
      // targetSessionId skips admit; a paused target HOLDS typed (the valve)
      // — replaying the same id + instruction after resume delivers.
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      try {
        const reply = (await daemonControlRpc(
          {
            op: 'sessionDispatch',
            clientMessageId: decision.clientMessageId,
            prompt: decision.instruction,
            workspaceDir: '',
            targetSessionId: decision.sessionId,
            by: decision.by,
          } as never,
          { timeoutMs: 15_000 },
        )) as { ok?: boolean; state?: string; error?: string; code?: string; heldReason?: string }
        const lost = reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN'
        const heldOpen = reply.ok !== true && reply.state === 'queued' && typeof reply.heldReason === 'string'
        return {
          verb: decision.verb,
          objectRef: decision.sessionId,
          outcome: reply.ok === true ? 'applied' : lost ? 'failed' : heldOpen ? 'queued' : 'refused',
          detail:
            reply.ok === true
              ? `instruction delivered (${reply.state ?? 'working'})`
              : heldOpen
                ? `instruction queued (${reply.heldReason}) — it delivers when the hold lifts`
                : (reply.error ?? (lost ? 'the daemon did not answer' : 'dispatch refused')),
        }
      } catch (e) {
        return {
          verb: decision.verb,
          objectRef: decision.sessionId,
          outcome: 'failed',
          detail: `daemon unreachable — ${e instanceof Error ? e.message : String(e)}`,
        }
      }
    }
    case 'obligation.answer': {
      // Delivery FIRST, settle ONLY on the delivery receipt: the
      // typed answer rides the same idempotent dispatch door redirect uses
      // (a paused target HOLDS typed; replaying the same clientMessageId
      // after resume delivers exactly once). A refused delivery leaves the
      // question OPEN — never a silent settle.
      // R7 C-HIGH-3 (the born-wedged R1 class): a dispatch-refused question
      // carries the pseudo session id `dispatch:<cmid>` — no session exists
      // to deliver an answer to, so the composer door refuses TYPED instead
      // of failing the first ↵ and wedging the row.
      if (decision.sessionId.startsWith('dispatch:')) {
        return {
          verb: decision.verb,
          objectRef: decision.obligationId,
          outcome: 'refused',
          detail:
            'this question has no session to deliver to (the dispatch was refused before a session existed) — withdraw it, or submit the instruction again',
        }
      }
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      let delivered = false
      let detail = ''
      try {
        // R7 C-HIGH-3: the obligation pins a STABLE base id, so ONE failed
        // delivery would wedge the answer door forever (replaying a failed
        // row returns ok:false eternally; an edited answer 'edited-replay').
        // Each observed failed-replay mints exactly one successor identity
        // derived from the failed row's settled revision (terminal
        // rows stay immutable; the retry is a NEW message). The chain is
        // deterministic, so a crash-replay walks the same links — the
        // exactly-once law holds per link.
        let clientMessageId = decision.clientMessageId
        for (let hop = 0; hop < 5; hop++) {
          const reply = (await daemonControlRpc(
            {
              op: 'sessionDispatch',
              clientMessageId,
              prompt: decision.answer,
              workspaceDir: '',
              targetSessionId: decision.sessionId,
              by: decision.by,
            } as never,
            { timeoutMs: 15_000 },
          )) as { ok?: boolean; state?: string; stateRevision?: number; error?: string; replay?: string; code?: string }
          if (reply.ok !== true && reply.replay !== undefined && reply.state === 'failed') {
            clientMessageId = `${clientMessageId}:r${reply.stateRevision ?? 0}`
            continue
          }
          if (reply.ok !== true && (reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN')) {
            // Transport loss is 'failed', never a refusal (advisor item 8):
            // the answer may have reached the worker; the stable
            // obl-answer:<id> identity replays through the dispatch ledger
            // on the retry, and the obligation stays open until a REAL
            // delivery receipt settles it.
            return {
              verb: decision.verb,
              objectRef: decision.obligationId,
              outcome: 'failed',
              detail: 'the daemon did not answer — the retry replays the same delivery',
            }
          }
          delivered = reply.ok === true
          detail = delivered
            ? `answer delivered (${reply.state ?? 'working'})`
            : (reply.error ?? 'dispatch refused')
          break
        }
        if (!delivered && detail === '') detail = 'delivery retry chain exhausted — the target keeps refusing'
      } catch (e) {
        return {
          verb: decision.verb,
          objectRef: decision.obligationId,
          outcome: 'failed',
          detail: `daemon unreachable — ${e instanceof Error ? e.message : String(e)}`,
        }
      }
      if (!delivered) {
        return { verb: decision.verb, objectRef: decision.obligationId, outcome: 'refused', detail }
      }
      const obligations = await import('../crew/obligations.js')
      const res = await obligations.resolveObligation(decision.obligationId, {
        kind: 'answered',
        by: decision.by,
        resumptionRef: decision.clientMessageId,
        scope: 'switchboard',
        ...(deps.crewDir !== undefined ? { dir: deps.crewDir } : {}),
      } as Parameters<typeof obligations.resolveObligation>[1])
      return {
        verb: decision.verb,
        objectRef: decision.obligationId,
        outcome: res.settled ? 'applied' : 'noop',
        detail: res.settled ? `${detail} · obligation settled` : `${detail} · already ${res.status}`,
      }
    }
    case 'signal.emit': {
      // NO SENDER, NO CLAIM (FN-017 rank 8): the policy claims the
      // obligation's revision durably BEFORE it sends, so a stub sender
      // burned the revision — the REPL hook's later real send was then
      // refused as duplicate-revision, the operator got no host
      // notification and no activation pointer, permanently for that
      // revision. useObligationSignals is this rule's ONE live event source;
      // a caller with no notifier gets a typed refusal and the revision
      // stays unclaimed for the owner that can reach a host.
      if (deps.send === undefined) {
        return {
          verb: decision.verb,
          objectRef: decision.obligationId,
          outcome: 'refused',
          detail: 'no-sender — the obligation hook owns host signals; the revision is left unclaimed',
        }
      }
      const policy = await import('../notificationPolicy.js')
      const res = await policy.emitConcourseSignal(
        {
          kind: 'needs-you',
          targetId: decision.obligationId,
          revision: decision.revision,
          obligationBacked: true,
          title: decision.title,
          detail: decision.body,
          deepLink: { obligationId: decision.obligationId },
        },
        {
          // Kernel-driven emissions ride the SAME notifier seam the REPL
          // hook injects; a caller with no sender was refused above (a
          // claim without a toast is the burned-revision class).
          send: deps.send,
          // Obligation-backed dedup lives on the OBLIGATION rows — the
          // policy's dir seam must point at the obligations home (the
          // kernel emits obligation-backed signals only).
          ...(deps.crewDir !== undefined ? { dir: deps.crewDir } : {}),
        },
      )
      return {
        verb: decision.verb,
        objectRef: decision.obligationId,
        outcome: res.emitted ? 'applied' : 'noop',
        detail: res.emitted ? `revision ${decision.revision}` : (res.reason ?? 'not emitted'),
      }
    }
  }
}

/** The one entry the event sources call: resolve mode → fold facts →
 *  evaluate → execute. 'off' returns [] without reading the estate.
 *  A3 (D3 = kernel-resolves-config): a caller that passes NO mode gets the
 *  per-user config's answer resolved HERE — this entry is already the
 *  impure shell (obligations read · identity resolve · feed emission), and
 *  per-call-site mode discipline demonstrably failed at both daemon rides
 *  (a configured 'off' was silently ignored). evaluateKernel stays pure. */
export async function runCoordinatorKernel(
  event: KernelEventV1,
  opts: KernelDeps & { mode?: CoordinatorMode } = {},
): Promise<KernelReceiptV1[]> {
  let requested = opts.mode
  if (requested === undefined) {
    try {
      requested = (await import('../../utils/config.js')).getGlobalConfig().concourseCoordinator?.mode
    } catch {
      /* config unavailable (headless boot edge) — the resolver's default */
    }
  }
  const mode = resolveCoordinatorMode(requested).effective
  if (mode === 'off') return []
  // The acting seat: the ONE global crew identity (idempotent resolve —
  // the stable identity + the attributable actions).
  const { coordinatorAgentId } = await import('./coordinatorIdentity.js')
  const actor = await coordinatorAgentId(
    opts.crewDir !== undefined ? { dir: opts.crewDir } : undefined,
  ).catch(() => 'coordinator-unresolved' as never)
  const obligations = await import('../crew/obligations.js')
  const open = await obligations.openObligations({
    scope: 'switchboard',
    ...(opts.crewDir !== undefined ? { dir: opts.crewDir } : {}),
  })
  const decisions = evaluateKernel({ openObligations: open }, event)
  const receipts: KernelReceiptV1[] = []
  for (const d of decisions) {
    // A5: a throwing owner mid-batch lands as a typed refused
    // receipt and the remaining decisions still execute — never an
    // invisible half-batch (owners are idempotent; every row visible).
    try {
      receipts.push({ ...(await executeKernelDecision(d, opts)), actorAgentId: actor })
    } catch (err) {
      receipts.push({
        verb: d.verb,
        objectRef: kernelObjectRefOf(d),
        outcome: 'refused',
        detail: `owner threw — ${err instanceof Error ? err.message : String(err)}`,
        actorAgentId: actor,
      })
    }
  }
  if (receipts.length > 0) {
    // The receipts row on this process's semantic activity feed (a
    // bounded projection — never blocks or fails the action itself).
    try {
      ;(await import('./coordinatorReceipts.js')).ingestCoordinatorReceipts(receipts)
    } catch {
      /* projection only */
    }
  }
  return receipts
}
