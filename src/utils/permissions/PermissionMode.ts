/**
 * The permission-mode enum, per-mode presentation config, and the
 * bypass-semantics predicate. Mercury adds the flow/autopilot/scribe modes
 * and `modeBypassesPermissions`.
 *
 * Mode tokens: the per-station symbols are the
 * Mercury SEAL family from the one glyph vocabulary (mercury-ui/glyphs.ts,
 * the `mode*` block) — the base transport dialect (⏵/⏵⏵/pause) is retired.
 * Colours stay theme ROLES (getModeColor) so the band, the consent card and
 * the teams rows tint through the theme, never a literal.
 */
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

/** Colour roles a mode can carry (module-internal alias; consumers see it structurally). */
type ModeColorKey =
  | 'text'
  | 'planMode'
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

/**
 * Per-mode presentation. A partial map: a mode with no entry (today, only
 * `bubble`) falls back to the `default` entry's config.
 *
 * Symbols are the Mercury mode-seal family (GLYPH.mode*, one vocabulary
 * home; width-1 ratcheted by scripts/ui/prove-glyph-width.ts). `default`
 * carries a real seal for the per-teammate surfaces — the footer band still
 * paints nothing in default (isDefaultMode gates it). The Apollo interview
 * station wears ∵ (GLYPH.modeApollo) and the `permission` colour role —
 * the deliberative station beside strategy, distinct from strategy's
 * planMode tint in the band.
 *
 * The identity ruling goes all the way down: the ids
 * ARE the names — strategy · implement · flow · sovereign (default and
 * autopilot unchanged). Retired spellings (plan/acceptEdits/auto/
 * bypassPermissions) decode through the ONE bounded alias at every read
 * boundary and are never written again.
 */
const MODE_CONFIG: Partial<Record<PermissionMode, ModeConfig>> = {
  default: { title: 'Default', symbol: GLYPH.modeDefault, color: 'text', external: 'default' },
  strategy: { title: 'Strategy Mode', symbol: GLYPH.modeStrategy, color: 'planMode', external: 'strategy' },
  apollo: { title: 'Apollo Mode', symbol: GLYPH.modeApollo, color: 'permission', external: 'default' },
  implement: { title: 'Implement Mode', symbol: GLYPH.modeImplement, color: 'autoAccept', external: 'implement' },
  sovereign: { title: 'Sovereign Mode', symbol: GLYPH.modeSovereign, color: 'error', external: 'sovereign' },
  dontAsk: { title: "Don't Ask", symbol: GLYPH.modeDontAsk, color: 'error', external: 'dontAsk' },
  flow: { title: 'Flow', symbol: GLYPH.modeFlow, color: 'success', external: 'default' },
  autopilot: { title: 'Autopilot', symbol: GLYPH.modeAutopilot, color: 'error', external: 'sovereign' },
  scribe: { title: 'Scribe Mode', symbol: GLYPH.modeScribe, color: 'warning', external: 'default' },
}

function configFor(mode: PermissionMode): ModeConfig {
  return MODE_CONFIG[mode] ?? (MODE_CONFIG.default as ModeConfig)
}

/**
 * Lazy zod enum over the runtime internal mode list (external +
 * flow/scribe/autopilot). Retired spellings decode through the bounded alias
 * BEFORE validation, so a record written by an old build (or the `.claude/`
 * compat estate) still parses — to the new id.
 */
export function permissionModeSchema() {
  return z.preprocess(
    v => (typeof v === 'string' ? decodePermissionModeSpelling(v) : v),
    z.enum(PERMISSION_MODES as unknown as [string, ...string[]]),
  )
}

/** Lazy zod enum over the external mode set (alias-decoded like {@link permissionModeSchema}). */
export function externalPermissionModeSchema() {
  return z.preprocess(
    v => (typeof v === 'string' ? decodePermissionModeSpelling(v) : v),
    z.enum(EXTERNAL_PERMISSION_MODES as unknown as [string, ...string[]]),
  )
}

/** A type guard that, in this build, is unconditionally true. */
export function isExternalPermissionMode(_mode: PermissionMode): _mode is ExternalPermissionMode {
  return true
}

/**
 * The single bypass-semantics predicate. True for exactly sovereign and
 * autopilot. Every decision site that treats bypass as auto-allow routes
 * through it so autopilot can never drift from sovereign.
 */
export function modeBypassesPermissions(mode: PermissionMode): boolean {
  return mode === 'sovereign' || mode === 'autopilot'
}

/** The external projection of a mode. */
export function toExternalPermissionMode(mode: PermissionMode): ExternalPermissionMode {
  return configFor(mode).external
}

/**
 * Returns the input when it names a RUNTIME mode, otherwise `default`. A
 * retired spelling decodes through the bounded alias first (settings files,
 * resumed sessions, roster records and CLI muscle memory keep working — as
 * the new id). The type-union-only `bubble` is deliberately not
 * user-addressable: it is not in the runtime set the mode schema enumerates,
 * so a `bubble` string parses to `default`, exactly as the schema rejects it.
 */
export function permissionModeFromString(str: string): PermissionMode {
  const decoded = decodePermissionModeSpelling(str)
  return (PERMISSION_MODES as readonly string[]).includes(decoded)
    ? (decoded as PermissionMode)
    : 'default'
}

/** True for `default` and for `undefined`. */
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
