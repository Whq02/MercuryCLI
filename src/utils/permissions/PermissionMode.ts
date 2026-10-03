import { z } from 'zod/v4'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type PermissionMode,
} from '../../types/permissions.js'

export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
} from '../../types/permissions.js'

type ModeColorKey =
  | 'text'
  | 'permission'
  | 'autoAccept'
  | 'error'
  | 'warning'
  | 'success'

type ModeConfig = {
  title: string
  symbol: string
  color: ModeColorKey
}

const MODE_CONFIG: Partial<Record<PermissionMode, ModeConfig>> = {
  default: { title: 'Default', symbol: GLYPH.modeDefault, color: 'text' },
  apollo: { title: 'Apollo Mode', symbol: GLYPH.modeApollo, color: 'permission' },
  implement: { title: 'Implement Mode', symbol: GLYPH.modeImplement, color: 'autoAccept' },
  sovereign: { title: 'Sovereign Mode', symbol: GLYPH.modeSovereign, color: 'error' },
  dontAsk: { title: "Don't Ask", symbol: GLYPH.modeDontAsk, color: 'error' },
  flow: { title: 'Flow', symbol: GLYPH.modeFlow, color: 'success' },
}

function configFor(mode: PermissionMode): ModeConfig {
  return MODE_CONFIG[mode] ?? (MODE_CONFIG.default as ModeConfig)
}

export function permissionModeSchema() {
  return z.enum(PERMISSION_MODES as unknown as [string, ...string[]])
}

export function externalPermissionModeSchema() {
  return z.enum(EXTERNAL_PERMISSION_MODES as unknown as [string, ...string[]])
}

export function modeBypassesPermissions(mode: PermissionMode): boolean {
  return mode === 'sovereign'
}

export function permissionModeFromString(str: string): PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(str)
    ? (str as PermissionMode)
    : 'default'
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === undefined || mode === 'default'
}

export function permissionModeTitle(mode: PermissionMode): string {
  return configFor(mode).title
}

export function permissionModeSymbol(mode: PermissionMode): string {
  return configFor(mode).symbol
}

export function getModeColor(mode: PermissionMode): ModeColorKey {
  return configFor(mode).color
}
