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
  if (!fileHistoryEnabled()) {
    return {
      can_rewind: false,
      error: 'File rewinding is not enabled.',
    }
  }
  if (!fileHistoryCanRestore(appState.fileHistory, userMessageId)) {
    return {
      can_rewind: false,
      error: 'No file checkpoint found for this message.',
    }
  }
  try {
    const result = await fileHistoryRestore(appState.fileHistory, userMessageId, {
      dryRun,
      ownerKey: `rewind:${userMessageId}`,
      ...(drift !== undefined ? { drift } : {}),
    })
    if (!result.ok) {
      return {
        can_rewind: false,
        error: `Failed to rewind: ${result.detail}`,
      }
    }
    if (dryRun) {
      return {
        can_rewind: true,
        files_changed: result.changed,
        insertions: result.insertions,
        deletions: result.deletions,
      }
    }
    return { can_rewind: true }
  } catch (error) {
    return {
      can_rewind: false,
      error: `Failed to rewind: ${errorMessage(error)}`,
    }
  }
}


type RewindSessionContext = {
  messages: Message[]
  getAppState: () => AppState
  setAppState?: (updater: (prev: AppState) => AppState) => void
  drift?: RestoreDriftOracle
  turnActive: boolean
}

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

function captureOffDetail(): string {
  return fileCheckpointSource() === 'setting'
    ? 'File checkpoints are disabled in settings.'
    : 'File checkpoints are not enabled for this session (pass file_checkpoints on initialize to enable them).'
}

function fileHistoryUpdaterOf(ctx: RewindSessionContext): ((updater: (prev: AppState['fileHistory']) => AppState['fileHistory']) => void) | undefined {
  if (!ctx.setAppState) return undefined
  const setAppState = ctx.setAppState
  return updater => {
    setAppState(prev => ({ ...prev, fileHistory: updater(prev.fileHistory) }))
  }
}

export async function handleRewindSession(
  request: ParamsOf<typeof SESSION_VERBS.rewind.runner.name>,
  ctx: RewindSessionContext,
): Promise<SessionRewindOutcomeV1> {
  const { mode, user_message_id: userMessageId } = request
  const dryRun = request.dry_run === true
  if (ctx.turnActive) {
    return refusedRewind(mode, 'turn-active', 'Cannot rewind while a turn is running.')
  }
  const turnIndex = ctx.messages.findIndex(message => isOperatorTurn(message, userMessageId))
  if (turnIndex === -1) {
    return refusedRewind(mode, 'not-found', `No operator turn found with id ${userMessageId}.`)
  }
  const wantsConversation = mode === 'conversation' || mode === 'both'
  const wantsCode = mode === 'code' || mode === 'both'
  if (wantsConversation) {
    const compactIndex = findLastCompactBoundaryIndex(ctx.messages)
    if (compactIndex !== -1 && turnIndex < compactIndex) {
      return refusedRewind(mode, 'before-compaction', 'Cannot rewind conversation to before the last compaction boundary.')
    }
  }
  let code: SessionRewindOutcomeV1['code']
  if (wantsCode) {
    if (!fileHistoryEnabled()) {
      return refusedRewind(mode, 'capture-off', captureOffDetail())
    }
    const appState = ctx.getAppState()
    if (!fileHistoryCanRestore(appState.fileHistory, userMessageId as UUID)) {
      return refusedRewind(mode, 'no-checkpoint', `No file checkpoint found for message ${userMessageId}.`)
    }
    const updateState = fileHistoryUpdaterOf(ctx)
    try {
      const restored = await fileHistoryRestore(appState.fileHistory, userMessageId as UUID, {
        dryRun,
        ownerKey: `rewind:${userMessageId}`,
        ...(ctx.drift !== undefined ? { drift: ctx.drift } : {}),
        ...(updateState !== undefined ? { updateState } : {}),
      })
      if (!restored.ok) {
        return refusedRewind(mode, restored.kind, restored.detail)
      }
      code = {
        filesChanged: restored.changed,
        insertions: restored.insertions,
        deletions: restored.deletions,
      }
    } catch (error) {
      return refusedRewind(mode, 'restore-failed', errorMessage(error))
    }
  }
  let conversation: SessionRewindOutcomeV1['conversation']
  if (wantsConversation) {
    const removed = ctx.messages.length - turnIndex
    conversation = { turnUuid: userMessageId, removed }
    if (!dryRun) {
      const record = createOperatorRewindRecordMessage({ turnUuid: userMessageId, removed })
      ctx.messages.push(record)
      await recordTranscript([record], undefined, ctx.messages)
      await flushSessionStorage()
    }
  }
  return {
    outcome: 'applied',
    mode,
    ...(dryRun ? { dryRun: true } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(conversation !== undefined ? { conversation } : {}),
  }
}


export async function handleFileRestoreSession(request: ParamsOf<typeof SESSION_VERBS.fileRestore.runner.name>, ctx: RewindSessionContext): Promise<SessionRewindOutcomeV1> {
  const dryRun = request.dry_run === true
  if (ctx.turnActive) {
    return refusedRewind('code', 'turn-active', 'Cannot restore files while a turn is running.')
  }
  if (!fileHistoryEnabled()) {
    return refusedRewind('code', 'capture-off', captureOffDetail())
  }
  const appState = ctx.getAppState()
  const userMessageId = request.user_message_id as UUID
  if (request.action === 'restore' && !fileHistoryCanRestore(appState.fileHistory, userMessageId)) {
    return refusedRewind('code', 'no-checkpoint', `No file checkpoint found for message ${userMessageId}.`)
  }
  const updateState = fileHistoryUpdaterOf(ctx)
  try {
    const restored = await fileHistoryRestore(appState.fileHistory, userMessageId, {
      dryRun,
      ownerKey: `rewind:${userMessageId}`,
      ...(ctx.drift !== undefined ? { drift: ctx.drift } : {}),
      ...(request.action === 'restore' ? { filePath: request.file_path } : { undo: true }),
      ...(updateState !== undefined ? { updateState } : {}),
    })
    if (!restored.ok) {
      return refusedRewind('code', restored.kind, restored.detail)
    }
    return {
      outcome: 'applied',
      mode: 'code',
      ...(dryRun ? { dryRun: true } : {}),
      code: {
        filesChanged: restored.changed,
        insertions: restored.insertions,
        deletions: restored.deletions,
      },
    }
  } catch (error) {
    return refusedRewind('code', 'restore-failed', errorMessage(error))
  }
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
  if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
    return {
      ok: false,
      error: `'${mode}' is not a permission mode; the modes are ${PERMISSION_MODES.join(', ')}`,
    }
  }
  if (mode === 'sovereign') {
    if (isSovereignDisabled()) {
      return {
        ok: false,
        error: 'Cannot set permission mode to sovereign because it is disabled by settings or configuration',
      }
    }
    if (!toolPermissionContext.isBypassPermissionsModeAvailable) {
      return {
        ok: false,
        error: 'Cannot set permission mode to sovereign because the session was not launched with --sovereign',
      }
    }
  }
  const transitioned = transitionPermissionMode(toolPermissionContext.mode, mode, toolPermissionContext)
  return {
    ok: true,
    context: {
      ...transitioned,
      mode,
    },
  }
}
