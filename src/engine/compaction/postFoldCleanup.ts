import { getGitStatus, getSystemContext, getUserContext } from '../requestContext.js'
import { clearSystemPromptSections } from '../system-prompt/systemPromptSections.js'
import { clearSessionMessagesCache } from '../../sessions/transcripts/sessionListings.js'
import { resetInstructionFilesCache } from '../../sessions/instructions/instructionFiles.js'
import type { OwnerKey } from '../run-owner/ownerKey.js'
import { processMainOwner, processOwnerForLane } from '../run-owner/resolveOwner.js'
import { resetMicrocompactState } from './pruneToolResults.js'
import type { Message } from '../message-shapes/message.js'
import { restoreBoundPrefixFromMessages } from '../../models/roads/anthropic/boundPrefixRecord.js'


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
