import type * as React from 'react'
import type { UUID } from 'crypto'
import type { CanUseToolFn, ToolUseContext } from '../../tools/kit/tool.js'
import type { HooksSettings } from '../../integrations/event-hook-schemas/hooks.js'
import type { EffortValue } from '../../models/effort/effort.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { SessionListing } from '../../sessions/transcripts/transcriptEntries.js'
import type { ContentBlockParam } from '../../engine/message-shapes/wire.js'
import type { ExtensionManifest } from '../../integrations/extensions/manifest.js'
import type { ThemeName } from '../../screen/theme/theme.js'

type LoadedFromLabel = 'skills' | 'extension' | 'managed' | 'bundled' | 'mcp'
type CommandSource = 'mcp' | 'userSettings' | 'projectSettings' | 'localSettings' | 'flagSettings' | 'policySettings' | 'extension' | 'builtin' | 'bundled'
type CommandAvailability = 'claude-ai' | 'console' | 'any-provider-credential'

export type UiRouteAliasKind = 'concourse'
export type CommandSeat = 'screen' | 'session'
export type CommandResultDisplay = 'skip' | 'system' | 'user'
export type ResumeEntrypoint =
  | 'cli_flag'
  | 'slash_command_picker'
  | 'slash_command_session_id'
  | 'slash_command_title'
  | 'fork'
  | 'switchboard'

type CommandWords = {
  name: string
  description: string
  menuDescription?: string
  currentValue?: () => string | undefined
  hasUserSpecifiedDescription?: boolean
  userFacingName?: () => string
  argumentHint?: string
  whenToUse?: string
  version?: string
}

type CommandDoors = Partial<{
  isEnabled: () => boolean
  isHidden: boolean
  userInvocable: boolean
  disableModelInvocation: boolean
  kitSkillState: 'invocable'
  availability: CommandAvailability[]
  needsConcourse: boolean
}>

type CommandOrigin = Partial<{
  aliases: string[]
  isMcp: boolean
  loadedFrom: LoadedFromLabel
  source: CommandSource
  canonicalRoute: string
}>

type CommandHandling = Partial<{
  immediate: boolean
  isSensitive: boolean
  scope: 'session' | 'agent'
}>

export type CommandBase = CommandWords & CommandDoors & CommandOrigin & CommandHandling

export type PromptCommand = CommandBase & {
  type: 'prompt'
  progressMessage: string
  contentLength: number
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  source: CommandSource
  extensionInfo?: {
    manifest: ExtensionManifest
    id: string
  }
  disableNonInteractive?: boolean
  hooks?: HooksSettings
  skillRoot?: string
  context?: 'inline' | 'fork'
  agent?: string
  pathFilters?: string[]
  getPromptForCommand(args: string, context: ToolUseContext): Promise<ContentBlockParam[]>
}

type LocalCommand = CommandBase & {
  type: 'local'
  supportsNonInteractive: boolean
  load: () => Promise<{ call: LocalCommandCall }>
  seat?: 'screen'
  userPrivate?: boolean
  interruptFirst?: boolean
  uiRouteAlias?: UiRouteAliasKind
}

type LocalJSXCommand = CommandBase & {
  type: 'local-jsx'
  load: () => Promise<{ call: LocalJSXCommandCall }>
  headlessVerbs?: readonly string[]
}

export type Command = PromptCommand | LocalCommand | LocalJSXCommand

type FoldHandoff = {
  boundaryMarker: Message
  operatorMessages?: Message
  summaryMessages: Message[]
  messagesToKeep?: Message[]
  attachments: Message[]
  hookResults: Message[]
}

export type LocalCommandResult =
  | { type: 'text'; value: string }
  | { type: 'compact'; foldHandoff: FoldHandoff; displayText?: string }
  | { type: 'skip' }

export type LocalCommandCall = (args: string, context: LocalJSXCommandContext) => Promise<LocalCommandResult>

type CommandDoneOptions = {
  display?: CommandResultDisplay
  metaMessages?: string[]
  shouldStartTurn?: boolean
  nextInput?: string
  submitNextInput?: boolean
}

export type LocalJSXCommandOnDone = (result?: string, options?: CommandDoneOptions) => void

export type LocalJSXCommandContext = ToolUseContext & {
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  canUseTool?: CanUseToolFn
  onChangeAPIKey: () => void
  resume?: (sessionId: UUID, log: SessionListing, entrypoint: ResumeEntrypoint) => Promise<void>
  options: ToolUseContext['options'] & { theme: ThemeName }
}

export type LocalJSXCommandCall = (
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
  invokedAs?: string,
) => Promise<React.ReactNode | null>

export function getCommandName(command: Command): string {
  return command.userFacingName?.() ?? command.name
}

export function isCommandEnabled(command: Command): boolean {
  return command.isEnabled?.() ?? true
}
