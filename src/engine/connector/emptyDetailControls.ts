import { SESSION_VERBS, type SessionVerbRow } from '../../daemon/runner-wire/sessionVerbs.js'
import type { AgentControlReceiptV1, EmptyDetailControlVerbKey } from './types.js'

const SESSION_CONTROL_OP = SESSION_VERBS.sessionControl.daemon.op

export function registeredEmptyDetailAction(key: string): string | null {
  if (!Object.hasOwn(SESSION_VERBS, key)) return null
  const row: SessionVerbRow = SESSION_VERBS[key as keyof typeof SESSION_VERBS]
  if (row.carrier !== 'empty-detail') return null
  if (row.daemon?.op !== SESSION_CONTROL_OP || typeof row.daemon.action !== 'string' || row.daemon.action === '') return null
  if (row.runner?.from !== 'host' || row.runner.kind !== 'request') return null
  return row.daemon.action
}

export function installEmptyDetailControlMethods<T extends object>(
  prototype: T,
  invoke: (self: T, key: EmptyDetailControlVerbKey) => Promise<AgentControlReceiptV1>,
): void {
  for (const key of Object.keys(SESSION_VERBS)) {
    if (registeredEmptyDetailAction(key) === null) continue
    if (Object.hasOwn(prototype, key)) continue
    const verb = key as EmptyDetailControlVerbKey
    Object.defineProperty(prototype, verb, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(this: T): Promise<AgentControlReceiptV1> {
        return invoke(this, verb)
      },
    })
  }
}
