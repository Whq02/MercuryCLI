import { getSessionId } from '../../bootstrap/state.js'
import { childRowsOf } from '../../rows/child.js'
import type { Message } from '../../types/message.js'
import { enqueueRow } from '../sdkEventQueue.js'

export function emitBackgroundAgentRows(parentToolUseId: string | undefined, message: Message): void {
  if (parentToolUseId === undefined || parentToolUseId === '') return
  const scope = { session_id: getSessionId(), parent_call_id: parentToolUseId }
  for (const row of childRowsOf(scope, message)) enqueueRow(row)
}
