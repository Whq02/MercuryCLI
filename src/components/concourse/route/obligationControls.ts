import { logForDebugging } from '../../../utils/debug.js';
import { errorMessage } from '../../../utils/errors.js';
import { resolveObligation } from '../../../services/crew/obligations.js';
import type { RouteControls } from './controlContext.js';
import { noteFromReceipt } from './receipts.js';

export function answerObligation({ noteControl, noteResident, refresh }: RouteControls, obligationId: string, answer: string): void {
  noteControl('strip:composer', 'pending')
  void (async () => {
    try {
      const o = await import('../../../services/crew/obligations.js')
      const row = await o.obligationOf(obligationId, { scope: 'switchboard' })
      if (!row || row.status !== 'open') {
        noteResident('refused', 'this question already settled elsewhere')
        noteControl('strip:composer', {
          state: 'refused',
          reason: 'this question already settled elsewhere',
          next: 'the rail shows what is still open',
        })
        refresh()
        return
      }
      const control = await import('../../../services/concourse/boardControl.js')
      const receipt = await control.executeBoardControl({
        verb: 'obligation.answer',
        obligationId,
        sessionId: row.sessionId,
        clientMessageId: `obl-answer:${obligationId}`,
        answer,
        by: 'operator',
      })
      control.noteBoardControl(receipt)
      if (receipt.outcome === 'refused') noteResident('refused', receipt.detail)
      else if (receipt.outcome === 'failed') noteResident('held', receipt.detail)
      noteControl('strip:composer', noteFromReceipt(receipt as { outcome?: string; detail?: string }))
    } catch (e) {
      logForDebugging(`[concourse] answer failed: ${e}`)
      noteResident('held', 'the delivery failed — ↵ retries the same delivery')
      noteControl('strip:composer', { state: 'failed', reason: 'the delivery failed', next: '↵ retries the same delivery' })
    }
    refresh()
  })()
}

export function answerPermission({ noteControl, refresh }: RouteControls, requestId: string, allow: boolean, obligationId: string): void {
  void (async () => {
    try {
      const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
      const o = await import('../../../services/crew/obligations.js')
      const row = await o.obligationOf(obligationId, { scope: 'switchboard' })
      const reply = await daemonControlRpc(
        {
          op: 'concourseControl',
          action: 'answer-permission',
          sessionId: row?.sessionId ?? 'unknown',
          by: 'operator',
          requestId,
          allow,
        },
        { timeoutMs: 15_000 },
      )
      if (reply.ok === true && reply.outcome === 'applied') {
        noteControl('strip:composer', { state: 'applied', reason: allow ? 'allowed' : 'denied' })
      } else {
        noteControl('strip:composer', {
          state: 'refused',
          reason: (reply.ok ? reply.detail : undefined) ?? 'the ask was already answered',
        })
      }
    } catch {
      noteControl('strip:composer', {
        state: 'failed',
        reason: 'the daemon was unreachable',
        next: 'answer again from the rail',
      })
    }
    refresh()
  })()
}

export function openObligation({ noteControl, snapshotRef, setWaitingRoom, attachAndEnter }: RouteControls, obligationId: string): void {
  void import('../../../services/crew/obligations.js').then(async o => {
    const row = await o.obligationOf(obligationId, { scope: 'switchboard' })
    const subject = row ? `'${(row.question ?? row.sessionId).slice(0, 40)}'` : 'a settled question'
    if (!row) {
      noteControl('peek:enter-full-session', {
        state: 'refused',
        reason: 'that question already settled — nothing to open',
      })
      return
    }
    if (row.sessionId.startsWith('dispatch:')) {
      const boardRow = snapshotRef.current?.groups
        .flatMap(g => g.rows)
        .find(r => r.sessionId === row.sessionId)
      setWaitingRoom({
        dispatchId: row.sessionId.slice('dispatch:'.length),
        title: boardRow?.title ?? (row.question ?? 'queued session').slice(0, 48),
        project: boardRow?.projectLabel ?? '',
      })
      return
    }
    void subject
    attachAndEnter(row.sessionId, 'board:open', { fullChat: true, entry: 'settled' })
  })
}

export function withdrawObligation({ noteControl, refresh }: RouteControls, obligationId: string): void {
  void (async () => {
    try {
      const o = await import('../../../services/crew/obligations.js')
      const row = await o.obligationOf(obligationId, { scope: 'switchboard' })
      const subject = row ? `'${(row.question ?? '').slice(0, 40)}'` : 'the question'
      const res = await resolveObligation(obligationId, { kind: 'withdrawn', by: 'operator', scope: 'switchboard' })
      noteControl(
        'strip:composer',
        res.settled
          ? { state: 'applied', reason: `withdrew ${subject}` }
          : { state: 'refused', reason: `${subject} already settled (${res.status})` },
      )
    } catch (e) {
      logForDebugging(`[concourse] withdraw failed: ${e}`)
      noteControl('strip:composer', { state: 'failed', reason: 'the withdraw failed', next: 'w retries' })
    }
    refresh()
  })()
}

export function claimObligation({ noteControl, refresh }: RouteControls, obligationId: string): void {
  void (async () => {
    try {
      const o = await import('../../../services/crew/obligations.js')
      const { getOperatorName } = await import('../../../substrate/identity/operatorDisplayName.js')
      await o.redirectObligation(obligationId, getOperatorName() || 'operator', { by: 'operator', scope: 'switchboard' })
    } catch (e) {
      logForDebugging(`[concourse] claim failed: ${e}`)
      noteControl('strip:composer', { state: 'failed', reason: `the claim failed (${errorMessage(e)})`, next: 'try claiming again' })
    }
    refresh()
  })()
}
