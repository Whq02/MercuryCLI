import { randomUUID } from 'node:crypto'
import { SESSION_VERBS } from '../../../daemon/runner-wire/sessionVerbs.js'
import { submitTrace } from '../../../screen/chat/submitTrace.js'
import type {
  CrewmateControlReceiptV1,
  BoardPostReceiptV1,
  BoardPostRequestV1,
  EmptyDetailControlVerbKey,
  LeaveReceiptV1,
  RewindReceiptV1,
  RewindRequestV1,
  SendReceiptV1,
} from '../types.js'
import { REFUSED_EMPTY } from './shared.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { controlFrame, sendControlReceipt, sendEmptyDetailControl } from './controlCarrier.js'
const LEAVE_RPC_TIMEOUT_MS = 135_000

interface VerbsNeeds {
  record(): { readonly sessionId: string }
  rpc(req: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  chainRpc(req: Record<string, unknown>): Promise<Record<string, unknown>>
  verbChain(): Promise<unknown>
  tick(): Promise<void>
  readFacts(): void
}

export class VerbsPart {
  constructor(private readonly needs: VerbsNeeds) {}

  async rewind(req: RewindRequestV1): Promise<RewindReceiptV1> {
    try {
      const reply = await this.needs.chainRpc(req.undo === true || req.filePath !== undefined ? {
        op: SESSION_VERBS.fileRestore.daemon.op,
        sessionId: this.needs.record().sessionId,
        by: 'operator',
        userMessageId: req.userMessageId,
        ...(req.undo === true ? { action: 'undo' } : { action: 'restore', filePath: req.filePath! }),
        ...(req.dryRun === true ? { dryRun: true } : {}),
      } : {
        op: SESSION_VERBS.rewind.daemon.op,
        sessionId: this.needs.record().sessionId,
        by: 'operator',
        mode: req.mode,
        userMessageId: req.userMessageId,
        ...(req.dryRun === true ? { dryRun: true } : {}),
      })
      if (reply.ok !== true) {
        const error = typeof reply.error === 'string' ? reply.error : ''
        if (reply.refusal === 'daemon-older') {
          return { outcome: 'refused', mode: req.mode, refusal: 'daemon-older', detail: error }
        }
        return { outcome: 'refused', mode: req.mode, refusal: 'restore-failed', detail: `${error !== '' ? error : 'the daemon refused the rewind'} — nothing is assumed restored` }
      }
      const outcome = reply.outcome
      if (outcome !== 'applied' && outcome !== 'refused' && outcome !== 'noop') {
        return { outcome: 'refused', mode: req.mode, refusal: 'restore-failed', detail: `unexpected outcome ${String(outcome)}` }
      }
      const receipt: RewindReceiptV1 = {
        outcome,
        mode: req.mode,
        ...(reply.refusal !== undefined ? { refusal: reply.refusal as RewindReceiptV1['refusal'] } : {}),
        ...(typeof reply.detail === 'string' && reply.detail !== '' ? { detail: reply.detail } : {}),
        ...(reply.dryRun === true ? { dryRun: true } : {}),
        ...(reply.code !== undefined ? { code: reply.code as RewindReceiptV1['code'] } : {}),
        ...(reply.conversation !== undefined ? { conversation: reply.conversation as RewindReceiptV1['conversation'] } : {}),
      }
      if (receipt.outcome === 'applied' && receipt.conversation !== undefined && receipt.dryRun !== true) void this.needs.tick()
      return receipt
    } catch (e) {
      return { outcome: 'refused', mode: req.mode, refusal: 'restore-failed', detail: `the daemon is not answering — nothing is assumed restored (${e instanceof Error ? e.message : String(e)})` }
    }
  }

  async sendAgentNote(agentId: string, text: string): Promise<SendReceiptV1> {
    const trimmed = text.trim()
    if (trimmed === '' || agentId === '') return REFUSED_EMPTY
    const clientMessageId = randomUUID()
    submitTrace('connector-agent-note', trimmed, { agentId, clientMessageId })
    try {
      const { ensureOwnedDaemon } = await import('../../../daemon/switchboard/ensureDaemon.js')
      if (!(await ensureOwnedDaemon())) {
        return { state: 'refused', detail: 'the daemon that hosts sessions did not start — ↵ again starts it and retries' }
      }
      const reply = await this.needs.rpc({
        op: SESSION_VERBS.sendWords.daemon.op,
        clientMessageId,
        prompt: trimmed,
        workspaceDir: '',
        targetSessionId: this.needs.record().sessionId,
        by: 'operator',
        mode: 'task-notification',
        agentId,
      })
      if (reply.ok === true) return { state: 'accepted' }
      const detail = typeof reply.error === 'string' ? reply.error : 'the session did not take it'
      return { state: 'refused', detail }
    } catch (e) {
      return { state: 'refused', detail: `the daemon was unreachable — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  controlVerb(key: EmptyDetailControlVerbKey): Promise<CrewmateControlReceiptV1> {
    return sendEmptyDetailControl(this.needs.chainRpc, this.needs.record().sessionId, key)
  }

  pauseGate(paused: boolean): Promise<CrewmateControlReceiptV1> {
    return sendControlReceipt(
      this.needs.chainRpc,
      this.needs.record().sessionId,
      'pauseGate',
      { paused },
      () => this.needs.readFacts(),
    )
  }

  async postBoard(post: BoardPostRequestV1): Promise<BoardPostReceiptV1> {
    try {
      const reply = await this.needs.chainRpc(controlFrame('postBoard', this.needs.record().sessionId, { clientOpId: post.clientOpId, boardPost: post }))
      if (reply.ok !== true) return { ok: false, reason: String(reply.error ?? 'the daemon refused the post') }
      const detail = typeof reply.detail === 'string' ? reply.detail : ''
      if (!detail.startsWith('{')) return { ok: false, reason: detail || `unexpected outcome ${String(reply.outcome)}` }
      const answer = JSON.parse(detail) as { ok: true; event_id: string; seq: number; replay: boolean; address: string; recipients: string[] } | { ok: false; reason: string; candidates?: string[] }
      if (!answer.ok) return answer
      return { ok: true, eventId: answer.event_id, seq: answer.seq, replay: answer.replay, address: answer.address, recipients: answer.recipients }
    } catch (e) {
      return { ok: false, reason: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async leave(opts?: { signal?: AbortSignal }): Promise<LeaveReceiptV1> {
    let interruptFailure: string | null = null
    const skip = (): void => {
      void this.needs
        .rpc(controlFrame('interrupt', this.needs.record().sessionId, { clientOpId: randomUUID() }))
        .then(
          reply => {
            if (reply.ok !== true || reply.outcome === 'refused') {
              interruptFailure = String(reply.detail ?? reply.error ?? 'refused')
            }
          },
          error => {
            passedOver(error)
            interruptFailure = error instanceof Error ? error.message : String(error)
          },
        )
    }
    if (opts?.signal?.aborted) return { note: 'none', detail: 'the handoff was skipped' }
    opts?.signal?.addEventListener('abort', skip, { once: true })
    try {
      await this.needs.verbChain()
      const { daemonControlRpc } = await import('../../../daemon/control/controlSocket.js')
      const reply = (await daemonControlRpc(
        controlFrame('leave', this.needs.record().sessionId) as Parameters<typeof daemonControlRpc>[0],
        { timeoutMs: LEAVE_RPC_TIMEOUT_MS },
      )) as Record<string, unknown>
      const interruptDetail =
        interruptFailure !== null
          ? `the handoff could not be interrupted (${interruptFailure}) — the turn may still be running`
          : undefined
      if (reply.ok !== true) return { note: 'none', detail: interruptDetail ?? String(reply.error ?? 'the daemon refused the verb') }
      const detail = typeof reply.detail === 'string' ? reply.detail : undefined
      if (reply.outcome !== 'applied') return { note: 'none', detail: interruptDetail ?? detail ?? `unexpected outcome ${String(reply.outcome)}` }
      let answer: { note?: unknown; noteChars?: unknown } = {}
      try {
        answer = JSON.parse(detail ?? '{}') as { note?: unknown; noteChars?: unknown }
      } catch {
        answer = {}
      }
      if (answer.note === 'stored' || answer.note === 'skipped' || answer.note === 'none') {
        return {
          note: answer.note,
          ...(typeof answer.noteChars === 'number' && Number.isInteger(answer.noteChars) && answer.noteChars >= 0 ? { noteChars: answer.noteChars } : {}),
          ...(interruptDetail !== undefined ? { detail: interruptDetail } : {}),
        }
      }
      return { note: 'none', detail: interruptDetail ?? detail ?? 'the runner answered the leave with a receipt the screen cannot read' }
    } catch (e) {
      if (interruptFailure !== null) {
        return { note: 'none', detail: `the handoff could not be interrupted (${interruptFailure}) — the turn may still be running` }
      }
      return { note: 'none', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
    } finally {
      opts?.signal?.removeEventListener('abort', skip)
    }
  }

  async agentVerb(
    action: typeof SESSION_VERBS.stopAgent.daemon.action | typeof SESSION_VERBS.resumeAgent.daemon.action,
    agentId: string,
    note?: string,
  ): Promise<CrewmateControlReceiptV1> {
    if (agentId === '') return { outcome: 'refused', detail: `${action} needs a crewmate` }
    const key = action === SESSION_VERBS.stopAgent.daemon.action ? 'stopAgent' : 'resumeAgent'
    return sendControlReceipt(
      this.needs.chainRpc,
      this.needs.record().sessionId,
      key,
      { agentId, ...(note !== undefined ? { note } : {}) },
    )
  }
}
