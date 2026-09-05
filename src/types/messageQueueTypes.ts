
import type { SessionId } from './ids.js'

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
}
