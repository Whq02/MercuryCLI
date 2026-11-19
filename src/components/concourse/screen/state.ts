import type { RefObject, ReactNode } from 'react'
import type { BoardModalFactsV1 } from '../boardModalOwner.js'
import type { ConcourseCallbacks, ConcourseRowV1, ConcourseSnapshotV1, ControlNoteState } from '../contracts.js'
import type { GitOfferV1 } from '../GitOfferCard.js'
import type { ConcourseCapsuleV2 } from './capsule.js'
import type { useConcourseFrame } from './useConcourseFrame.js'
import type { useConcourseFilter } from './useConcourseFilter.js'
import type { useConcoursePanes } from './useConcoursePanes.js'
import type { useConcourseRail } from './useConcourseRail.js'
import type { useConcourseSelection } from './useConcourseSelection.js'
import type { useConcourseMarks } from './useConcourseMarks.js'
import type { useConcourseDraft } from './useConcourseDraft.js'
import type { useConcourseCloseChord } from './useConcourseCloseChord.js'
import type { concourseRowControls } from './rowControls.js'
import type { useConcourseAsks } from './useConcourseAsks.js'
import type { useConcourseRowLine } from './useConcourseRowLine.js'
import type { useConcourseGeometry } from './useConcourseGeometry.js'
import type { useConcourseRegions } from './useConcourseRegions.js'
import type { useConcourseFaces } from './useConcourseFaces.js'

export type ScreenProps = {
  snapshot: ConcourseSnapshotV1
  callbacks: ConcourseCallbacks
  degraded: boolean
  controlNotes: Readonly<Record<string, ControlNoteState>> | undefined
  reducedStage: boolean
  presentationCapsule: ConcourseCapsuleV2 | null
}

export type ScreenDoors = {
  unfoldOlderList: (row: ConcourseRowV1) => void
  selectSession: (sessionId: string) => void
  moveBoardSelection: (dir: 1 | -1) => void
  closeChordBlocked: () => boolean
  modalFactsNow: () => BoardModalFactsV1
  enterSession: (sessionId: string, opts?: { pointer?: boolean }) => void
  compactSteerOrEnter: (sel: ConcourseRowV1) => void
  gitOffer: GitOfferV1 | undefined
  gitOfferRef: RefObject<GitOfferV1 | undefined>
  openObligationOrDoor: (obligationId: string) => void
  beginAnswer: (obligationId: string) => void
  fullTree: ReactNode
}

export type Frame = ReturnType<typeof useConcourseFrame>
export type Filter = ReturnType<typeof useConcourseFilter>
export type Panes = ReturnType<typeof useConcoursePanes>
export type Rail = ReturnType<typeof useConcourseRail>
export type Selection = ReturnType<typeof useConcourseSelection>
export type Marks = ReturnType<typeof useConcourseMarks>
export type Draft = ReturnType<typeof useConcourseDraft>
export type CloseChord = ReturnType<typeof useConcourseCloseChord>
export type RowControls = ReturnType<typeof concourseRowControls>
export type Asks = ReturnType<typeof useConcourseAsks>
export type RowLine = ReturnType<typeof useConcourseRowLine>
export type Geometry = ReturnType<typeof useConcourseGeometry>
export type Regions = ReturnType<typeof useConcourseRegions>
export type Faces = ReturnType<typeof useConcourseFaces>
