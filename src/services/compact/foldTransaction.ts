import type { ToolUseContext } from '../../Tool.js'
import { cloneFileStateCache } from '../../utils/fileStateCache.js'
import { cloneContentReplacementState } from '../../utils/toolResultStorage.js'
import { APIUserAbortError } from '../api/sdkErrors.js'

export function prepareFoldContext(context: ToolUseContext): { context: ToolUseContext; commit: () => void } {
  const readFileState = typeof context.readFileState.dump === 'function'
    ? cloneFileStateCache(context.readFileState)
    : new Map(context.readFileState.entries()) as unknown as ToolUseContext['readFileState']
  const staged = {
    ...context,
    readFileState,
    contentReplacementState: context.contentReplacementState ? cloneContentReplacementState(context.contentReplacementState) : undefined,
    loadedNestedMemoryPaths: new Set(context.loadedNestedMemoryPaths),
    nestedMemoryAttachmentTriggers: new Set(context.nestedMemoryAttachmentTriggers),
    dynamicSkillDirTriggers: new Set(context.dynamicSkillDirTriggers),
    discoveredSkillNames: new Set(context.discoveredSkillNames),
  }
  return {
    context: staged,
    commit: () => {
      if (context.abortController.signal.aborted) throw new APIUserAbortError()
      context.readFileState.clear()
      for (const [path, state] of staged.readFileState.entries()) context.readFileState.set(path, state)
      for (const key of ['loadedNestedMemoryPaths', 'nestedMemoryAttachmentTriggers', 'dynamicSkillDirTriggers', 'discoveredSkillNames'] as const) {
        context[key]?.clear()
        for (const value of staged[key]) context[key]?.add(value)
      }
    },
  }
}
