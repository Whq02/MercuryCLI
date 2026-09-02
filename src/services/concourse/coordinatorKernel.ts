
import type { ObligationV1 } from '../crew/obligations.js'


export type CoordinatorMode = 'off' | 'rules-only' | 'agent-assisted'

export interface CoordinatorModeResolution {
  requested: CoordinatorMode
  effective: CoordinatorMode
  fallbackReason?: string
}

export function resolveCoordinatorMode(requested: CoordinatorMode | undefined): CoordinatorModeResolution {
  const asked: CoordinatorMode = requested ?? 'rules-only'
  return { requested: asked, effective: asked }
}


export type KernelEventV1 =
  | {
      kind: 'dispatch-refused'
      clientMessageId: string
      reason: string
      workspaceDir: string
      promptPreview: string
      by?: string
    }
  | {
      kind: 'worker-settled'
      sessionId: string
      runnerId: string
      retained?: {
        workspaceId: string
        title: string
        branchName?: string
        mainHolderSessionId?: string
        batchBranches: string[]
        batchWorkerIds: string[]
        worktreePath?: string
        committedAhead?: number
        uncommittedFiles?: string[]
      }
    }
  | { kind: 'obligation-open'; obligationId: string }
  | { kind: 'operator-message'; messageId: string; text: string }

export type KernelDecisionV1 =
  | {
      verb: 'attention.raise'
      ref: string
      sessionId: string
      question: string
      owner: string
    }
  | { verb: 'attention.supersede'; obligationId: string; reason: string }
  | { verb: 'signal.emit'; obligationId: string; revision: number; title: string; body: string }
  | { verb: 'session.pause'; sessionId: string; by: string; reason: string; clientOpId?: string }
  | { verb: 'session.resume'; sessionId: string; by: string; clientOpId?: string }
  | { verb: 'session.redirect'; sessionId: string; clientMessageId: string; instruction: string; by: string }
  | {
      verb: 'session.launch'
      workspaceDir: string
      clientMessageId: string
      prompt: string
      title: string
      by: string
    }
  | {
      verb: 'obligation.answer'
      obligationId: string
      sessionId: string
      clientMessageId: string
      answer: string
      by: string
    }

export interface KernelFacts {
  openObligations: readonly ObligationV1[]
}

export function evaluateKernel(facts: KernelFacts, event: KernelEventV1): KernelDecisionV1[] {
  switch (event.kind) {
    case 'dispatch-refused': {
      if (event.by !== undefined && event.by !== 'operator') return []
      const preview = event.promptPreview.length > 60 ? `${event.promptPreview.slice(0, 60)}…` : event.promptPreview
      return [
        {
          verb: 'attention.raise',
          ref: `kernel:capacity:${event.clientMessageId}`,
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
      const r = event.retained
      if (r !== undefined) {
        const branches = r.batchBranches.length > 0 ? r.batchBranches : r.branchName !== undefined ? [r.branchName] : []
        if (branches.length > 0) {
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
      if (!row) return []
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
      return []
  }
}


export interface KernelReceiptV1 {
  verb: KernelDecisionV1['verb']
  objectRef: string
  outcome: 'applied' | 'noop' | 'refused' | 'failed' | 'queued'
  detail?: string
  actorAgentId: string
  opId?: string
}

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
  crewDir?: string
  configDir?: string
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
          send: deps.send,
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

export async function runCoordinatorKernel(
  event: KernelEventV1,
  opts: KernelDeps & { mode?: CoordinatorMode } = {},
): Promise<KernelReceiptV1[]> {
  let requested = opts.mode
  if (requested === undefined) {
    try {
      requested = (await import('../../utils/config.js')).getGlobalConfig().concourseCoordinator?.mode
    } catch {
    }
  }
  const mode = resolveCoordinatorMode(requested).effective
  if (mode === 'off') return []
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
    try {
      ;(await import('./coordinatorReceipts.js')).ingestCoordinatorReceipts(receipts)
    } catch {
    }
  }
  return receipts
}
