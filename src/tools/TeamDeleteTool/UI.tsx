import type * as React from 'react'

import { jsonParse } from '../../utils/slowOperations.js'
import type { Output } from './TeamDeleteTool.js'

export function renderToolUseMessage(): React.ReactNode {
  return 'Cleaning up the current team'
}

export function renderToolResultMessage(output: Output | string): React.ReactNode {
  const parsed = typeof output === 'string' ? (jsonParse(output) as Output | null) : output
  if (parsed && typeof parsed === 'object' && 'success' in parsed) {
    return null
  }
  return null
}
