import { z } from 'zod/v4'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { EXTERNAL_PERMISSION_MODES, PERMISSION_MODES, type PermissionMode } from '../../types/permissions.js'

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

const wordsOf = (modes: readonly string[]) => z.enum(modes as unknown as [string, ...string[]])

export function permissionModeSchema() {
  return wordsOf(PERMISSION_MODES)
}

export function externalPermissionModeSchema() {
  return wordsOf(EXTERNAL_PERMISSION_MODES)
}

export function modeBypassesPermissions(mode: PermissionMode): boolean {
  return mode === 'sovereign'
}

const ADDRESSABLE_WORDS: ReadonlySet<string> = new Set(PERMISSION_MODES)

export function permissionModeFromString(str: string): PermissionMode {
  return ADDRESSABLE_WORDS.has(str) ? (str as PermissionMode) : 'default'
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return (mode ?? 'default') === 'default'
}

export function permissionModeTitle(mode: PermissionMode): string {
  return sealOf(mode)[0]
}

export function permissionModeSymbol(mode: PermissionMode): string {
  return sealOf(mode)[1]
}

export function getModeColor(mode: PermissionMode): ModeColorKey {
  return sealOf(mode)[2]
}
