
import type { ObligationV1 } from '../crew/obligations.js'
import { executeBoardControl, type BoardControlV1 } from './boardControl.js'


type CoordinatorMode = 'off' | 'rules-only' | 'agent-assisted'

export interface CoordinatorModeResolution {
  requested: CoordinatorMode
  effective: CoordinatorMode
  fallbackReason?: string
}

export function resolveCoordinatorMode(requested: CoordinatorMode | undefined): CoordinatorModeResolution {
  const asked: CoordinatorMode = requested ?? 'rules-only'
  return { requested: asked, effective: asked }
}

export async function requestedCoordinatorMode(): Promise<CoordinatorMode | undefined> {
  const { coordinatorEnabled } = await import('./concourseEnabled.js')
  if (!coordinatorEnabled()) return 'off'
  return (await import('../../utils/config.js')).getGlobalConfig().concourseCoordinator?.mode ?? 'agent-assisted'
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
  | {
      verb: 'session.launch'
      workspaceDir: string
      clientMessageId: string
      prompt: string
      title: string
      by: string
    }
  | BoardControlV1

interface KernelFacts {
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
          question: `dispatch refused (${event.reason}); draft preserved ("${preview}"). Retry when a seat frees, or withdraw?`,
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
    case 'session.pause':
    case 'session.resume':
    case 'session.redirect':
    case 'obligation.answer':
      return executeBoardControl(decision, deps)
  }
}

export async function runCoordinatorKernel(
  event: KernelEventV1,
  opts: KernelDeps & { mode?: CoordinatorMode } = {},
): Promise<KernelReceiptV1[]> {
  let requested = opts.mode
  if (requested === undefined) {
    try {
      requested = await requestedCoordinatorMode()
    } catch {
      requested = 'off'
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
      ;(await import('./coordinatorReceipts.js')).ingestCoordinatorReceipts(receipts, opts.crewDir !== undefined ? { crewDir: opts.crewDir } : {})
    } catch {
    }
  }
  return receipts
}
