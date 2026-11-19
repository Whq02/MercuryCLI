import type { LineDraft } from '../lineDraft.js'
import type { ConcourseRegion } from '../ConcourseLayout.js'

export interface ConcourseCapsuleV2 {
  region: ConcourseRegion
  filtering: boolean
  filter: LineDraft
  boardSel: string | null
  railSel: string | null
  boardScroll: number | null
}

export function migrateCapsuleRegion(region: string | undefined): ConcourseRegion | undefined {
  if (region === 'mirror') return 'live'
  if (region === 'rail' || region === 'list' || region === 'live' || region === 'chat') return region
  return undefined
}
