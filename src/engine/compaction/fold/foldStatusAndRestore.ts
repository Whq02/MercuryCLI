import type { ToolUseContext, CompactProgressEvent } from '../../../tools/kit/tool.js'
import { APIUserAbortError } from '../../request-parts/sdkErrors.js'
import { FOLD_STAMP_THROTTLE_MS, type FoldExit, type FoldStatusV1, type FoldTrigger, beginFoldStatus, foldStatusExit, foldStatusOnEvent } from '../foldStatus.js'
import { ERROR_MESSAGE_USER_ABORT, isNothingToCompactMessage } from './foldLimits.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'

export function notifyCompactionError(context: ToolUseContext, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (message === ERROR_MESSAGE_USER_ABORT || isNothingToCompactMessage(message)) return
  context.addNotification?.({
    key: 'compact-error',
    text: `Compaction error: ${message}`,
    color: 'error',
    priority: 'immediate',
  })
}

export function restoreAfterCompaction(context: ToolUseContext, word: unknown = null): void {
  context.setStreamMode?.('requesting')
  context.setResponseLength?.(() => 0)
  context.onCompactProgress?.({ type: 'compact_end' })
  context.setSDKStatus?.(word)
}

export async function withFoldStatus<T, C extends ToolUseContext>(
  context: C,
  work: (scoped: C) => Promise<T>,
  facts: { trigger: FoldTrigger; sessionMemory: boolean; microcompaction: boolean },
): Promise<T> {
  let status: FoldStatusV1 = beginFoldStatus({ ...facts, startedAtMs: Date.now() })
  let chars = 0
  let pending: NodeJS.Timeout | null = null
  const send = (): void => {
    if (pending !== null) {
      stopTimeout(pending)
      pending = null
    }
    context.setSDKStatus?.({ compacting: status })
  }
  const stamp = (now: boolean): void => {
    if (context.setSDKStatus === undefined) return
    if (now) {
      send()
      return
    }
    if (pending !== null) return
    pending = startTimeout(send, FOLD_STAMP_THROTTLE_MS)
    pending.unref?.()
  }
  const onEvent = (event: CompactProgressEvent): void => {
    status = foldStatusOnEvent(status, event)
    stamp(event.type !== 'summary_progress')
  }
  const scoped: C = {
    ...context,
    setSDKStatus: (word: unknown) => {
      if (word === 'compacting') stamp(true)
      else if (word !== null) context.setSDKStatus?.(word)
    },
    onCompactProgress: (event: CompactProgressEvent) => {
      onEvent(event)
      context.onCompactProgress?.(event)
    },
    setResponseLength: (updater: (prev: number) => number) => {
      chars = Math.max(0, updater(chars))
      onEvent({ type: 'summary_progress', chars })
      context.setResponseLength?.(updater)
    },
  }
  stamp(true)
  let exit: FoldExit = 'landed'
  let reason: string | undefined
  try {
    return await work(scoped)
  } catch (err) {
    const aborted = context.abortController?.signal.aborted === true
    exit = aborted || err instanceof APIUserAbortError ? 'cancelled' : 'failed'
    reason = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    if (pending !== null) stopTimeout(pending)
    status = foldStatusExit(status, exit, Date.now(), reason)
    restoreAfterCompaction(context, isNothingToCompactMessage(reason ?? '') ? null : { compacting: status })
    if (facts.trigger !== 'manual') context.setSDKStatus?.(null)
  }
}


export function withEngineModel<C extends ToolUseContext>(context: C, model: string): C {
  return { ...context, options: { ...context.options, engineModel: model } }
}
