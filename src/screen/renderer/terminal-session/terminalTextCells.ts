import { coerce, gte } from 'semver'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

type TextCellProfile = { joinerCells: 0 | 1; shapeRtl: boolean; explicitBidi: boolean }
const TEXT_CELL_PROFILES = new Map<string, TextCellProfile>([
  ['Apple_Terminal', { joinerCells: 1, shapeRtl: true, explicitBidi: false }],
])
const DEFAULT_TEXT_CELL_PROFILE: TextCellProfile = { joinerCells: 0, shapeRtl: false, explicitBidi: false }
const EXPLICIT_BIDI_PROFILE: TextCellProfile = { joinerCells: 0, shapeRtl: true, explicitBidi: true }
const ITERM_EXPLICIT_BIDI_SINCE = '3.7.6'

export function terminalTextCells(
  env: Record<string, string | undefined> = hostEnv(),
): TextCellProfile {
  if (env.TERM_PROGRAM === 'iTerm.app') {
    const version = coerce(env.TERM_PROGRAM_VERSION)
    return version !== null && gte(version, ITERM_EXPLICIT_BIDI_SINCE) ? EXPLICIT_BIDI_PROFILE : DEFAULT_TEXT_CELL_PROFILE
  }
  return TEXT_CELL_PROFILES.get(env.TERM_PROGRAM ?? '') ?? DEFAULT_TEXT_CELL_PROFILE
}
