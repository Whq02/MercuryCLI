import type { TaskStatus } from '../../../Task.js'
import type { TaskState } from '../../../tasks/types.js'
import type { SessionListing } from '../../../types/logs.js'
import type { WorkRosterV1 } from '../../engine-connector/types.js'
import type { CrewAgentFacts } from '../../engine-connector/crewFacts.js'
import type { CrewLedgerRow } from '../../../state/crewLedger.js'
import type { RunSnapshot } from '../../run/runKernel.js'
import type { ActiveSourceUsage } from '../../providers/providerUsage.js'
import type { LiveContextUsage } from '../contextUsageLive.js'
import type { ComposedCertChip } from '../../../utils/healthCertCore.js'
import type { SaturnWakeGlanceV1 } from '../../../daemon/saturn.js'
import type { HelmRow } from '../../../utils/cockpit/helmFocus.js'
import type { ActivityState } from '../../../utils/cockpit/cockpitActivity.js'
import type { MercuryThemeTokens } from '../../../utils/mercuryTokens.js'

export type RunKind = 'shell' | 'monitor' | 'run'
export type RunRow = { id: string; title: string; status: TaskStatus; kind: RunKind; startedAtMs: number }

export type CrewRow = { id: string; label: string; status: TaskStatus; hosted?: boolean; facts?: CrewAgentFacts }
export type CrewEntry = { kind: 'task'; row: CrewRow }

export type WorkLedgerRow = { id: string; status: string; blockedBy?: readonly string[] }
export type WorkDigest = { rows: Array<{ text: string; color: string }>; doneCount: number; total: number; terminal: boolean }

export type GlanceReads = {
  sessionModel: string
  usage: ActiveSourceUsage
  focusedSpendUSD: number
  focusedUnpriced: number
  ctx: LiveContextUsage
  chip: ComposedCertChip
  nowMs: number
}

export type LanesRowSpec =
  | {
      kind: 'rail'
      key: string
      glyph: string
      glyphColor: string
      glyphLive?: boolean
      name: string
      nameColor: string
      nameBold?: boolean
      verb?: string
      verbColor?: string
      verbPulse?: boolean
      marked?: boolean
      directActivate?: boolean
      tint?: string
      row?: HelmRow
    }
  | { kind: 'text'; key: string; text: string; color: string }
  | { kind: 'card'; key: string; lines: string[] | null; row: HelmRow }
  | { kind: 'more'; key: string; n: number; row: HelmRow }

export type LanesSectionSpec = {
  key: string
  glyph: string
  label: string
  count?: string
  open?: string | 'files'
  rows: LanesRowSpec[]
  marginAlways?: boolean
}

export type LanesInput = {
  width: number
  mergedVitals: boolean
  availRows: number | undefined
  activity: ActivityState
  cursorRow: HelmRow | undefined
  sessionCrew: readonly CrewLedgerRow[]
  viewingAgentTaskId: string | undefined
  mainChatTaskId: string | undefined
  tasks: Record<string, TaskState>
  roster: Pick<WorkRosterV1, 'rows'>
  workRunSnap: RunSnapshot | null
  ledger: readonly WorkLedgerRow[]
  lastSentPrompt: string | null
  filesOff: boolean
  filesFolder: string
  recent: SessionListing[] | null
  missionCondition: string | null
  wakeGlance: SaturnWakeGlanceV1 | null
  glance: GlanceReads | null
  nowMs: number
  tok: MercuryThemeTokens
  accent: string
}
