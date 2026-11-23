import type { ToolUseContext } from '../../tools/kit/tool.js'
import { cloneFileStateCache, createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from '../../platform/files/fileStateCache.js'
import { cloneContentReplacementState } from '../tool-dispatch/toolResultStorage.js'
import { APIUserAbortError } from '../request-parts/sdkErrors.js'

function cloneReadFileState(source: ToolUseContext['readFileState']): ToolUseContext['readFileState'] {
  if (typeof source.dump === 'function') return cloneFileStateCache(source)
  const copy = createFileStateCacheWithSizeLimit(Math.max(READ_FILE_STATE_CACHE_SIZE, source.size))
  for (const [path, state] of source.entries()) copy.set(path, state)
  return copy
}

export function prepareFoldContext(context: ToolUseContext): { context: ToolUseContext; commit: (folded?: ReadonlyMap<string, string>) => void } {
  const readFileState = cloneReadFileState(context.readFileState)
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
    commit: (folded?: ReadonlyMap<string, string>) => {
      if (context.abortController.signal.aborted) throw new APIUserAbortError()
      context.readFileState.clear()
      for (const [path, state] of staged.readFileState.entries()) context.readFileState.set(path, state)
      for (const key of ['loadedNestedMemoryPaths', 'nestedMemoryAttachmentTriggers', 'dynamicSkillDirTriggers', 'discoveredSkillNames'] as const) {
        context[key]?.clear()
        for (const value of staged[key]) context[key]?.add(value)
      }
      if (folded !== undefined && context.contentReplacementState !== undefined) {
        for (const [toolUseId, replacement] of folded) {
          context.contentReplacementState.seenIds.add(toolUseId)
          context.contentReplacementState.replacements.set(toolUseId, replacement)
        }
      }
    },
  }
}
