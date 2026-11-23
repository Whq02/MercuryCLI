import { getGitStatus, getSystemContext, getUserContext } from '../../context.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { clearSessionMessagesCache } from '../../utils/sessionStorage/logs.js'
import { resetInstructionFilesCache } from '../instructions/engine.js'
import type { OwnerKey } from '../../utils/run/ownerKey.js'
import { processMainOwner, processOwnerForLane } from '../../utils/run/resolveOwner.js'
import { resetMicrocompactState } from './microCompact.js'
import type { Message } from '../../types/message.js'
import { restoreBoundPrefixFromMessages } from '../providers/anthropic/boundPrefixRecord.js'


type PostCompactScope = {
  querySource?: string
  owner?: OwnerKey
  agentId?: string
}

type QuerySource = string

const MAIN_THREAD_PREFIX = 'main_thread'

export function runPostCompactCleanup(scope?: QuerySource | PostCompactScope, preservedMessages?: readonly Message[]): void {
  const normalized: PostCompactScope =
    typeof scope === 'string' ? { querySource: scope } : (scope ?? {})
  const { querySource, agentId } = normalized
  const isMainThread =
    agentId === undefined &&
    (querySource === undefined ||
      querySource.startsWith(MAIN_THREAD_PREFIX) ||
      querySource === 'sdk')
  const owner: OwnerKey =
    normalized.owner ??
    (isMainThread
      ? processMainOwner()
      : processOwnerForLane(agentId ?? querySource ?? null))

  resetMicrocompactState(owner)

  if (!isMainThread) {
    if (preservedMessages !== undefined) {
      restoreBoundPrefixFromMessages(preservedMessages, { rosterOnly: true, fold: true })
    }
    return
  }

  getGitStatus.cache.clear?.()
  getSystemContext.cache.clear?.()
  getUserContext.cache.clear?.()
  resetInstructionFilesCache('compact')
  clearSystemPromptSections()
  clearSessionMessagesCache()
  if (preservedMessages !== undefined) {
    restoreBoundPrefixFromMessages(preservedMessages, { fold: true })
  }
}
