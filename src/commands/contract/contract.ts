import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import type { SessionContractV1 } from '../../daemon/sessionContract.js'

/**
 * `/contract` — the operator's own door onto the session's ADVISORY contract
 * (coordinator-tooling ledger T2: "when I start the lane… I could just do
 * slash contract"), any time — start of a lane or mid-session. Everything
 * rides the daemon's ONE contract verb (sessionControl action 'contract');
 * the show reads the session record off sessionList. Advisory always:
 * nothing here (or anywhere) gates on what the contract says.
 *
 *   /contract           show it (status · text · history); says so when none
 *   /contract <words>   none/closed/draft ⇒ set (draft); in force ⇒ amend
 *                       (history kept, the worker re-acknowledges)
 *   /contract close     close it — text and history kept (never deleted)
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args?: string,
): Promise<null> {
  if (!hasFocusedSession()) {
    onDone('No chat is open — /contract works on the focused session.', { display: 'system' })
    return null
  }
  const sessionId = getFocusedSessionConnector().sessionId()
  const words = (args ?? '').trim()

  const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
  const readContract = async (): Promise<{ found: boolean; contract?: SessionContractV1 }> => {
    const reply = (await daemonControlRpc({ op: 'sessionList' } as never, { timeoutMs: 10_000 })) as {
      ok?: boolean
      workers?: ReadonlyArray<Record<string, unknown>>
    }
    if (reply.ok !== true || !Array.isArray(reply.workers)) return { found: false }
    const rec = reply.workers.find(w => w.sessionId === sessionId && w.endedAt === undefined)
    if (rec === undefined) return { found: false }
    const c = rec.contract as SessionContractV1 | undefined
    return { found: true, ...(c !== undefined ? { contract: c } : {}) }
  }
  const sendOp = async (op: 'set' | 'ack' | 'amend' | 'close', text?: string): Promise<{ ok: boolean; outcome?: string; detail?: string }> => {
    const reply = (await daemonControlRpc(
      { op: 'sessionControl', action: 'contract', sessionId, by: 'operator', contract: { op, ...(text !== undefined ? { text } : {}) } } as never,
      { timeoutMs: 10_000 },
    )) as { ok?: boolean; outcome?: string; detail?: string }
    return { ok: reply.ok === true, ...(reply.outcome !== undefined ? { outcome: reply.outcome } : {}), ...(reply.detail !== undefined ? { detail: reply.detail } : {}) }
  }

  try {
    const standing = await readContract()
    if (!standing.found) {
      onDone('This chat is not a daemon-hosted session — contracts ride the session record; a board-born or entered session carries one.', { display: 'system' })
      return null
    }

    // /contract — SHOW.
    if (words === '') {
      const c = standing.contract
      if (c === undefined) {
        onDone('No contract — /contract <words> drafts one (the concourse New Session offer and the coordinator are the other doors). Advisory always: it encourages, never fences.', { display: 'system' })
        return null
      }
      const history = c.amendments.length > 0 ? ` · ${c.amendments.length} superseded text${c.amendments.length === 1 ? '' : 's'} kept` : ''
      const ack = c.ackAt !== undefined ? ` · acknowledged ${new Date(c.ackAt).toLocaleString()}` : ''
      onDone(`Contract [${c.status}]${ack}${history}\n\n${c.text}`, { display: 'system' })
      return null
    }

    // /contract close — the close op (text and history kept; never deleted).
    if (words.toLowerCase() === 'close') {
      const r = await sendOp('close')
      onDone(r.ok && (r.outcome === 'applied' || r.outcome === 'noop') ? (r.detail ?? 'closed') : `Not closed — ${r.detail ?? 'the daemon refused it'}`, { display: 'system' })
      return null
    }

    // /contract <words> — draft (set) when nothing stands in force; amend
    // (history kept, re-ack owed) when the worker acknowledged one.
    const inForce = standing.contract !== undefined && standing.contract.status !== 'draft' && standing.contract.status !== 'closed'
    const r = await sendOp(inForce ? 'amend' : 'set', words)
    if (r.ok && r.outcome === 'applied') {
      onDone(inForce ? `Amended — ${r.detail ?? 'the worker re-acknowledges through its contract tool'}` : `Contract drafted — the session's agent acknowledges it in its own words through its contract tool.`, { display: 'system' })
    } else {
      onDone(`The contract was not ${inForce ? 'amended' : 'set'} — ${r.detail ?? 'the daemon refused it'}`, { display: 'system' })
    }
  } catch {
    onDone('The contract door was unreachable — the daemon that hosts sessions is not running.', { display: 'system' })
  }
  return null
}
