import { errorMessage } from '../../utils/errors.js'
import { type UUID } from 'crypto'
import { type ToolPermissionContext } from 'src/Tool.js'
import type { ParamsOf } from 'src/runner/wire/methods.js'
import type { SESSION_VERBS } from 'src/runner/wire/sessionVerbs.js'
import { type RewindRefusalKind, type SessionRewindOutcomeV1 } from 'src/daemon/protocol.js'
import { createOperatorRewindRecordMessage } from 'src/services/compact/checkpointRewind.js'
import { type Message } from 'src/types/message.js'
import { findLastCompactBoundaryIndex } from 'src/utils/messages/systemMessages.js'
import { flushSessionStorage, recordTranscript } from 'src/utils/sessionStorage.js'
import { type AppState } from 'src/state/AppStateStore.js'
import { PERMISSION_MODES, type PermissionMode as InternalPermissionMode } from 'src/types/permissions.js'
import { fileCheckpointSource, fileHistoryCanRestore, fileHistoryEnabled, fileHistoryRestore, type RestoreDriftOracle } from 'src/services/changeTransaction/fileHistory.js'
import { holdModeTransition, type ModeTransitionRoad, recordModeTransition } from 'src/utils/permissions/modeTransitions.js'
import { isSovereignDisabled, transitionPermissionMode } from 'src/utils/permissions/permissionSetup.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type RewindFilesResult = {
  can_rewind?: boolean
  files_changed?: string[]
  insertions?: number
  deletions?: number
  restored_files?: number
  deleted_files?: number
  dry_run?: boolean
  error?: string
}

export async function handleRewindFiles(
  userMessageId: UUID,
  appState: AppState,
  _setAppState: (updater: (prev: AppState) => AppState) => void,
  dryRun: boolean,
  drift?: RestoreDriftOracle,
): Promise<RewindFilesResult> {
  return notBuilt('src/cli/headless/controlHandlers.ts:29')
}


type RewindSessionContext = Unbuilt

function refusedRewind(mode: SessionRewindOutcomeV1['mode'], refusal: RewindRefusalKind, detail: string): SessionRewindOutcomeV1 {
  return { outcome: 'refused', mode, refusal, detail }
}

function isOperatorTurn(message: Message, uuid: string): boolean {
  if (message.type !== 'user' || message.uuid !== uuid) return false
  if ((message as { isMeta?: boolean }).isMeta === true) return false
  const content = message.message.content
  if (Array.isArray(content) && content[0]?.type === 'tool_result') return false
  return true
}

export async function handleRewindSession(
  request: ParamsOf<typeof SESSION_VERBS.rewind.runner.name>,
  ctx: RewindSessionContext,
): Promise<SessionRewindOutcomeV1> {
  return notBuilt('src/cli/headless/controlHandlers.ts:85')
}


export async function handleFileRestoreSession(request: ParamsOf<typeof SESSION_VERBS.fileRestore.runner.name>, ctx: RewindSessionContext): Promise<SessionRewindOutcomeV1> {
  return notBuilt('src/cli/headless/controlHandlers.ts:155')
}
export function resolvePermissionModeTransition(
  mode: InternalPermissionMode,
  toolPermissionContext: ToolPermissionContext,
  road: ModeTransitionRoad = 'control-door',
): { ok: true; context: ToolPermissionContext } | { ok: false; error: string } {
  const verdict = decidePermissionModeTransition(mode, toolPermissionContext)
  if (toolPermissionContext.mode !== mode) {
    if (verdict.ok) recordModeTransition({ from: toolPermissionContext.mode, to: mode, road })
    else holdModeTransition({ from: toolPermissionContext.mode, to: mode, road, detail: verdict.error })
  }
  return verdict
}

function decidePermissionModeTransition(
  mode: InternalPermissionMode,
  toolPermissionContext: ToolPermissionContext,
): { ok: true; context: ToolPermissionContext } | { ok: false; error: string } {
  return notBuilt('src/cli/headless/controlHandlers.ts:194')
}
