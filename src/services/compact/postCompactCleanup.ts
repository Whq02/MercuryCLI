import { getGitStatus, getSystemContext, getUserContext } from '../../context.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { clearSessionMessagesCache } from '../../utils/sessionStorage/logs.js'
import { resetInstructionFilesCache } from '../instructions/engine.js'
import type { OwnerKey } from '../../utils/run/ownerKey.js'
import { processMainOwner, processOwnerForLane } from '../../utils/run/resolveOwner.js'
import { resetMicrocompactState } from './microCompact.js'
import type { Message } from '../../types/message.js'
import { restoreBoundPrefixFromMessages } from '../providers/anthropic/boundPrefixRecord.js'
import { notBuilt } from '../../pi/holes.js'


type PostCompactScope = {
  querySource?: string
  owner?: OwnerKey
  agentId?: string
}

type QuerySource = string

const MAIN_THREAD_PREFIX = 'main_thread'

export function runPostCompactCleanup(scope?: QuerySource | PostCompactScope, preservedMessages?: readonly Message[]): void {
  return notBuilt('src/services/compact/postCompactCleanup.ts:30')
}
