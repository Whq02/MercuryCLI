import React from 'react'
import type { GlobalConfig } from '../../../platform/settings/config.js'
import type { SettingsJson } from '../../../platform/settings/settingsSchema.js'
import { THEME_LABELS as THEME_NAMES_BY_SETTING } from '../../theme/theme.js'
import type { ModelChoice } from '../../../commands/model/picker/MercuryModelPicker.js'
import type { LOCAL_SERVER_APPLY_MENU } from '../LocalServer.js'
import type { MediaMenu } from '../Media.js'
import type { MercuryThemeTokens } from '../../theme/mercuryTokens.js'
import { isOneOf } from '../../../platform/primitives/isOneOf.js'

export type SubMenu =
  | 'theme'
  | 'agent-model'
  | 'external-includes'
  | 'language'
  | typeof LOCAL_SERVER_APPLY_MENU
  | MediaMenu

export const CREWMATE_INHERIT_ROW: ModelChoice = { id: 'inherit', name: 'Inherit', tag: "the parent's model", ctx: '', group: 'Crewmate', choice: "uses the parent session's model when spawning a crewmate" }

type ItemKind = 'boolean' | 'enum' | 'managed-enum' | 'info'

export type SettingsItem = {
  id: string
  label: string
  searchText?: string
  kind: ItemKind
  value: React.ReactNode
  change?: (direction: 1 | -1) => void
  open?: SubMenu
  warning?: string
  setByYou?: boolean
}

export const THEME_LABELS: Record<string, string> = { auto: 'auto', ...THEME_NAMES_BY_SETTING }

export function cycleIn<T>(list: readonly T[], current: T, direction: 1 | -1): T {
  const at = list.indexOf(current)
  const base = at < 0 ? 0 : at
  return list[(base + direction + list.length) % list.length] as T
}

const SESSION_CEILING_LADDER: readonly number[] = [1, 2, 4, 8, 12, 16, 24, 32]
export function nextSessionCeiling(current: number, direction: 1 | -1): number {
  if (direction === 1) return SESSION_CEILING_LADDER.find(rung => rung > current) ?? (SESSION_CEILING_LADDER[0] as number)
  for (let i = SESSION_CEILING_LADDER.length - 1; i >= 0; i--) {
    const rung = SESSION_CEILING_LADDER[i] as number
    if (rung < current) return rung
  }
  return SESSION_CEILING_LADDER[SESSION_CEILING_LADDER.length - 1] as number
}

export function validated<T extends string>(
  list: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return typeof value === 'string' && isOneOf(list, value)
    ? value
    : fallback
}

export type ConfigRowKit = {
  config: GlobalConfig
  merged: SettingsJson
  tokens: MercuryThemeTokens
  boolValue: (on: boolean) => React.ReactNode
  writeGlobal: (mutate: (config: GlobalConfig) => GlobalConfig) => void
  writeSource: (source: 'localSettings' | 'userSettings', partial: Partial<SettingsJson>) => boolean
  recordToggle: (key: string, text: string) => void
  recordSet: (key: string, text: string) => void
  bump: () => void
}
