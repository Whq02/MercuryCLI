import {
  activityIdOf,
  ingestActivity,
  registerActivityClassifier,
  type AgentActivityV1,
} from '../crew/activity.js'
import type { CrewAgentId } from '../crew/identity.js'


export type BoardControlV1 =
  | { verb: 'session.pause'; sessionId: string; by: string; reason: string; clientOpId?: string }
  | { verb: 'session.resume'; sessionId: string; by: string; clientOpId?: string }
  | { verb: 'session.redirect'; sessionId: string; clientMessageId: string; instruction: string; by: string }
  | {
      verb: 'obligation.answer'
      obligationId: string
      sessionId: string
      clientMessageId: string
      answer: string
      content?: unknown[]
      by: string
    }

export interface BoardControlOutcomeV1 {
  verb: BoardControlV1['verb']
  objectRef: string
  outcome: 'applied' | 'noop' | 'refused' | 'failed' | 'queued'
  detail?: string
}

export interface BoardControlDeps {
  crewDir?: string
}

export async function executeBoardControl(
  decision: BoardControlV1,
  deps: BoardControlDeps = {},
): Promise<BoardControlOutcomeV1> {
  switch (decision.verb) {
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
              ...(decision.content !== undefined && decision.content.length > 0 ? { content: decision.content } : {}),
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
  }
}

const BOARD_CONTROL_EVENT_KIND = 'mercury.board-control'
const BOARD_CONTROL_ADAPTER = 'board'
const BOARD_CONTROL_SCOPE = 'concourse'
const OPERATOR = 'operator' as CrewAgentId

const CONTROL_VERB: Record<BoardControlV1['verb'], string> = {
  'session.pause': 'paused session',
  'session.resume': 'resumed session',
  'session.redirect': 'redirected session',
  'obligation.answer': 'answered question',
}

registerActivityClassifier({
  name: 'board-control',
  precedence: 331,
  matches: input => input.event.kind === BOARD_CONTROL_EVENT_KIND,
  lift: input => {
    const r = input.event.payload as BoardControlOutcomeV1
    return {
      activityId: activityIdOf(input),
      startedAt: input.event.atMs,
      updatedAt: input.event.atMs,
      evidenceRefs: [],
      rawRefs: [`board-control:${r.verb}:${r.objectRef}`],
      class: 'question',
      verb: CONTROL_VERB[r.verb],
      objectLabel: r.objectRef.slice(0, 60),
      phase: r.outcome === 'refused' || r.outcome === 'failed' ? 'failed' : 'succeeded',
      outcomeLabel: `${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`.slice(0, 80),
    }
  },
})

let noteSeq = 0
const notedOps: string[] = []

export function noteBoardControl(
  outcome: BoardControlOutcomeV1,
  opts: { opId?: string; atMs?: number } = {},
): AgentActivityV1[] {
  if (opts.opId !== undefined) {
    const key = `${outcome.verb} ${outcome.objectRef} ${opts.opId} ${outcome.outcome}`
    if (notedOps.includes(key)) return []
    notedOps.push(key)
    if (notedOps.length > 200) notedOps.splice(0, notedOps.length - 200)
  }
  const atMs = opts.atMs ?? Date.now()
  return ingestActivity({
    event: {
      sourceEventId: `board-control-${atMs}-${noteSeq++}`,
      kind: BOARD_CONTROL_EVENT_KIND,
      payload: outcome,
      atMs,
    },
    agentId: OPERATOR,
    sessionId: BOARD_CONTROL_SCOPE,
    adapterKind: BOARD_CONTROL_ADAPTER,
  })
}
