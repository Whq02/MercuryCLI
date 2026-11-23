
import type { SessionId } from '../../../sessions/transcripts/ids.js'
import type { MessageOrigin } from '../../../engine/message-shapes/message.js'
import type { QueuedCommand } from './textInput.js'

export type QueueOperation =
  | 'enqueue'
  | 'dequeue'
  | 'remove'
  | 'popAll'
  | 'pop'
  | 'restage'

export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: SessionId
  content?: string
  commandUuid?: string
  mode?: string
  isMeta?: boolean
  sentAt?: string
  origin?: MessageOrigin
  agentCompletion?: QueuedCommand['agentCompletion']
}
