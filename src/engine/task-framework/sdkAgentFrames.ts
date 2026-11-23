import { getSessionId } from '../../boot/process-state/processState.js'
import { childRowsOf } from '../rows/child.js'
import type { Message } from '../message-shapes/message.js'
import { enqueueRow } from '../../daemon/runner/sdkEventQueue.js'

export function emitBackgroundAgentRows(parentToolUseId: string | undefined, message: Message): void {
  if (parentToolUseId === undefined || parentToolUseId === '') return
  const scope = { session_id: getSessionId(), parent_call_id: parentToolUseId }
  for (const row of childRowsOf(scope, message)) enqueueRow(row)
}
