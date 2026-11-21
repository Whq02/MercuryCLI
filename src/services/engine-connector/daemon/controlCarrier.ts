import { SESSION_VERBS, type SessionVerbRow } from '../../../runner/wire/sessionVerbs.js'
import type { KitDialReceiptV1 } from '../types.js'

type SessionVerbKey = keyof typeof SESSION_VERBS
type SessionControlOp = typeof SESSION_VERBS.sessionControl.daemon.op

type ControlVerbKey = {
  [K in SessionVerbKey]: (typeof SESSION_VERBS)[K] extends { readonly daemon: { readonly op: SessionControlOp; readonly action: string } } ? K : never
}[SessionVerbKey]

type ControlRpc = (req: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>

const SESSION_CONTROL_OP: SessionControlOp = SESSION_VERBS.sessionControl.daemon.op

function registeredControlAction(key: string): string | null {
  if (!Object.hasOwn(SESSION_VERBS, key)) return null
  const row: SessionVerbRow = SESSION_VERBS[key as SessionVerbKey]
  if (row.daemon?.op !== SESSION_CONTROL_OP || typeof row.daemon.action !== 'string' || row.daemon.action === '') return null
  return row.daemon.action
}

export function controlFrame(key: ControlVerbKey, sessionId: string, fields?: Record<string, unknown>): Record<string, unknown> {
  const action = registeredControlAction(key)
  if (action === null) throw new Error(`unregistered control verb: ${String(key)}`)
  return {
    op: SESSION_CONTROL_OP,
    action,
    sessionId,
    by: 'operator',
    ...(fields ?? {}),
  }
}

export async function sendDialReceipt(
  chainRpc: ControlRpc,
  sessionId: string,
  key: ControlVerbKey,
  fields: Record<string, unknown>,
  words: { refused: string; unreachable: string; onSettled?: () => void; log: (line: string) => void },
): Promise<KitDialReceiptV1> {
  const action = registeredControlAction(key)
  if (action === null) return { outcome: 'refused', detail: `unregistered control verb: ${String(key)}` }
  try {
    const reply = await chainRpc(controlFrame(key, sessionId, fields))
    if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? words.refused) }
    const outcome = reply.outcome
    if (outcome === 'applied' || outcome === 'queued' || outcome === 'noop' || outcome === 'refused') {
      words.onSettled?.()
      return { outcome, ...(typeof reply.detail === 'string' && reply.detail !== '' ? { detail: reply.detail } : {}) }
    }
    return { outcome: 'refused', detail: `unexpected outcome ${String(outcome)}` }
  } catch (e) {
    words.log(`[engine-connector] daemon ${action} failed: ${e}`)
    return { outcome: 'refused', detail: words.unreachable }
  }
}
