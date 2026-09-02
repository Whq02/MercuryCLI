import type * as React from 'react'

import { jsonParse } from '../../utils/slowOperations.js'
import type { Output } from './TeamDeleteTool.js'

/** A fixed short phrase — the input carries nothing worth showing. */
export function renderToolUseMessage(): React.ReactNode {
  return 'Cleaning up the current team'
}

/**
 * Deliberately renders NOTHING for the result in every branch — a batched
 * shutdown message covers it elsewhere. The shaped-result branch is still
 * tested (string results still go through the JSON parser) so the contract
 * with persisted results survives; do not "improve" this into a visible
 * card.
 */
export function renderToolResultMessage(output: Output | string): React.ReactNode {
  const parsed = typeof output === 'string' ? (jsonParse(output) as Output | null) : output
  if (parsed && typeof parsed === 'object' && 'success' in parsed) {
    return null
  }
  return null
}
