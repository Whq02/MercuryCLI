import type { ParamsOf, ResultOf } from '../runner-wire/methods.js'
import { isRpcError, RPC_METHOD_NOT_FOUND } from '../runner-wire/errors.js'
import { PeerClosed, PeerDeadline, type RequestOptions } from '../runner-wire/peer.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import type { Verb } from '../runner-link/runnerConnection.js'
import type { SeatRosterPort } from './state.js'

export function relayCredentialChange(
  roster: Pick<SeatRosterPort, 'door'> & { liveWorkerFacts(): ReadonlyArray<{ short: string; kind: 'long-lived' | 'one-shot' }> },
): string[] {
  const told: string[] = []
  for (const worker of roster.liveWorkerFacts()) {
    if (worker.kind !== 'long-lived') continue
    const door = roster.door(worker.short)
    if (door === undefined || door.closed) continue
    door.notify(SESSION_VERBS.credentialsChanged.runner.name, {})
    told.push(worker.short)
  }
  return told
}

export type DoorFailure = { kind: 'left' | 'silent' | 'older' | 'refused'; words: string }

export function doorFailureOf(error: unknown, verb: string, deadlineMs: number): DoorFailure {
  if (error instanceof PeerClosed) return { kind: 'left', words: `the session's runner left before it answered the ${verb}` }
  if (error instanceof PeerDeadline) return { kind: 'silent', words: `the session's runner did not answer the ${verb} within ${Math.round(deadlineMs / 1000)}s` }
  if (isRpcError(error) && error.code === RPC_METHOD_NOT_FOUND) return { kind: 'older', words: `the session's runner predates the ${verb}` }
  const words = error instanceof Error && error.message !== '' ? error.message : `the runner refused the ${verb}`
  return { kind: 'refused', words }
}

export const NO_DOOR_DETAIL = 'the session has no live runner door'

export function runnerAnswered(asked: { ok: true } | { ok: false; failure: DoorFailure }): boolean {
  return asked.ok || (asked.failure.kind !== 'silent' && asked.failure.kind !== 'left')
}

export async function askSeat<M extends Verb>(
  roster: Pick<SeatRosterPort, 'door'>,
  short: string,
  method: M,
  params: ParamsOf<M>,
  verb: string,
  deadlineMs: number,
  opts?: Pick<RequestOptions, 'signal'>,
): Promise<{ ok: true; result: ResultOf<M>; id: number } | { ok: false; failure: DoorFailure; id: number | null }> {
  const door = roster.door(short)
  if (door === undefined || door.closed) return { ok: false, failure: { kind: 'left', words: NO_DOOR_DETAIL }, id: null }
  const sent = door.send(method, params, { deadlineMs, ...(opts?.signal !== undefined ? { signal: opts.signal } : {}) })
  try {
    return { ok: true, result: await sent.answer, id: sent.id }
  } catch (error) {
    return { ok: false, failure: doorFailureOf(error, verb, deadlineMs), id: sent.id }
  }
}

export type SeatVerbOutcome = { outcome: 'applied' | 'queued' | 'noop' | 'refused'; detail?: string; respawned?: true }

export const SEAT_VERB_ANSWER_DEADLINE_MS = SESSION_VERBS.setModel.runner.deadlineMs

type SeatVerbAnswer = { at: 'now' | 'turn_end'; model?: string; id: number } | { refused: string } | { silent: true }

export function seatVerbAnswerOf(asked: Awaited<ReturnType<typeof askSeat<typeof SESSION_VERBS.setModel.runner.name | typeof SESSION_VERBS.setEffort.runner.name | typeof SESSION_VERBS.setSpawnSwitch.runner.name>>>): SeatVerbAnswer {
  if (asked.ok) {
    const model = 'model' in asked.result && asked.result.model !== '' ? { model: asked.result.model } : {}
    return { at: asked.result.at, ...model, id: asked.id }
  }
  if (asked.failure.kind === 'left' || asked.failure.kind === 'silent') return { silent: true }
  return { refused: asked.failure.words }
}
