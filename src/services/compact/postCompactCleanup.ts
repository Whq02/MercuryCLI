import { getUserContext } from '../../context.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { clearSpeculativeChecks } from '../../tools/BashTool/bashPermissions.js'
import { clearClassifierApprovals } from '../../utils/classifierApprovals.js'
import { clearSessionMessagesCache } from '../../utils/sessionStorage/logs.js'
import { resetInstructionFilesCache } from '../instructions/engine.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { processMainOwner, processOwnerForLane } from '../run/resolveOwner.js'
import { resetMicrocompactState } from './microCompact.js'


export type PostCompactScope = {
  querySource?: string
  owner?: OwnerKey
  agentId?: string
}

type QuerySource = string

const MAIN_THREAD_PREFIX = 'repl_main_thread'

function isMainThreadCompaction(querySource: string | undefined): boolean {
  return (
    querySource === undefined ||
    querySource.startsWith(MAIN_THREAD_PREFIX) ||
    querySource === 'sdk'
  )
}

export function runPostCompactCleanup(scope?: QuerySource | PostCompactScope): void {
  const normalized: PostCompactScope = typeof scope === 'string' ? { querySource: scope } : (scope ?? {})
  const mainThread = isMainThreadCompaction(normalized.querySource)

  const owner =
    normalized.owner ??
    (mainThread
      ? processMainOwner()
      : processOwnerForLane(normalized.agentId ?? normalized.querySource ?? null))

  resetMicrocompactState(owner)

  if (!mainThread) return

  getUserContext.cache?.clear?.()
  resetInstructionFilesCache('compact')
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  clearSessionMessagesCache()
}
