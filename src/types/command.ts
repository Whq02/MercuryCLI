import type * as React from 'react'
import type { UUID } from 'crypto'
import type { ToolUseContext } from '../Tool.js'
import type { HooksSettings } from '../schemas/hooks.js'
import type { EffortValue } from '../utils/effort.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Message } from './message.js'
import type { LogOption } from './logs.js'
import type { ContentBlockParam } from './wire.js'
import type { ExtensionManifest } from '../extensions/manifest.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import type { IDEExtensionInstallationStatus, IdeType } from '../utils/ide.js'
import type { ThemeName } from '../utils/theme.js'

type CommandSource =
  | 'mcp'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'extension'
  | 'builtin'
  | 'bundled'

type LoadedFromLabel =
  | 'legacy-commands'
  | 'skills'
  | 'extension'
  | 'managed'
  | 'bundled'
  | 'mcp'

export type CommandAvailability = 'claude-ai' | 'console' | 'any-provider-credential'

export type UiRouteAliasKind = 'concourse'

export type ExtensionCommandInfo = {
  manifest: ExtensionManifest
  id: string
}

export type MenuLiveState = {
  effortValue?: EffortValue
  permissionMode?: string
  mainLoopModelForSession?: string | null
}

export type CommandBase = {
  name: string
  description: string
  menuDescription?: string
  currentValue?: (live: MenuLiveState) => string | undefined
  hasUserSpecifiedDescription?: boolean
  isEnabled?: () => boolean
  isHidden?: boolean
  aliases?: string[]
  isMcp?: boolean
  argumentHint?: string
  whenToUse?: string
  version?: string
  disableModelInvocation?: boolean
  kitSkillState?: 'invocable'
  userInvocable?: boolean
  loadedFrom?: LoadedFromLabel
  kind?: 'workflow'
  source?: CommandSource
  immediate?: boolean
  isSensitive?: boolean
  userFacingName?: () => string
  availability?: CommandAvailability[]
  needsConcourse?: boolean
  retired?: string
  devOnly?: boolean
  canonicalRoute?: string
  scope?: 'session' | 'agent'
}

export type PromptCommand = CommandBase & {
  type: 'prompt'
  progressMessage: string
  contentLength: number
  source: CommandSource
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  extensionInfo?: ExtensionCommandInfo
  disableNonInteractive?: boolean
  hooks?: HooksSettings
  skillRoot?: string
  context?: 'inline' | 'fork'
  agent?: string
  pathFilters?: string[]
  getPromptForCommand: (
    args: string,
    context: ToolUseContext,
  ) => Promise<ContentBlockParam[]>
}

export type LocalCommandResult =
  | { type: 'text'; value: string }
  | {
      type: 'compact'
      compactionResult: {
        boundaryMarker: Message
        summaryMessages: Message[]
        messagesToKeep?: Message[]
        attachments: Message[]
        hookResults: Message[]
        userDisplayMessage?: string
      }
      displayText?: string
    }
  | { type: 'skip' }

export type LocalCommandCall = (
  args: string,
  context: LocalJSXCommandContext,
) => Promise<LocalCommandResult>

export type LocalCommandModule = {
  call: LocalCommandCall
}

export type CommandSeat = 'screen' | 'session'

type LocalCommand = CommandBase & {
  type: 'local'
  supportsNonInteractive: boolean
  seat?: 'screen'
  userPrivate?: boolean
  interruptFirst?: boolean
  uiRouteAlias?: UiRouteAliasKind
  load: () => Promise<LocalCommandModule>
}

export type CommandResultDisplay = 'skip' | 'system' | 'user'

export type LocalJSXCommandOnDone = (
  result?: string,
  options?: {
    display?: CommandResultDisplay
    metaMessages?: string[]
    shouldQuery?: boolean
    nextInput?: string
    submitNextInput?: boolean
  },
) => void

export type ResumeEntrypoint =
  | 'cli_flag'
  | 'slash_command_picker'
  | 'slash_command_session_id'
  | 'slash_command_title'
  | 'fork'
  | 'switchboard'

export type LocalJSXCommandContext = ToolUseContext & {
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  canUseTool?: CanUseToolFn
  onChangeAPIKey: () => void
  onChangeDynamicMcpConfig?: (
    config: Record<string, ScopedMcpServerConfig>,
  ) => void
  onInstallIDEExtension?: (ide: IdeType) => void
  resume?: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
  options: ToolUseContext['options'] & {
    dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
    ideInstallationStatus?: IDEExtensionInstallationStatus | null
    theme: ThemeName
  }
}

export type LocalJSXCommandCall = (
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
  invokedAs?: string,
) => Promise<React.ReactNode | null>

export type LocalJSXCommandModule = {
  call: LocalJSXCommandCall
}

type LocalJSXCommand = CommandBase & {
  type: 'local-jsx'
  load: () => Promise<LocalJSXCommandModule>
}

export type Command = PromptCommand | LocalCommand | LocalJSXCommand

export function getCommandName(command: Command): string {
  return command.userFacingName?.() ?? command.name
}

export function isCommandEnabled(command: Command): boolean {
  return command.isEnabled ? command.isEnabled() : true
}
