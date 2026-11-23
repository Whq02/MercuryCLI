import type { useSetAppState, AppState } from '../../app-state/AppState.js'
import type { useOpenEventGate } from '../../widgets/useOpenEventGate.js'
import type { CrewStopArm } from '../../widgets/faces/crewStopChord.js'
import type { BoardItem } from './rows.js'
import type { Dispatch, SetStateAction } from 'react'

export type MissionTask = { id: string; subject: string; activeForm?: string; status: string }

export type BoardContext = { onDone: () => void; setAppState: ReturnType<typeof useSetAppState>; setDetailTaskId: Dispatch<SetStateAction<string | undefined>>; stopArm: CrewStopArm | null; setStopArm: Dispatch<SetStateAction<CrewStopArm | null>>; ownsInputNow: () => boolean; pastOpen: ReturnType<typeof useOpenEventGate>; selected: BoardItem | undefined; stopSelected: (item: BoardItem) => void; summaryEntry: boolean; tasks: AppState['tasks'] }
