
import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  getIsNonInteractiveSession,
  getLastEmittedDate,
  getOriginalCwd,
  hasEnteredPlanModeThisSession,
  hasExitedPlanModeInSession,
  needsAutoModeExitAttachment,
  needsPlanModeExitAttachment,
  setHasExitedPlanMode,
  setLastEmittedDate,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from '../../bootstrap/state.js'
import { getLocalISODate } from '../../constants/common.js'
import { queuedDeepthinkRequested } from '../../run-core/attachment-drain.js'
import { hasSupercodeKeyword } from '../keywordTrigger/supercode.js'
import { getPlan, getPlanFilePath } from '../plans.js'
import {
  buildRepoSurfaceMap,
  hasOrientationDoc,
  repoSurfaceMapEnabled,
} from '../cockpit/repoSurfaceMap.js'
import { hasDeepthinkKeyword, isDeepthinkEnabled } from '../thinking.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import { hasToolResultContent } from './shared.js'
import {
  AUTO_MODE_ATTACHMENT_CONFIG,
  PLAN_MODE_ATTACHMENT_CONFIG,
  type Attachment,
} from './types.js'

const autoModeStateModule: typeof import('../permissions/autoModeState.js') | null = null

function getPlanModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundPlanModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundPlanModeAttachment = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      (message.attachment.type === 'plan_mode' ||
        message.attachment.type === 'plan_mode_reentry')
    ) {
      foundPlanModeAttachment = true
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundPlanModeAttachment }
}

function countPlanModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'plan_mode_exit') {
        break
      }
      if (message.attachment.type === 'plan_mode') {
        count++
      }
    }
  }
  return count
}

export async function getPlanModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  if (permissionContext.mode !== 'strategy') {
    return []
  }

  if (messages && messages.length > 0) {
    const { turnCount, foundPlanModeAttachment } =
      getPlanModeAttachmentTurnCount(messages)
    if (
      foundPlanModeAttachment &&
      turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const existingPlan = getPlan(toolUseContext.agentId)

  const attachments: Attachment[] = []

  if (hasExitedPlanModeInSession() && existingPlan !== null) {
    attachments.push({ type: 'plan_mode_reentry', planFilePath })
    setHasExitedPlanMode(false)
  }

  const attachmentCount =
    countPlanModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  attachments.push({
    type: 'plan_mode',
    reminderType,
    isSubAgent: !!toolUseContext.agentId,
    planFilePath,
    planExists: existingPlan !== null,
  })

  return attachments
}

export async function getPlanModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!needsPlanModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (appState.toolPermissionContext.mode === 'strategy') {
    setNeedsPlanModeExitAttachment(false)
    return []
  }

  setNeedsPlanModeExitAttachment(false)

  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const planExists = getPlan(toolUseContext.agentId) !== null

  if (!hasEnteredPlanModeThisSession() && !planExists) {
    return []
  }

  return [{ type: 'plan_mode_exit', planFilePath, planExists }]
}

function getAutoModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundAutoModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundAutoModeAttachment = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode'
    ) {
      foundAutoModeAttachment = true
      break
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode_exit'
    ) {
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundAutoModeAttachment }
}

function countAutoModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'auto_mode_exit') {
        break
      }
      if (message.attachment.type === 'auto_mode') {
        count++
      }
    }
  }
  return count
}

export async function getAutoModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  const inAuto = permissionContext.mode === 'flow'
  const inPlanWithAuto =
    permissionContext.mode === 'strategy' &&
    (autoModeStateModule?.isAutoModeActive() ?? false)
  if (!inAuto && !inPlanWithAuto) {
    return []
  }

  if (messages && messages.length > 0) {
    const { turnCount, foundAutoModeAttachment } =
      getAutoModeAttachmentTurnCount(messages)
    if (
      foundAutoModeAttachment &&
      turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  const attachmentCount =
    countAutoModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  return [{ type: 'auto_mode', reminderType }]
}

export async function getAutoModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!needsAutoModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (
    appState.toolPermissionContext.mode === 'flow' ||
    (autoModeStateModule?.isAutoModeActive() ?? false)
  ) {
    setNeedsAutoModeExitAttachment(false)
    return []
  }

  setNeedsAutoModeExitAttachment(false)
  return [{ type: 'auto_mode_exit' }]
}


function getUltraEffortAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundUltraEffortAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundUltraEffortAttachment = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'ultra_effort'
    ) {
      foundUltraEffortAttachment = true
      break
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'ultra_effort_exit'
    ) {
      break
    }
  }
  return { turnCount: turnsSinceLastAttachment, foundUltraEffortAttachment }
}

function countUltraEffortAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'ultra_effort_exit') break
      if (message.attachment.type === 'ultra_effort') count++
    }
  }
  return count
}

export function getRepoSurfaceMapAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  if (!repoSurfaceMapEnabled()) return []
  if (toolUseContext.agentId) return []
  if (getIsNonInteractiveSession()) return []
  const root = getOriginalCwd()
  if (hasOrientationDoc(root)) return []
  if (messages && messages.length > 0) {
    for (const m of messages) {
      if (m.type === 'attachment' && m.attachment.type === 'repo_surface_map') return []
    }
  }
  const markdown = buildRepoSurfaceMap(root)
  if (!markdown) return []
  return [{ type: 'repo_surface_map', markdown }]
}

export function getUltraEffortAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  
  if (toolUseContext.getAppState().supercode !== true) return []

  if (messages && messages.length > 0) {
    const { turnCount, foundUltraEffortAttachment } =
      getUltraEffortAttachmentTurnCount(messages)
    if (
      foundUltraEffortAttachment &&
      turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  const attachmentCount =
    countUltraEffortAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  return [{ type: 'ultra_effort', reminderType }]
}

export function getUltraEffortExitAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Attachment[] {
  
  if (toolUseContext.getAppState().supercode === true) return []
  if (!messages || messages.length === 0) return []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'ultra_effort_exit') return []
      if (message.attachment.type === 'ultra_effort') {
        return [{ type: 'ultra_effort_exit' }]
      }
    }
  }
  return []
}

export function getSupercodeKeywordAttachment(
  input: string | null,
  toolUseContext: ToolUseContext,
  options?: { skipSkillDiscovery?: boolean },
): Attachment[] {
  
  if (options?.skipSkillDiscovery) return []
  if (!input || !hasSupercodeKeyword(input)) return []
  if (toolUseContext.getAppState().supercode === true) return []
  const enablement =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../tools/WorkflowTool/workflowEnablement.js') as typeof import('../../tools/WorkflowTool/workflowEnablement.js')
  if (
    !enablement.dynamicWorkflowsEnabled() ||
    !enablement.workflowKeywordTriggerEnabled()
  ) {
    return []
  }
  return [{ type: 'supercode_keyword' }]
}

export function getDateChangeAttachments(
  messages: Message[] | undefined,
): Attachment[] {
  const currentDate = getLocalISODate()
  const lastDate = getLastEmittedDate()

  if (lastDate === null) {
    setLastEmittedDate(currentDate)
    return []
  }

  if (currentDate === lastDate) {
    return []
  }

  setLastEmittedDate(currentDate)

  return [{ type: 'date_change', newDate: currentDate }]
}

export function getDeepthinkEffortAttachment(
  input: string | null,
  _toolUseContext: ToolUseContext,
  options?: { skipSkillDiscovery?: boolean },
  queuedCommands?: QueuedCommand[],
): Attachment[] {
  if (options?.skipSkillDiscovery) return []
  if (!isDeepthinkEnabled()) return []
  const keywordPresent =
    (!!input && hasDeepthinkKeyword(input)) ||
    queuedDeepthinkRequested(queuedCommands ?? [], hasDeepthinkKeyword)
  if (!keywordPresent) return []
  return [{ type: 'deepthink_effort' }]
}
