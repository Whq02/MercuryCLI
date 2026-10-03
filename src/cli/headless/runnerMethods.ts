import { RUNNER_PROTOCOL, methodsFrom, type Capabilities, type HostNotificationName, type HostRequestName, type InitializeParams, type InitializeResult, type ParamsOf, type ResultOf } from '../../runner/wire/methods.js'
import { refused } from '../../runner/wire/errors.js'
import type { Peer } from '../../runner/wire/peer.js'

export type RequestRef = { id: number | string }

export type Arm<M extends HostRequestName> = (params: ParamsOf<M>, ref: RequestRef, signal: AbortSignal) => Promise<ResultOf<M>> | ResultOf<M>
export type NotificationArm<M extends HostNotificationName> = (params: ParamsOf<M>) => void | Promise<void>

export type RunnerArms = { [M in Exclude<HostRequestName, 'initialize'>]: Arm<M> } & { [M in Exclude<HostNotificationName, '$/cancel_request'>]: NotificationArm<M> }

export const RUNNER_REQUEST_METHODS = methodsFrom('host', 'request')
  .map(spec => spec.name)
  .filter(name => name !== 'initialize') as Exclude<HostRequestName, 'initialize'>[]
export const RUNNER_NOTIFICATION_METHODS = methodsFrom('host', 'notification')
  .map(spec => spec.name)
  .filter(name => name !== '$/cancel_request') as Exclude<HostNotificationName, '$/cancel_request'>[]

export function bindRunnerMethods(peer: Peer, armsOf: () => RunnerArms): void {
  for (const name of RUNNER_REQUEST_METHODS) {
    peer.onRequest(name, (params, ctx) => (armsOf()[name] as Arm<typeof name>)(params as never, { id: ctx.id }, ctx.signal) as never)
  }
  for (const name of RUNNER_NOTIFICATION_METHODS) {
    peer.onNotification(name, params => (armsOf()[name] as NotificationArm<typeof name>)(params as never))
  }
}

export const DEFAULT_CAPABILITIES: Capabilities = { holds_asks: false, elicitation: false, partial_rows: false }

export function initializeResultOf(sessionId: string | null): InitializeResult {
  return { protocol: RUNNER_PROTOCOL, runner: { version: MACRO.VERSION, pid: process.pid }, session_id: sessionId }
}

export function checkProtocol(params: InitializeParams): void {
  if (params.protocol !== RUNNER_PROTOCOL) {
    throw refused(`this runner speaks protocol ${RUNNER_PROTOCOL}; the host asked for ${params.protocol}`, 'protocol', { protocol: RUNNER_PROTOCOL })
  }
}
