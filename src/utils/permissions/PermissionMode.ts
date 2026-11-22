import { z } from 'zod/v4'
import { GLYPH } from '../glyphs.js'
import { EXTERNAL_PERMISSION_MODES, PERMISSION_MODES, type PermissionMode } from '../../types/permissions.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
} from '../../types/permissions.js'

type ModeColorKey = 'text' | 'permission' | 'autoAccept' | 'error' | 'warning' | 'success'

type ModeSeal = readonly [title: string, symbol: string, color: ModeColorKey]

const SEALS = {
  default: ['Default', GLYPH.modeDefault, 'text'],
  apollo: ['Apollo Mode', GLYPH.modeApollo, 'permission'],
  implement: ['Implement Mode', GLYPH.modeImplement, 'autoAccept'],
  sovereign: ['Sovereign Mode', GLYPH.modeSovereign, 'error'],
  dontAsk: ["Don't Ask", GLYPH.modeDontAsk, 'error'],
  flow: ['Flow', GLYPH.modeFlow, 'success'],
} as const satisfies Partial<Record<PermissionMode, ModeSeal>>

const sealOf = (mode: PermissionMode): ModeSeal => (mode in SEALS ? SEALS[mode as keyof typeof SEALS] : SEALS.default)

const wordsOf = (modes: readonly string[]) => z.enum(modes)

export function permissionModeSchema(): Unbuilt {
  return notBuilt('src/utils/permissions/PermissionMode.ts:29')
}

export function externalPermissionModeSchema() {
  return wordsOf(EXTERNAL_PERMISSION_MODES)
}

export function modeBypassesPermissions(mode: PermissionMode): boolean {
  return mode === 'sovereign'
}

export function permissionModeFromString(str: string): PermissionMode {
  return notBuilt('src/utils/permissions/PermissionMode.ts:43')
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return notBuilt('src/utils/permissions/PermissionMode.ts:47')
}

export function permissionModeTitle(mode: PermissionMode): string {
  return notBuilt('src/utils/permissions/PermissionMode.ts:51')
}

export function permissionModeSymbol(mode: PermissionMode): string {
  return notBuilt('src/utils/permissions/PermissionMode.ts:55')
}

export function getModeColor(mode: PermissionMode): ModeColorKey {
  return notBuilt('src/utils/permissions/PermissionMode.ts:59')
}
