import * as React from 'react'
import { useEffect } from 'react'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useNotifyAfterTimeout } from '../../hooks/useNotifyAfterTimeout.js'
import { armComposerSeed } from '../../utils/cockpit/composerSeed.js'
import { armPermissionFocus } from '../../utils/permissions/permissionFocus.js'
import type { Tool } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type { PermissionRule, PermissionUpdate } from '../../types/permissions.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { BashTool } from '../../tools/BashTool/BashTool.js'
import { PowerShellTool } from '../../tools/PowerShellTool/PowerShellTool.js'
import { ChangeSetTool } from '../../tools/ChangeSetTool/ChangeSetTool.js'
import { FileEditTool } from '../../tools/FileEditTool/FileEditTool.js'
import { FileWriteTool } from '../../tools/FileWriteTool/FileWriteTool.js'
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js'
import { GlobTool } from '../../tools/GlobTool/GlobTool.js'
import { GrepTool } from '../../tools/GrepTool/GrepTool.js'
import { NotebookEditTool } from '../../tools/NotebookEditTool/NotebookEditTool.js'
import { SkillTool } from '../../tools/SkillTool/SkillTool.js'
import { WebFetchTool } from '../../tools/WebFetchTool/WebFetchTool.js'
import { BrowserTool } from '../../tools/BrowserTool/BrowserTool.js'
import { EnterPlanModeTool } from '../../tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { ExitPlanModeV2Tool } from '../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { ApolloReviewTool } from '../../tools/ApolloReviewTool/ApolloReviewTool.js'
import { AskUserQuestionTool } from '../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { WorkflowTool } from '../../tools/WorkflowTool/WorkflowTool.js'
import { ApolloReviewPermissionRequest } from './ApolloReviewPermissionRequest/ApolloReviewPermissionRequest.js'
import { AskUserQuestionPermissionRequest } from './AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.js'
import { ChangeSetPermissionRequest } from './ChangeSetPermissionRequest/ChangeSetPermissionRequest.js'
import { BashPermissionRequest } from './BashPermissionRequest/BashPermissionRequest.js'
import { PowerShellPermissionRequest } from './PowerShellPermissionRequest/PowerShellPermissionRequest.js'
import { EnterPlanModePermissionRequest } from './EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.js'
import { ExitPlanModePermissionRequest } from './ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
import { FallbackPermissionRequest } from './FallbackPermissionRequest.js'
import { FileEditPermissionRequest } from './FileEditPermissionRequest/FileEditPermissionRequest.js'
import { FileWritePermissionRequest } from './FileWritePermissionRequest/FileWritePermissionRequest.js'
import { FilesystemPermissionRequest } from './FilesystemPermissionRequest/FilesystemPermissionRequest.js'
import { NotebookEditPermissionRequest } from './NotebookEditPermissionRequest/NotebookEditPermissionRequest.js'
import { SkillPermissionRequest } from './SkillPermissionRequest/SkillPermissionRequest.js'
import { WebFetchPermissionRequest } from './WebFetchPermissionRequest/WebFetchPermissionRequest.js'
import { BrowserPermissionRequest } from './BrowserPermissionRequest/BrowserPermissionRequest.js'
import type { WorkerBadgeProps } from './WorkerBadge.js'

import type { ToolUseContext } from '../../Tool.js'

export type { ToolUseContext }

/** The pending consent request record. */
export type ToolUseConfirm<Input = Record<string, unknown>> = {
  assistantMessage: AssistantMessage
  tool: Tool
  description: string
  input: Input
  toolUseContext: ToolUseContext
  toolUseID: string
  permissionResult: PermissionDecision
  permissionPromptStartTimeMs: number
  classifierCheckInProgress?: boolean
  classifierAutoApproved?: boolean
  classifierMatchedRule?: PermissionRule
  workerBadge?: WorkerBadgeProps
  onUserInteraction: () => void
  onAbort: () => void
  onDismissCheckmark?: () => void
  onAllow: (
    updatedInput: Input,
    permissionUpdates: PermissionUpdate[],
    feedback?: string,
    contentBlocks?: ContentBlockParam[],
  ) => void | Promise<void>
  onReject: (feedback?: string, contentBlocks?: ContentBlockParam[]) => void | Promise<void>
  recheckPermission: () => Promise<void>
}

export type PermissionRequestProps<Input = Record<string, unknown>> = {
  toolUseConfirm: ToolUseConfirm<Input>
  toolUseContext: ToolUseContext
  onDone: () => void
  onReject: () => void
  verbose: boolean
  workerBadge: WorkerBadgeProps | undefined
  setStickyFooter?: (jsx: React.ReactNode | null) => void
}

// The workflow card is an OPTIONAL module: when it resolves absent the
// request must degrade to the fallback card — never crash, never skip the
// consent gate.
let ResolvedWorkflowCard: ((props: PermissionRequestProps) => React.ReactNode) | null = null
try {
  const workflowModule = require('../../tools/WorkflowTool/WorkflowPermissionRequest.js') as {
    WorkflowPermissionRequest?: (props: PermissionRequestProps) => React.ReactNode
  }
  ResolvedWorkflowCard = workflowModule.WorkflowPermissionRequest ?? null
} catch {
  ResolvedWorkflowCard = null
}

/** The notification text for a pending consent request. The fourth case's
 *  `Mercury needs your permission to use` substring is contract data. */
function notificationTextFor(toolUseConfirm: ToolUseConfirm): string {
  const tool = toolUseConfirm.tool
  if (tool === ExitPlanModeV2Tool) return 'Mercury needs your approval for the plan'
  if (tool === EnterPlanModeTool) return 'Mercury wants to enter strategy mode'
  if (tool === ApolloReviewTool) return 'Mercury needs your review of the Apollo spec'
  const name = tool.userFacingName(toolUseConfirm.input as never)
  if (!name || name.trim() === '') return 'Mercury needs your attention'
  return `Mercury needs your permission to use ${name}`
}

/**
 * The consent router: picks the per-tool card by tool IDENTITY (a renamed
 * tool keeps its card), with the universal fallback so no tool can reach the
 * user without a gate.
 */
export function PermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm, onDone, onReject } = props

  // Interrupt: dismiss the card, cancel queued commands, reject the request —
  // in that order. The pending request resolves as a REJECTION (the same
  // settlement path escape takes), never through the abort callback.
  useKeybinding(
    'app:interrupt',
    () => {
      onDone()
      onReject()
      toolUseConfirm.onReject()
    },
    { context: 'Confirmation' },
  )

  // The modal-focus presence (permissionFocus): while ANY card is mounted,
  // gestures that would open or queue another surface are refused at their
  // entry point — the queued-overlay class (a parked /usage popping after
  // the question, the next esc killing both) is structurally closed.
  useEffect(() => armPermissionFocus(), [])

  // Type-through: printable non-digit keys that fall through the card's
  // selector seed the composer draft. Armed for the lifetime of the mount —
  // a mount-only effect with no dependencies; the arm is reference-counted
  // and the returned disarm is idempotent, so overlapping queued cards keep
  // the seam armed until the last one unmounts.
  //
  // The INTERVIEW QUESTION card is exempt: an open question is modal focus,
  // and its options carry ordinal hotkeys (letters on Apollo polls, digits
  // on numbered lists) — seeding the composer from a letter made the menu
  // close (the card yielded to the composer) and reopen on the next
  // backspace, with the stolen letter lingering in the draft (operator
  // live-drive, block D). Ordinary consent cards keep the type-through
  // dance: typing there is a reply, not an answer.
  const isQuestionCard = toolUseConfirm.tool === AskUserQuestionTool
  useEffect(() => {
    if (isQuestionCard) return undefined
    return armComposerSeed()
  }, [isQuestionCard])

  useNotifyAfterTimeout(notificationTextFor(toolUseConfirm), 'permission_prompt')

  const tool = toolUseConfirm.tool
  const key = toolUseConfirm.toolUseID

  if (tool === FileEditTool) return <FileEditPermissionRequest key={key} {...props} />
  if (tool === ChangeSetTool) return <ChangeSetPermissionRequest key={key} {...props} />
  if (tool === FileWriteTool) return <FileWritePermissionRequest key={key} {...props} />
  if (tool === BashTool) return <BashPermissionRequest key={key} {...props} />
  if (tool === PowerShellTool) return <PowerShellPermissionRequest key={key} {...props} />
  if (tool === WebFetchTool) return <WebFetchPermissionRequest key={key} {...props} />
  if (tool === BrowserTool) return <BrowserPermissionRequest key={key} {...props} />
  if (tool === NotebookEditTool) return <NotebookEditPermissionRequest key={key} {...props} />
  if (tool === ExitPlanModeV2Tool) return <ExitPlanModePermissionRequest key={key} {...props} />
  if (tool === EnterPlanModeTool) return <EnterPlanModePermissionRequest key={key} {...props} />
  if (tool === ApolloReviewTool) return <ApolloReviewPermissionRequest key={key} {...props} />
  if (tool === SkillTool) return <SkillPermissionRequest key={key} {...props} />
  if (tool === AskUserQuestionTool) {
    return <AskUserQuestionPermissionRequest key={key} {...props} />
  }
  if (tool === WorkflowTool) {
    if (ResolvedWorkflowCard) {
      const WorkflowCard = ResolvedWorkflowCard
      return <WorkflowCard key={key} {...props} />
    }
    return <FallbackPermissionRequest key={key} {...props} />
  }
  if (tool === GlobTool || tool === GrepTool || tool === FileReadTool) {
    return <FilesystemPermissionRequest key={key} {...props} />
  }
  return <FallbackPermissionRequest key={key} {...props} />
}
