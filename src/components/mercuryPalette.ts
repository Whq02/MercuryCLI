
export const TERRA = '#DD4444'
export const IVORY = '#EDE8DD'
export const SECOND = '#A9B4AC'
export const FAINT = '#71807B'
export const TEAL = '#3FBFA0'
export const AMBER = '#DBA13D'
export const CRIMSON = '#E8556A'
export const CLAW = '#7B3232'
export const OASIS = '#3F7E96'
export const BELLY = '#E58484'
export const DUNE = '#2F4B52'
export const SAND = SECOND

export const NIGHT = '#0D181B'
export const NIGHT_SOFT = '#101D21'
export const ASH = '#142327'
export const ASH_RAISED = '#1A2C31'
export const DUNE_FAINT = '#233A40'

export const SURFACE_PANEL = ASH

export const DIFF_ADD_BG = '#082620'
export const DIFF_ADD_WORD = '#0E4036'
export const DIFF_DEL_BG = '#301014'
export const DIFF_DEL_WORD = '#501A20'
export const SURFACE_RAISED = ASH_RAISED

export type GroundFamily = {
  NIGHT: string
  NIGHT_SOFT: string
  ASH: string
  ASH_RAISED: string
  DUNE_FAINT: string
  DUNE: string
}

export const OASIS_GROUND: GroundFamily = {
  NIGHT,
  NIGHT_SOFT,
  ASH,
  ASH_RAISED,
  DUNE_FAINT,
  DUNE,
}

export const TRUE_BLACK_GROUND: GroundFamily = {
  NIGHT: '#000000',
  NIGHT_SOFT: '#080F11',
  ASH: '#0B1315',
  ASH_RAISED: '#0E181B',
  DUNE_FAINT: '#132023',
  DUNE: '#1A292D',
}

export function groundFamilyFor(themeName: string): GroundFamily {
  return themeName === 'true-black' ? TRUE_BLACK_GROUND : OASIS_GROUND
}

export const mercuryPalette = {
  TERRA,
  IVORY,
  SECOND,
  FAINT,
  TEAL,
  AMBER,
  CRIMSON,
  CLAW,
  OASIS,
  BELLY,
  DUNE,
  SAND,
  NIGHT,
  NIGHT_SOFT,
  ASH,
  ASH_RAISED,
  DUNE_FAINT,
  SURFACE_PANEL,
  SURFACE_RAISED,
} as const

export type MercuryPalette = typeof mercuryPalette
