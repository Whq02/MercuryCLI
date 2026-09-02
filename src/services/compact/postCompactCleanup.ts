import { getUserContext } from '../../context.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { clearSpeculativeChecks } from '../../tools/BashTool/bashPermissions.js'
import { clearClassifierApprovals } from '../../utils/classifierApprovals.js'
import { clearSessionMessagesCache } from '../../utils/sessionStorage/logs.js'
import { resetInstructionFilesCache } from '../instructions/engine.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { processMainOwner, processOwnerForLane } from '../run/resolveOwner.js'
import { resetMicrocompactState } from './microCompact.js'

/**
 * Resets the caches and tracking state a compaction invalidated, scoped to
 * the compacting lane. A subagent compacting in the same process must never
 * clear the main conversation's caches.
 *
 * Deliberate non-resets: invoked-skill content and sent-skill tracking
 * survive across compactions — skill content must keep feeding the skills
 * attachment, and re-sending the skill listing is pure cache-creation cost.
 */

export type PostCompactScope = {
  querySource?: string
  owner?: OwnerKey
  agentId?: string
}

type QuerySource = string

const MAIN_THREAD_PREFIX = 'repl_main_thread'

function isMainThreadCompaction(querySource: string | undefined): boolean {
  // Absent is only passed by genuinely main-thread callers (/compact,
  // /clear).
  return (
    querySource === undefined ||
    querySource.startsWith(MAIN_THREAD_PREFIX) ||
    querySource === 'sdk'
  )
}

export function runPostCompactCleanup(scope?: QuerySource | PostCompactScope): void {
  // A bare string is normalised into the object form at the boundary.
  const normalized: PostCompactScope = typeof scope === 'string' ? { querySource: scope } : (scope ?? {})
  const mainThread = isMainThreadCompaction(normalized.querySource)

  const owner =
    normalized.owner ??
    (mainThread
      ? processMainOwner()
      : processOwnerForLane(normalized.agentId ?? normalized.querySource ?? null))

  // ALWAYS: the owner-scoped microcompact reset — never a cross-lane reset.
  resetMicrocompactState(owner)

  if (!mainThread) return

  // Process-shared main-thread caches, both required and in this order: the
  // user-context memo sits OUTSIDE instruction composition, so clearing the
  // inner cache alone leaves the next turn answered from the outer memo.
  getUserContext.cache?.clear?.()
  resetInstructionFilesCache('compact')
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  clearSessionMessagesCache()
}
