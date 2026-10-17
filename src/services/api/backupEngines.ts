import type { AssistantMessage, AssistantMessageError, FailoverCause } from '../../types/message.js'
import { renderModelName } from '../../utils/model/model.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { CallModelStream } from '../providers/callModelContract.js'
import { FallbackTriggeredError } from './withRetry.js'

const UNKNOWN_MODEL_CODES = new Set(['http-404', 'api-NOT_FOUND', 'zai-1211'])

const CAUSE_WORDS: Record<FailoverCause, string> = {
  overloaded: 'is overloaded',
  unreachable: 'cannot be reached',
  'sign-in': 'refused the sign-in',
  'unknown-model': 'is not a model its provider serves',
}

export function failoverCauseOf(error: AssistantMessageError | undefined, code: string | undefined, busy: boolean): FailoverCause | undefined {
  if (busy) return 'overloaded'
  if (error === 'authentication_failed') return 'sign-in'
  if (error === 'server_error') return 'unreachable'
  if (error === 'invalid_request' && code !== undefined && UNKNOWN_MODEL_CODES.has(code)) return 'unknown-model'
  return undefined
}

export function markUnknownModel<T extends AssistantMessage>(message: T, status: number | undefined): T {
  return status === 404 ? { ...message, failover: 'unknown-model' } : message
}

export function failoverCauseOfMessage(message: AssistantMessage): FailoverCause | undefined {
  if (message.isApiErrorMessage !== true) return undefined
  return message.failover ?? failoverCauseOf(message.error, message.errorDetails, message.busyRefusal !== undefined && message.busyRefusal !== null)
}

export function backupEngineLadder(flagModel: string | undefined): string[] {
  const setting = getInitialSettings().engine?.backups
  const configured = Array.isArray(setting) ? setting : []
  const out: string[] = []
  for (const raw of [flagModel, ...configured]) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

export interface EngineLadder {
  next(current: string): string | undefined
  take(engine: string): boolean
}

const laddersByTurn = new WeakMap<object, { engines: string[]; tried: Set<string> }>()

export function engineLadderOf(turn: object, flagModel: string | undefined): EngineLadder {
  let state = laddersByTurn.get(turn)
  if (state === undefined) {
    state = { engines: backupEngineLadder(flagModel), tried: new Set() }
    laddersByTurn.set(turn, state)
  }
  const ladder = state
  return {
    next(current) {
      ladder.tried.add(current)
      return ladder.engines.find(engine => !ladder.tried.has(engine))
    },
    take(engine) {
      if (!ladder.engines.includes(engine) || ladder.tried.has(engine)) return false
      ladder.tried.add(engine)
      return true
    },
  }
}

export function backupEngineNoticeLine(vote: { originalModel: string; fallbackModel: string; trigger: FailoverCause }): string {
  return `${renderModelName(vote.originalModel)} ${CAUSE_WORDS[vote.trigger]}; this turn runs on ${renderModelName(vote.fallbackModel)} instead`
}

export async function* withBackupVote(lane: CallModelStream, options: { model: string; fallbackModel?: string }): CallModelStream {
  const backup = options.fallbackModel
  if (backup === undefined || backup === options.model) {
    yield* lane
    return
  }
  let settled = false
  for await (const item of lane) {
    if ((item as { type?: string }).type === 'assistant') {
      const message = item as AssistantMessage
      if (message.isApiErrorMessage !== true) settled = true
      else if (!settled) {
        const cause = failoverCauseOfMessage(message)
        if (cause !== undefined) throw new FallbackTriggeredError(options.model, backup, cause)
      }
    }
    yield item
  }
}
