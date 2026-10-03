import { randomUUID } from 'node:crypto'
import { getSessionId } from '../../bootstrap/state.js'
import { EMPTY_USAGE } from '../../services/api/emptyUsage.js'
import { createRowStamper, outcomeRow } from '../../rows/project.js'
import type { ErrorClass, OutcomeRow, OutcomeStatus } from '../../rows/vocabulary.js'

export function refusedOutcome(messages: string[], errorClass: ErrorClass = 'option', status: OutcomeStatus = 'refused'): OutcomeRow {
  const [message = 'The request was refused', ...detail] = messages
  return createRowStamper().stamp(
    outcomeRow(
      { session_id: getSessionId(), turn: 1 },
      {
        turnId: randomUUID(),
        status,
        steps: 0,
        wallMs: 0,
        usage: EMPTY_USAGE,
        models: {},
        denials: [],
        error: { message, class: errorClass, ...(detail.length > 0 ? { detail } : {}) },
      },
    ),
  )
}
