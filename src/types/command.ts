import type * as React from 'react'
import type { UUID } from 'crypto'
import type { CanUseToolFn, ToolUseContext } from '../Tool.js'
import type { HooksSettings } from '../schemas/hooks.js'
import type { EffortValue } from '../utils/effort.js'
import type { Message } from './message.js'
import type { SessionListing } from './logs.js'
import type { ContentBlockParam } from './wire.js'
import type { ExtensionManifest } from '../extensions/manifest.js'
import type { ThemeName } from '../utils/theme.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type LoadedFromLabel = Unbuilt
type CommandSource = Unbuilt
type CommandAvailability = Unbuilt

export type UiRouteAliasKind = Unbuilt
export type CommandSeat = Unbuilt
export type CommandResultDisplay = Unbuilt
export type ResumeEntrypoint = Unbuilt

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

export type CommandBase = Unbuilt

export type PromptCommand = Unbuilt

export type Command = Unbuilt

export type LocalCommandResult = Unbuilt

export type LocalCommandCall = (...args: Unbuilt[]) => Unbuilt

export type LocalJSXCommandOnDone = (...args: Unbuilt[]) => Unbuilt

export type LocalJSXCommandContext = Unbuilt

export type LocalJSXCommandCall = (...args: Unbuilt[]) => Unbuilt

export function getCommandName(command: Command): string {
  return notBuilt('src/types/command.ts:150')
}

export function isCommandEnabled(command: Command): boolean {
  return notBuilt('src/types/command.ts:154')
}
