import { getGitStatus, getSystemContext, getUserContext } from '../requestContext.js'
import { clearSystemPromptSections } from '../system-prompt/systemPromptSections.js'
import { clearSessionMessagesCache } from '../../sessions/transcripts/sessionListings.js'
import { resetInstructionFilesCache } from '../../sessions/instructions/instructionFiles.js'
import type { Message } from '../message-shapes/message.js'
import { restoreBoundPrefixFromMessages } from '../../models/roads/anthropic/boundPrefixRecord.js'


type PostFoldScope = {
  querySource?: string
  agentId?: string
}

type QuerySource = string

const MAIN_THREAD_PREFIX = 'main_thread'

export function runPostFoldCleanup(scope?: QuerySource | PostFoldScope, preservedMessages?: readonly Message[]): void {
  const normalized: PostFoldScope =
    typeof scope === 'string' ? { querySource: scope } : (scope ?? {})
  const { querySource, agentId } = normalized
  const isMainThread =
    agentId === undefined &&
    (querySource === undefined ||
      querySource.startsWith(MAIN_THREAD_PREFIX) ||
      querySource === 'sdk')
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
