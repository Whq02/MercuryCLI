import { logForDebugging } from '../../../utils/debug.js';
import type { RouteControls } from './controlContext.js';
import { noteFromReceipt, rowReceipt, rowReceiptClock } from './receipts.js';

export function pauseAfterTurn({ peekOpInFlight, noteControl, mintControlOpId, controlOpIdRef, refresh }: RouteControls, sessionId: string): void {
  if (peekOpInFlight.current.has('row:pause')) return
  peekOpInFlight.current.add('row:pause')
  noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: 'pausing…' })
  void (async () => {
    try {
      const { randomUUID } = await import('../../../utils/crypto.js')
      const control = await import('../../../services/concourse/boardControl.js')
      const clientOpId = mintControlOpId(`pause:${sessionId}`, `concourse-op-${randomUUID()}`)
      const receipt = await control.executeBoardControl({
        verb: 'session.pause',
        sessionId,
        by: 'operator',
        reason: 'operator pause after turn',
        clientOpId,
      })
      if (receipt.outcome !== 'failed') {
        controlOpIdRef.current.delete(`pause:${sessionId}`)
        controlOpIdRef.current.delete(`resume:${sessionId}`)
      }
      control.noteBoardControl(receipt, { opId: clientOpId })
      noteControl(
        `board:row-control:${sessionId}`,
        receipt.outcome === 'applied'
          ? { state: 'applied', reason: `paused by you · ${rowReceiptClock()}` }
          : noteFromReceipt(receipt as { outcome?: string; detail?: string }),
      )
    } catch (e) {
      logForDebugging(`[concourse] pause failed: ${e}`)
      noteControl(`board:row-control:${sessionId}`, 'refused')
    }
    peekOpInFlight.current.delete('row:pause')
    refresh()
  })()
}

export function resumeSession({ peekOpInFlight, noteControl, mintControlOpId, controlOpIdRef, refresh }: RouteControls, sessionId: string): void {
  if (peekOpInFlight.current.has('row:resume')) return
  peekOpInFlight.current.add('row:resume')
  noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: 'resuming…' })
  void (async () => {
    try {
      const { randomUUID } = await import('../../../utils/crypto.js')
      const control = await import('../../../services/concourse/boardControl.js')
      const clientOpId = mintControlOpId(`resume:${sessionId}`, `concourse-op-${randomUUID()}`)
      const receipt = await control.executeBoardControl({ verb: 'session.resume', sessionId, by: 'operator', clientOpId })
      if (receipt.outcome !== 'failed') {
        controlOpIdRef.current.delete(`pause:${sessionId}`)
        controlOpIdRef.current.delete(`resume:${sessionId}`)
      }
      control.noteBoardControl(receipt, { opId: clientOpId })
      noteControl(
        `board:row-control:${sessionId}`,
        receipt.outcome === 'applied'
          ? { state: 'applied', reason: rowReceipt('resumed') }
          : noteFromReceipt(receipt as { outcome?: string; detail?: string }),
      )
    } catch (e) {
      logForDebugging(`[concourse] resume failed: ${e}`)
      noteControl(`board:row-control:${sessionId}`, 'refused')
    }
    peekOpInFlight.current.delete('row:resume')
    refresh()
  })()
}

export function interruptSession({ peekOpInFlight, noteControl, mintControlOpId, controlOpIdRef, refresh }: RouteControls, sessionId: string): void {
  if (peekOpInFlight.current.has('row:interrupt')) return
  peekOpInFlight.current.add('row:interrupt')
  noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: 'interrupting…' })
  void (async () => {
    try {
      const { randomUUID } = await import('../../../utils/crypto.js')
      const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
      const clientOpId = mintControlOpId(`interrupt:${sessionId}`, `concourse-op-${randomUUID()}`)
      const reply = await daemonControlRpc(
        { op: 'concourseControl', action: 'interrupt', sessionId, by: 'operator', clientOpId },
        { timeoutMs: 15_000 },
      )
      if (reply.ok !== true) {
        if (reply.code !== 'ETIMEOUT' && reply.code !== 'ENOCONN') controlOpIdRef.current.delete(`interrupt:${sessionId}`)
        noteControl(`board:row-control:${sessionId}`, {
          state: reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN' ? 'failed' : 'refused',
          reason: reply.error ?? 'the interrupt did not reach the daemon',
          next: 'i retries',
        })
      } else {
        controlOpIdRef.current.delete(`interrupt:${sessionId}`)
        noteControl(
          `board:row-control:${sessionId}`,
          reply.outcome === 'applied'
            ? { state: 'applied', reason: rowReceipt('interrupted · idle') }
            : reply.outcome === 'noop'
              ? { state: 'applied', reason: reply.detail ?? 'no turn to interrupt' }
              : { state: 'refused', reason: reply.detail ?? 'the session refused the interrupt' },
        )
      }
    } catch (e) {
      logForDebugging(`[concourse] interrupt failed: ${e}`)
      noteControl(`board:row-control:${sessionId}`, { state: 'failed', reason: 'the daemon was unreachable', next: 'i retries' })
    }
    peekOpInFlight.current.delete('row:interrupt')
    refresh()
  })()
}

export function setSessionModel({ peekOpInFlight, noteControl, refresh }: RouteControls, sessionId: string, modelId: string, displayName?: string): void {
  if (peekOpInFlight.current.has('row:model')) return
  peekOpInFlight.current.add('row:model')
  const spoken = displayName ?? modelId
  noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: `switching to ${spoken}…` })
  void (async () => {
    try {
      const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
      const reply = await daemonControlRpc(
        { op: 'concourseControl', action: 'set-model', sessionId, by: 'operator', model: modelId },
        { timeoutMs: 15_000 },
      )
      noteControl(
        `board:row-control:${sessionId}`,
        reply.ok === true && reply.outcome === 'applied'
          ? { state: 'applied', reason: rowReceipt(`model → ${spoken}`) }
          : reply.ok === true && reply.outcome === 'queued'
            ? { state: 'held', reason: rowReceipt(reply.detail ?? `${spoken} applies when this turn ends`) }
            : reply.ok === true && reply.outcome === 'noop'
              ? { state: 'applied', reason: reply.detail ?? `already on ${spoken}` }
              : {
                  state: !reply.ok && (reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN') ? 'failed' : 'refused',
                  reason: (reply.ok ? reply.detail : reply.error) ?? 'the model was not switched',
                  next: 'm retries',
                },
      )
    } catch (e) {
      logForDebugging(`[concourse] set-model failed: ${e}`)
      noteControl(`board:row-control:${sessionId}`, { state: 'failed', reason: 'the daemon was unreachable', next: 'm retries' })
    }
    peekOpInFlight.current.delete('row:model')
    refresh()
  })()
}

export function redirectSession({ noteControl, noteResident, redirectIdRef, refresh }: RouteControls, sessionId: string, instruction: string): void {
  noteControl('strip:composer', 'pending')
  void (async () => {
    try {
      const { randomUUID } = await import('../../../utils/crypto.js')
      const control = await import('../../../services/concourse/boardControl.js')
      const minted = redirectIdRef.current.get(sessionId)
      const clientMessageId =
        minted !== undefined && minted.instruction === instruction ? minted.id : `concourse-redirect-${randomUUID()}`
      redirectIdRef.current.set(sessionId, { instruction, id: clientMessageId })
      const receipt = await control.executeBoardControl({
        verb: 'session.redirect',
        sessionId,
        clientMessageId,
        instruction,
        by: 'operator',
      })
      if (receipt.outcome === 'applied') redirectIdRef.current.delete(sessionId)
      else if (receipt.outcome !== 'failed' && !(receipt.detail ?? '').startsWith('session-paused'))
        redirectIdRef.current.delete(sessionId)
      control.noteBoardControl(receipt)
      const held = (receipt.detail ?? '').startsWith('session-paused') || receipt.outcome === 'failed'
      noteResident(receipt.outcome === 'applied' ? 'wink' : held ? 'held' : 'refused', receipt.detail)
      noteControl(
        'strip:composer',
        held
          ? { state: 'held', reason: receipt.detail, next: '↵ again replays after resume' }
          : noteFromReceipt(receipt as { outcome?: string; detail?: string }),
      )
    } catch (e) {
      logForDebugging(`[concourse] redirect failed: ${e}`)
      noteResident('held', 'the daemon was unreachable')
      noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: '↵ retries' })
    }
    refresh()
  })()
}

export function setSessionEffort({ peekOpInFlight, noteControl, refresh }: RouteControls, sessionId: string, effort: string): void {
  if (peekOpInFlight.current.has('row:effort')) return
  peekOpInFlight.current.add('row:effort')
  noteControl(`board:row-control:${sessionId}`, { state: 'pending', reason: `effort → ${effort}…` })
  void (async () => {
    try {
      const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
      const reply = await daemonControlRpc(
        { op: 'concourseControl', action: 'set-effort', sessionId, by: 'operator', effort },
        { timeoutMs: 15_000 },
      )
      noteControl(
        `board:row-control:${sessionId}`,
        reply.ok === true && reply.outcome === 'applied'
          ? { state: 'applied', reason: rowReceipt(`effort → ${effort}`) }
          : reply.ok === true && reply.outcome === 'queued'
            ? { state: 'held', reason: rowReceipt(reply.detail ?? `${effort} applies when this turn ends`) }
            : reply.ok === true && reply.outcome === 'noop'
              ? { state: 'applied', reason: reply.detail ?? `already at ${effort}` }
              : {
                  state: !reply.ok && (reply.code === 'ETIMEOUT' || reply.code === 'ENOCONN') ? 'failed' : 'refused',
                  reason: (reply.ok ? reply.detail : reply.error) ?? 'the effort was not set',
                  next: 'e retries',
                },
      )
    } catch (e) {
      logForDebugging(`[concourse] set-effort failed: ${e}`)
      noteControl(`board:row-control:${sessionId}`, { state: 'failed', reason: 'the daemon was unreachable', next: 'e retries' })
    }
    peekOpInFlight.current.delete('row:effort')
    refresh()
  })()
}
