// ============================================================================
//  utils/messageQueueManager.ts — COMPAT SHIM (native-core S1).
//
//  The queue's owner is src/input-core/command-queue.ts; this module keeps
//  the import path its consumers use. Pure re-exports — no state, no logic
//  (the module state lives in the owner, so both import paths see the ONE
//  queue). The pen-facing surface (pop-to-composer, restage, counts,
//  clears, the deprecated notification aliases) died with the
//  steer-removal ruling.
// ============================================================================
export {
  type SetAppState,
  subscribeToCommandQueue,
  getCommandQueueSnapshot,
  getCommandQueue,
  peek,
  enqueue,
  enqueuePendingNotification,
  rekeyCommandQueueToSession,
  dequeue,
  dequeueAll,
  dequeueAllMatching,
  remove,
  getDrainableCommands,
  markDraining,
  resetCommandQueue,
  isSlashCommand,
} from '../input-core/command-queue.js'
