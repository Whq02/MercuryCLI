type TextCellProfile = { joinerCells: 0 | 1; shapeRtl: boolean }
const TEXT_CELL_PROFILES = new Map<string, TextCellProfile>([
  ['Apple_Terminal', { joinerCells: 1, shapeRtl: true }],
])
const DEFAULT_TEXT_CELL_PROFILE: TextCellProfile = { joinerCells: 0, shapeRtl: false }

export function terminalTextCells(
  env: Record<string, string | undefined> = process.env,
): TextCellProfile {
  return TEXT_CELL_PROFILES.get(env.TERM_PROGRAM ?? '') ?? DEFAULT_TEXT_CELL_PROFILE
}
