import type * as React from 'react'
import type { UUID } from 'crypto'
import type { ToolUseContext } from '../Tool.js'
import type { HooksSettings } from '../schemas/hooks.js'
import type { EffortValue } from '../utils/effort.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Message } from './message.js'
import type { SessionListing } from './logs.js'
import type { ContentBlockParam } from './wire.js'
import type { ExtensionManifest } from '../extensions/manifest.js'
import type { ThemeName } from '../utils/theme.js'

type LoadedFromLabel = 'skills' | 'extension' | 'managed' | 'bundled' | 'mcp'

type SettingsLayer = 'userSettings' | 'projectSettings' | 'localSettings' | 'flagSettings' | 'policySettings'
type CommandSource = 'mcp' | SettingsLayer | 'extension' | 'builtin' | 'bundled'
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
  devOnly: boolean
}>

type CommandOrigin = Partial<{
  aliases: string[]
  isMcp: boolean
  loadedFrom: LoadedFromLabel
  source: CommandSource
  kind: 'workflow'
  canonicalRoute: string
}>

type CommandHandling = Partial<{
  immediate: boolean
  isSensitive: boolean
  scope: 'session' | 'agent'
}>

export type CommandBase = CommandWords & CommandDoors & CommandOrigin & CommandHandling

type CommandKind<Type extends string, Fields> = CommandBase & { type: Type } & Fields
type Loadable<Call> = { load: () => Promise<{ call: Call }> }

type ExtensionCommandInfo = { manifest: ExtensionManifest; id: string }

export type PromptCommand = CommandKind<
  'prompt',
  {
    progressMessage: string
    contentLength: number
    source: CommandSource
    getPromptForCommand: (args: string, context: ToolUseContext) => Promise<ContentBlockParam[]>
  } & Partial<{
    argNames: string[]
    allowedTools: string[]
    model: string
    effort: EffortValue
    extensionInfo: ExtensionCommandInfo
    disableNonInteractive: boolean
    hooks: HooksSettings
    skillRoot: string
    context: 'inline' | 'fork'
    agent: string
    pathFilters: string[]
  }>
>

type LocalCommand = CommandKind<
  'local',
  { supportsNonInteractive: boolean } & Loadable<LocalCommandCall> &
    Partial<{
      seat: 'screen'
      userPrivate: boolean
      interruptFirst: boolean
      uiRouteAlias: UiRouteAliasKind
    }>
>

type LocalJSXCommand = CommandKind<'local-jsx', Loadable<LocalJSXCommandCall> & { headlessVerbs?: readonly string[] }>

export type Command = PromptCommand | LocalCommand | LocalJSXCommand

type CompactionHandoff = {
  boundaryMarker: Message
  operatorMessages?: Message
  summaryMessages: Message[]
  messagesToKeep?: Message[]
  attachments: Message[]
  hookResults: Message[]
}

export type LocalCommandResult =
  | { type: 'text'; value: string }
  | { type: 'compact'; compactionResult: CompactionHandoff; displayText?: string }
  | { type: 'skip' }

export type LocalCommandCall = (args: string, context: LocalJSXCommandContext) => Promise<LocalCommandResult>

type CommandDoneOptions = Partial<{
  display: CommandResultDisplay
  metaMessages: string[]
  shouldQuery: boolean
  nextInput: string
  submitNextInput: boolean
}>

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
