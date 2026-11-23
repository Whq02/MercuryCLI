import { RUNNER_PROTOCOL, methodsFrom, type Capabilities, type FileCheckpointsFact, type HostNotificationName, type HostRequestName, type InitializeParams, type InitializeResult, type ParamsOf, type ResultOf } from '../runner-wire/methods.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import { refused } from '../runner-wire/errors.js'
import type { Peer } from '../runner-wire/peer.js'

type RequestRef = { id: number }

type Arm<M extends HostRequestName> = (params: ParamsOf<M>, ref: RequestRef, signal: AbortSignal) => Promise<ResultOf<M>> | ResultOf<M>
type NotificationArm<M extends HostNotificationName> = (params: ParamsOf<M>) => void | Promise<void>

type InitializeName = typeof SESSION_VERBS.initialize.runner.name
type CancelRequestName = typeof SESSION_VERBS.cancelRequest.runner.name

type RequestArms = { [M in Exclude<HostRequestName, InitializeName>]: Arm<M> }
type NotificationArms = { [M in Exclude<HostNotificationName, CancelRequestName>]: NotificationArm<M> }

export type RunnerArms = RequestArms & NotificationArms

export const RUNNER_REQUEST_METHODS = methodsFrom('host', 'request')
  .map(spec => spec.name)
  .filter(name => name !== SESSION_VERBS.initialize.runner.name) as Exclude<HostRequestName, InitializeName>[]
export const RUNNER_NOTIFICATION_METHODS = methodsFrom('host', 'notification')
  .map(spec => spec.name)
  .filter(name => name !== SESSION_VERBS.cancelRequest.runner.name) as Exclude<HostNotificationName, CancelRequestName>[]

function bindRequest<M extends Exclude<HostRequestName, InitializeName>>(peer: Peer, armsOf: () => RequestArms, name: M): void {
  peer.onRequest(name, (params, ctx) => armsOf()[name](params, { id: ctx.id }, ctx.signal))
}

function bindNotification<M extends Exclude<HostNotificationName, CancelRequestName>>(peer: Peer, armsOf: () => NotificationArms, name: M): void {
  peer.onNotification(name, params => armsOf()[name](params))
}

export function bindRunnerMethods(peer: Peer, armsOf: () => RunnerArms): void {
  for (const name of RUNNER_REQUEST_METHODS) bindRequest(peer, armsOf, name)
  for (const name of RUNNER_NOTIFICATION_METHODS) bindNotification(peer, armsOf, name)
}

export const DEFAULT_CAPABILITIES: Capabilities = { holds_asks: false, elicitation: false, partial_rows: false }

export function initializeResultOf(sessionId: string | null, fileCheckpoints: FileCheckpointsFact): InitializeResult {
  return { protocol: RUNNER_PROTOCOL, runner: { version: MACRO.VERSION, pid: process.pid }, session_id: sessionId, file_checkpoints: fileCheckpoints }
}

export function checkProtocol(params: InitializeParams): void {
  if (params.protocol !== RUNNER_PROTOCOL) {
    throw refused(`this runner speaks protocol ${RUNNER_PROTOCOL}; the host asked for ${params.protocol}`, 'protocol', { protocol: RUNNER_PROTOCOL })
  }
}
