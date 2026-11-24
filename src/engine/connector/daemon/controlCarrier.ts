import { SESSION_VERBS, type SessionVerbRow } from '../../../daemon/runner-wire/sessionVerbs.js'
import { registeredEmptyDetailAction } from '../emptyDetailControls.js'
import type { CrewmateControlReceiptV1, EmptyDetailControlVerbKey, KitDialReceiptV1 } from '../types.js'

type SessionVerbKey = keyof typeof SESSION_VERBS
type SessionControlOp = typeof SESSION_VERBS.sessionControl.daemon.op

type ControlVerbKey = {
  [K in SessionVerbKey]: (typeof SESSION_VERBS)[K] extends { readonly daemon: { readonly op: SessionControlOp; readonly action: string } } ? K : never
}[SessionVerbKey]

type ControlRpc = (req: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>

type ControlExtraFields = Record<string, unknown> & {
  readonly op?: never
  readonly action?: never
  readonly sessionId?: never
  readonly by?: never
}

const SESSION_CONTROL_OP: SessionControlOp = SESSION_VERBS.sessionControl.daemon.op

function registeredControlAction(key: string): string | null {
  if (!Object.hasOwn(SESSION_VERBS, key)) return null
  const row: SessionVerbRow = SESSION_VERBS[key as SessionVerbKey]
  if (row.daemon?.op !== SESSION_CONTROL_OP || typeof row.daemon.action !== 'string' || row.daemon.action === '') return null
  return row.daemon.action
}

export function controlFrame(key: ControlVerbKey, sessionId: string, fields?: ControlExtraFields): Record<string, unknown> {
  const action = registeredControlAction(key)
  if (action === null) throw new Error(`unregistered control verb: ${String(key)}`)
  if (fields !== undefined && (Object.hasOwn(fields, 'op') || Object.hasOwn(fields, 'action') || Object.hasOwn(fields, 'sessionId') || Object.hasOwn(fields, 'by'))) {
    throw new Error('controlFrame fields cannot override envelope keys')
  }
  return {
    op: SESSION_CONTROL_OP,
    action,
    sessionId,
    by: 'operator',
    ...(fields ?? {}),
  }
}

export async function sendControlReceipt(
  chainRpc: ControlRpc,
  sessionId: string,
  key: ControlVerbKey,
  fields?: ControlExtraFields,
  onApplied?: () => void,
): Promise<CrewmateControlReceiptV1> {
  const action = registeredControlAction(key)
  if (action === null) return { outcome: 'refused', detail: `unregistered control verb: ${String(key)}` }
  try {
    const reply = await chainRpc(controlFrame(key, sessionId, fields))
    if (reply.ok !== true) return { outcome: 'refused', detail: String(reply.error ?? 'the daemon refused the verb') }
    const detail = typeof reply.detail === 'string' ? reply.detail : undefined
    if (reply.outcome === 'applied') {
      onApplied?.()
      return { outcome: 'applied', ...(detail !== undefined ? { detail } : {}) }
    }
    return { outcome: 'refused', detail: detail ?? `unexpected outcome ${String(reply.outcome)}` }
  } catch (e) {
    return { outcome: 'refused', detail: `the daemon is not answering — ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function sendEmptyDetailControl(
  chainRpc: ControlRpc,
  sessionId: string,
  key: EmptyDetailControlVerbKey,
): Promise<CrewmateControlReceiptV1> {
  if (registeredEmptyDetailAction(key) === null) {
    return { outcome: 'refused', detail: `unregistered control verb: ${String(key)}` }
  }
  return sendControlReceipt(chainRpc, sessionId, key)
}

export async function sendDialReceipt(
  chainRpc: ControlRpc,
  sessionId: string,
  key: ControlVerbKey,
  fields: ControlExtraFields,
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
