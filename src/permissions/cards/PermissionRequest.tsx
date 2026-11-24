import * as React from 'react'
import { useContext } from 'react'
import { useClaim } from '../../screen/effects/effects.js'
import { ScreenInstanceContext } from '../../screen/renderer/elements/InkInstanceContext.js'
import { useKeybinding } from '../../screen/keys/useKeybinding.js'
import { armComposerSeed } from '../../screen/cockpit/composerSeed.js'
import { armPermissionFocus } from '../rules/permissionFocus.js'
import type { Tool } from '../../tools/kit/tool.js'
import type { AssistantMessage } from '../../engine/message-shapes/message.js'
import type { ContentBlockParam } from '../../engine/message-shapes/wire.js'
import type { PermissionUpdate } from '../rules/permissions.js'
import type { PermissionDecision } from '../rules/permissionResult.js'
import { BashTool } from '../../tools/shell/BashTool.js'
import { PowerShellTool } from '../../tools/powershell/PowerShellTool.js'
import { ChangeSetTool } from '../../tools/change-set/ChangeSetTool.js'
import { EditTool } from '../../tools/edit/EditTool.js'
import { WriteTool } from '../../tools/write/WriteTool.js'
import { ReadTool } from '../../tools/read/ReadTool.js'
import { GlobTool } from '../../tools/glob/GlobTool.js'
import { GrepTool } from '../../tools/grep/GrepTool.js'
import { NotebookEditTool } from '../../tools/notebook-edit/NotebookEditTool.js'
import { SkillTool } from '../../tools/skill/SkillTool.js'
import { WebFetchTool } from '../../tools/web-fetch/WebFetchTool.js'
import { BrowserTool } from '../../tools/browser/BrowserTool.js'
import { ApolloReviewTool } from '../../tools/apollo-review/ApolloReviewTool.js'
import { AskUserQuestionTool } from '../../tools/ask-question/AskUserQuestionTool.js'
import { RecordConventionTool } from '../../tools/record-convention/RecordConventionTool.js'
import { GitTool } from '../../tools/git/GitTool.js'
import { MonitorTool } from '../../tools/monitor/MonitorTool.js'
import { CorrectTool, RetainTool } from '../../tools/memory/MemoryTools.js'
import { ApolloReviewPermissionRequest } from './apollo-review/ApolloReviewPermissionRequest.js'
import { isMemoryRuleCard, MemoryRulePermissionRequest } from './memory-rule/MemoryRulePermissionRequest.js'
import { QuestionPermissionRequest } from './ask-user-question/QuestionPermissionRequest.js'
import { ChangeSetPermissionRequest } from './change-set/ChangeSetPermissionRequest.js'
import { BashPermissionRequest, MonitorPermissionRequest } from './bash/ShellPermissionRequest.js'
import { PowerShellPermissionRequest } from './powershell/PowerShellPermissionRequest.js'
import { FallbackPermissionRequest } from './FallbackPermissionRequest.js'
import { useKeysHeldUntilFirstPaint } from './cardArrival.js'
import { MediaPermissionRequest } from './MediaPermissionRequest.js'
import { mediaGenerationKind } from '../../integrations/media/generation.js'
import { FileEditPermissionRequest } from './file-edit/FileEditPermissionRequest.js'
import { FileWritePermissionRequest } from './file-write/FileWritePermissionRequest.js'
import { FilesystemPermissionRequest } from './filesystem/FilesystemPermissionRequest.js'
import { NotebookEditPermissionRequest } from './notebook-edit/NotebookEditPermissionRequest.js'
import { RecordConventionPermissionRequest } from './record-convention/RecordConventionPermissionRequest.js'
import { GitPermissionRequest } from './git/GitPermissionRequest.js'
import { SkillPermissionRequest } from './skill/SkillPermissionRequest.js'
import { WebFetchPermissionRequest } from './web-fetch/WebFetchPermissionRequest.js'
import { BrowserPermissionRequest } from './browser/BrowserPermissionRequest.js'
import { ComputerPermissionRequest } from './computer/ComputerPermissionRequest.js'
import { COMPUTER_TOOL_NAME } from '../../integrations/desktop/toolName.js'
import type { WorkerBadgeProps } from './WorkerBadge.js'

import type { ToolUseContext } from '../../tools/kit/tool.js'

export type ToolUseConfirm<Input = Record<string, unknown>> = {
  assistantMessage: AssistantMessage
  tool: Tool
  description: string
  input: Input
  toolUseContext: ToolUseContext
  toolUseID: string
  permissionResult: PermissionDecision
  permissionPromptStartTimeMs: number
  cwd?: string
  crewmate?: string
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
  onReject: (
    feedback?: string,
    contentBlocks?: ContentBlockParam[],
  ) => void | Promise<void>
  recheckPermission: () => Promise<void>
}

export type PermissionRequestProps<Input = Record<string, unknown>> = {
  toolUseConfirm: ToolUseConfirm<Input>
  toolUseContext: ToolUseContext
  onDone: () => void
  onReject: () => void
  verbose: boolean
  workerBadge: WorkerBadgeProps | undefined
}


export function PermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm, onDone, onReject } = props

  useKeybinding(
    'app:interrupt',
    () => {
      onDone()
      onReject()
      toolUseConfirm.onReject()
    },
    { context: 'Confirmation' },
  )

  useClaim(() => armPermissionFocus(), [])

  const ink = useContext(ScreenInstanceContext)
  useClaim(() => ink?.registerArrowKeyOwner(() => true), [ink])

  useKeysHeldUntilFirstPaint()

  const isQuestionCard = toolUseConfirm.tool === AskUserQuestionTool
  useClaim(() => {
    if (isQuestionCard) return undefined
    return armComposerSeed()
  }, [isQuestionCard])

  const tool = toolUseConfirm.tool
  const key = toolUseConfirm.toolUseID
  const mediaKind = mediaGenerationKind(tool)
  if (mediaKind) return <MediaPermissionRequest key={key} {...props} kind={mediaKind} />

  if (tool === EditTool) return <FileEditPermissionRequest key={key} {...props} />
  if (tool === ChangeSetTool) return <ChangeSetPermissionRequest key={key} {...props} />
  if (tool === WriteTool) return <FileWritePermissionRequest key={key} {...props} />
  if (tool === BashTool) return <BashPermissionRequest key={key} {...props} />
  if (tool === MonitorTool) return <MonitorPermissionRequest key={key} {...props} />
  if (tool === PowerShellTool) return <PowerShellPermissionRequest key={key} {...props} />
  if (tool === WebFetchTool) return <WebFetchPermissionRequest key={key} {...props} />
  if (tool === BrowserTool) return <BrowserPermissionRequest key={key} {...props} />
  if (tool.name === COMPUTER_TOOL_NAME) return <ComputerPermissionRequest key={key} {...props} />
  if (tool === NotebookEditTool) return <NotebookEditPermissionRequest key={key} {...props} />
  if (tool === RecordConventionTool) return <RecordConventionPermissionRequest key={key} {...props} />
  if ((tool === CorrectTool || tool === RetainTool) && isMemoryRuleCard(toolUseConfirm)) return <MemoryRulePermissionRequest key={key} {...props} />
  if (tool === GitTool) return <GitPermissionRequest key={key} {...props} />
  if (tool === ApolloReviewTool) return <ApolloReviewPermissionRequest key={key} {...props} />
  if (tool === SkillTool) return <SkillPermissionRequest key={key} {...props} />
  if (tool === AskUserQuestionTool) {
    return <QuestionPermissionRequest key={key} {...props} />
  }
  if (tool === GlobTool || tool === GrepTool || tool === ReadTool) {
    return <FilesystemPermissionRequest key={key} {...props} />
  }
  return <FallbackPermissionRequest key={key} {...props} />
}
