import type { CanUseToolFn, Tool, ToolEffect, ToolEffectOutcome, ToolUseContext } from '../../kit/tool.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import type { PermissionDecision } from '../../../permissions/rules/permissions.js'
import type { DesktopBounds, DesktopDriver } from '../../../integrations/desktop/driver.js'
import type { AssistantMessage } from '../../../engine/message-shapes/message.js'
import type { ScreenMap } from '../screenMap.js'
import type { Input, Output } from '../call/schema.js'
import type { Shot } from '../call/shot.js'

export interface CallRun {
  result?: string
  outcome: ToolEffectOutcome
  imagePath?: string
  inlinePath?: string
  inlineMediaType?: string
  screen?: ScreenMap
  claimedForAct: boolean
  contentShown: boolean
}

export type ComputerAnswer = { data: Output; effect: ToolEffect }

export type ComputerDoor = {
  checkPermissions(input: Input, context: ToolUseContext): Promise<PermissionDecision>
  call(input: Input, context: ToolUseContext, canUseTool?: CanUseToolFn, parentAssistantMessage?: AssistantMessage): Promise<ComputerAnswer>
} & Tool

export type FocusDriver = DesktopDriver & Required<Pick<DesktopDriver, 'findApplication' | 'activateApplication'>>

export interface RoadNeeds {
  run: CallRun
  input: Input
  context: ToolUseContext
  owner: OwnerKey
  signal: AbortSignal
  toolUseId: string
  sameMessage: ReadonlySet<string>
  driver: DesktopDriver
  canUseTool: CanUseToolFn | undefined
  parentAssistantMessage: AssistantMessage | undefined
  takeShot: (wanted: number | undefined, label: string | undefined, settleMs?: number, observe?: DesktopBounds) => Promise<Shot>
  adoptShot: (shot: Extract<Shot, { ok: true }>) => void
  shotLines: Set<string>
  finish: () => ComputerAnswer
  runStep: (step: Input) => Promise<ComputerAnswer>
  ComputerTool: ComputerDoor
}
