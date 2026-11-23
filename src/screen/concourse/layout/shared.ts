import { GLYPH } from '../../theme/glyphs.js'
import { effortLevelToSymbol } from '../../widgets/effortIndicator.js'
import { EFFORT_HIGH } from '../../theme/rowGlyphs.js'
import { isEffortLevel } from '../../../models/effort/effort.js'
import { PARK_REFUSED_NOW_LEAD } from '../../concourse-model/concourseSnapshot.js'

export type ConcourseProfile = 'stacked' | 'wide'

export const NEW_SESSION_ROW_ID = 'new-session'
export const NEW_SESSION_DOOR_WORDS = 'n starts a blank session in this project'

export function newSessionDoorWords(opts: { region: string; filtering: boolean }): string {
  return opts.region === 'list' && !opts.filtering ? NEW_SESSION_DOOR_WORDS : `tab to the list, then ${NEW_SESSION_DOOR_WORDS}`
}

export function newSessionDoorTail(door: { modelLabel: string; effortLevel: string }): string {
  return ` · ${door.modelLabel} · ${isEffortLevel(door.effortLevel) ? effortLevelToSymbol(door.effortLevel) : EFFORT_HIGH} ${door.effortLevel}`
}

export function rowNeedsOperator(row: { state: string; nowLabel?: string | null }, ask?: string): boolean {
  const now = row.nowLabel ?? ''
  return (ask !== undefined && ask.length > 0) || (row.state === 'needs-you' && now.length > 0) || now.startsWith(PARK_REFUSED_NOW_LEAD)
}

export const MORE_BEYOND_ROW = '⋮'

export type ConcourseRegion = 'rail' | 'list' | 'live' | 'chat'

export interface SwitchboardGeometry {
  constrained?: boolean
  profile: ConcourseProfile
  interior: number
  railRows: number
  railWindowRows: number
  mainBand: [number, number]
  mainRows: number
  liveComposerRows: number
  liveComposerBand: [number, number]
  statusTop: number
  helpTop: number
  liveCols: [number, number]
  rightCols: [number, number]
  listBand: [number, number]
  mirrorBand: [number, number]
  thirdBand: [number, number]
  listContentRows: number
  peekRows: number
}

export const STATE_GLYPH: Record<string, { glyph: string; color: 'success' | 'warning' | 'failure' | 'info' | 'textMuted' | 'infoText' }> = {
  'ready-to-review': { glyph: GLYPH.ok, color: 'success' },
  working: { glyph: GLYPH.pending, color: 'info' },
  'needs-you': { glyph: GLYPH.mission, color: 'warning' },
  attached: { glyph: '▣', color: 'infoText' },
  stalled: { glyph: GLYPH.uptri, color: 'warning' },
  failed: { glyph: GLYPH.fail, color: 'failure' },
  queued: { glyph: GLYPH.squareOpen, color: 'textMuted' },
  starting: { glyph: '◐', color: 'textMuted' },
  paused: { glyph: '◌', color: 'textMuted' },
  stopped: { glyph: '◇', color: 'textMuted' },
  completed: { glyph: GLYPH.ok, color: 'textMuted' },
  cancelled: { glyph: GLYPH.circledSlash, color: 'textMuted' },
  draft: { glyph: GLYPH.typing, color: 'textMuted' },
  parked: { glyph: GLYPH.sparkFaint, color: 'textMuted' },
  elsewhere: { glyph: GLYPH.handoff, color: 'info' },
}

export const STATE_WORD: Record<string, string> = {
  'ready-to-review': 'ready',
  working: 'working',
  'needs-you': 'NEEDS YOU',
  attached: 'with you',
  stalled: 'stalled',
  failed: 'failed',
  queued: 'queued',
  starting: 'starting',
  paused: 'paused',
  stopped: 'stopped',
  completed: 'done',
  cancelled: 'cancelled',
  draft: 'draft',
  parked: 'parked',
  elsewhere: 'a door',
}

export const STATE_WORD_RESERVE = Math.max(
  ...Object.values(STATE_WORD).map(word => word.length),
)

export function stateWordCell(word: string | null): string {
  return ` ${(word ?? '').slice(0, STATE_WORD_RESERVE).padEnd(STATE_WORD_RESERVE)}`
}

export interface ConcourseLayoutWiring {
  selectSession: (sessionId: string) => void
  enterSession: (sessionId: string) => void
  selectObligation: (index: number) => void
  answerObligation: (obligationId: string) => void
  openObligation: (obligationId: string) => void
  focusList?: () => void
  retrySnapshot?: () => void
  withdrawObligation?: (obligationId: string) => void
  openGroundPicker?: () => void
  newSession?: () => void
}
