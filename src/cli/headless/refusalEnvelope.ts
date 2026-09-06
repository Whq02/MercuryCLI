import { randomUUID } from 'node:crypto'
import { getSessionId } from '../../bootstrap/state.js'
import { EMPTY_USAGE } from '../../services/api/emptyUsage.js'

export type RefusalEnvelope = {
  type: 'result'
  subtype: 'error_during_execution'
  duration_ms: 0
  duration_api_ms: 0
  is_error: true
  num_turns: 0
  stop_reason: null
  session_id: string
  total_cost_usd: 0
  usage: typeof EMPTY_USAGE
  model_usage: Record<string, never>
  permission_denials: never[]
  uuid: string
  errors: string[]
}

export function refusalEnvelope(errors: string[]): RefusalEnvelope {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    session_id: getSessionId(),
    total_cost_usd: 0,
    usage: EMPTY_USAGE,
    model_usage: {},
    permission_denials: [],
    uuid: randomUUID(),
    errors,
  }
}
