import { randomUUID } from 'node:crypto'
import { getSessionId } from '../../boot/process-state/processState.js'
import { EMPTY_USAGE } from '../../engine/request-parts/emptyUsage.js'
import { createRowStamper, outcomeRow } from '../../engine/rows/project.js'
import type { ErrorClass, OutcomeRow, OutcomeStatus } from '../../engine/rows/vocabulary.js'

export function formatPrintsOutcomeRow(format: string | undefined): boolean {
  return format === 'rows' || format === 'json'
}

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
