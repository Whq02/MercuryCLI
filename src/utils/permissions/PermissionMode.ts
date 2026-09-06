import { z } from 'zod/v4'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  decodePermissionModeSpelling,
  type ExternalPermissionMode,
  type PermissionMode,
} from '../../types/permissions.js'

export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  RETIRED_PERMISSION_MODE_SPELLINGS,
  decodePermissionModeSpelling,
  type ExternalPermissionMode,
  type PermissionMode,
} from '../../types/permissions.js'

type ModeColorKey =
  | 'text'
  | 'strategyMode'
  | 'permission'
  | 'autoAccept'
  | 'error'
  | 'warning'
  | 'success'

type ModeConfig = {
  title: string
  symbol: string
  color: ModeColorKey
  external: ExternalPermissionMode
}

const MODE_CONFIG: Partial<Record<PermissionMode, ModeConfig>> = {
  default: { title: 'Default', symbol: GLYPH.modeDefault, color: 'text', external: 'default' },
  strategy: { title: 'Strategy Mode', symbol: GLYPH.modeStrategy, color: 'strategyMode', external: 'strategy' },
  apollo: { title: 'Apollo Mode', symbol: GLYPH.modeApollo, color: 'permission', external: 'default' },
  implement: { title: 'Implement Mode', symbol: GLYPH.modeImplement, color: 'autoAccept', external: 'implement' },
  sovereign: { title: 'Sovereign Mode', symbol: GLYPH.modeSovereign, color: 'error', external: 'sovereign' },
  dontAsk: { title: "Don't Ask", symbol: GLYPH.modeDontAsk, color: 'error', external: 'dontAsk' },
  flow: { title: 'Flow', symbol: GLYPH.modeFlow, color: 'success', external: 'default' },
  autopilot: { title: 'Autopilot', symbol: GLYPH.modeAutopilot, color: 'error', external: 'sovereign' },
}

function configFor(mode: PermissionMode): ModeConfig {
  return MODE_CONFIG[mode] ?? (MODE_CONFIG.default as ModeConfig)
}

export function permissionModeSchema() {
  return z.preprocess(
    v => (typeof v === 'string' ? decodePermissionModeSpelling(v) : v),
    z.enum(PERMISSION_MODES as unknown as [string, ...string[]]),
  )
}

export function externalPermissionModeSchema() {
  return z.preprocess(
    v => (typeof v === 'string' ? decodePermissionModeSpelling(v) : v),
    z.enum(EXTERNAL_PERMISSION_MODES as unknown as [string, ...string[]]),
  )
}

export function isExternalPermissionMode(_mode: PermissionMode): _mode is ExternalPermissionMode {
  return true
}

export function modeBypassesPermissions(mode: PermissionMode): boolean {
  return mode === 'sovereign' || mode === 'autopilot'
}

export function toExternalPermissionMode(mode: PermissionMode): ExternalPermissionMode {
  return configFor(mode).external
}

export function permissionModeFromString(str: string): PermissionMode {
  const decoded = decodePermissionModeSpelling(str)
  return (PERMISSION_MODES as readonly string[]).includes(decoded)
    ? (decoded as PermissionMode)
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
