/**
 * Types for the unified command-queue operation log.
 *
 * The message queue (`utils/messageQueueManager.ts`) records every mutation —
 * enqueue / dequeue / remove / popAll — as a `QueueOperationMessage` entry in
 * the session transcript (via `recordQueueOperation` → `insertQueueOperation`
 * → `appendEntry`). `QueueOperationMessage` is a member of the `Entry`
 * discriminated union in `types/logs.ts`, keyed on the `type` literal
 * `'queue-operation'`.
 */

import type { SessionId } from './ids.js'

/**
 * The kind of queue mutation being logged. One value per write path in
 * `messageQueueManager.ts`:
 *  - `'enqueue'` — a command was pushed onto the queue.
 *  - `'dequeue'` — a command was popped (highest-priority, FIFO within priority).
 *  - `'remove'`  — a command was removed by reference / predicate.
 *  - `'restage'` — a queued prompt moved between priority bands (the
 *    operator steered it into the running turn, or held it for the next
 *    one). The command stays in the queue; only its band changes.
 *  - `'popAll'`  — editable commands were drained back into the input buffer.
 */
export type QueueOperation =
  | 'enqueue'
  | 'dequeue'
  | 'remove'
  | 'popAll'
  | 'restage'

/**
 * A persisted record of a single command-queue operation.
 *
 * Discriminant: `type: 'queue-operation'` (its slot in the `Entry` union).
 * `timestamp` is an ISO-8601 string (`new Date().toISOString()`); `sessionId`
 * is the branded session id from `getSessionId()`. `content` is the operation's
 * payload text — present only when the command value was a string (enqueue /
 * popAll carry it; dequeue / remove do not), so it is optional.
 */
export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: SessionId
  content?: string
}
