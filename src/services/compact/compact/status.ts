import type { ToolUseContext, CompactProgressEvent } from '../../../Tool.js'
import { APIUserAbortError } from '../../../utils/api/sdkErrors.js'
import { FOLD_STAMP_THROTTLE_MS, type FoldExit, type FoldStatusV1, type FoldTrigger, beginFoldStatus, foldStatusExit, foldStatusOnEvent } from '../foldStatus.js'
import { ERROR_MESSAGE_USER_ABORT, isNothingToCompactMessage } from './limits.js'
import { startTimeout, stopTimeout } from '../../../utils/timers.js'
import { notBuilt } from '../../../pi/holes.js'

export function notifyCompactionError(context: ToolUseContext, err: unknown): void {
  return notBuilt('src/services/compact/compact/status.ts:7')
}

export function restoreAfterCompaction(context: ToolUseContext, word?: unknown): void {
  return notBuilt('src/services/compact/compact/status.ts:18')
}

export async function withFoldStatus<T, C extends ToolUseContext>(
  context: C,
  work: (scoped: C) => Promise<T>,
  facts: { trigger: FoldTrigger; sessionMemory: boolean; microcompaction: boolean },
): Promise<T> {
  return notBuilt('src/services/compact/compact/status.ts:25')
}


export function withEngineModel<C extends ToolUseContext>(context: C, model: string): C {
  return notBuilt('src/services/compact/compact/status.ts:89')
}
