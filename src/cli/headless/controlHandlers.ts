
import { errorMessage } from '../../utils/errors.js'
import { type UUID } from 'crypto'
import { type ToolPermissionContext } from 'src/Tool.js'
import type { ParamsOf } from 'src/runner/wire/methods.js'
import { type RewindRefusalKind, type SessionRewindOutcomeV1 } from 'src/daemon/protocol.js'
import { createOperatorRewindRecordMessage } from 'src/services/compact/checkpointRewind.js'
import { type Message } from 'src/types/message.js'
import { findLastCompactBoundaryIndex } from 'src/utils/messages/systemMessages.js'
import { flushSessionStorage, recordTranscript } from 'src/utils/sessionStorage.js'
import { type AppState } from 'src/state/AppStateStore.js'
import { PERMISSION_MODES, type PermissionMode as InternalPermissionMode } from 'src/types/permissions.js'
import { fileHistoryCanRestore, fileHistoryEnabled, fileHistoryRestore, type RestoreDriftOracle } from 'src/utils/fileHistory.js'
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
    return { can_rewind: false, error: 'File rewinding is not enabled.' }
  }
  if (!fileHistoryCanRestore(appState.fileHistory, userMessageId)) {
    return {
      can_rewind: false,
      error: 'No file checkpoint found for this message.',
    }
  }
  let restored: Awaited<ReturnType<typeof fileHistoryRestore>>
  try {
    restored = await fileHistoryRestore(appState.fileHistory, userMessageId, {
      dryRun,
      ownerKey: `rewind:${String(userMessageId)}`,
      ...(drift !== undefined ? { drift } : {}),
    })
  } catch (error) {
    return { can_rewind: false, error: `Failed to rewind: ${errorMessage(error)}` }
  }
  if (!restored.ok) {
    return { can_rewind: false, error: `Failed to rewind: ${restored.detail}` }
  }
  if (dryRun) {
    return { can_rewind: true, files_changed: restored.changed, insertions: restored.insertions, deletions: restored.deletions }
  }
  return { can_rewind: true }
}


export interface RewindSessionContext {
  messages: Message[]
  getAppState: () => AppState
  drift: RestoreDriftOracle
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

export async function handleRewindSession(
  request: ParamsOf<'session/rewind'>,
  ctx: RewindSessionContext,
): Promise<SessionRewindOutcomeV1> {
  const { mode } = request
  const uuid = request.user_message_id
  const dryRun = request.dry_run === true
  if (ctx.turnActive) {
    return refusedRewind(mode, 'turn-active', 'a turn is running in this session — press esc to stop it, then /rewind again')
  }
  const turnIndex = ctx.messages.findIndex(m => isOperatorTurn(m, uuid))
  if (turnIndex === -1) {
    return refusedRewind(mode, 'not-found', "that point is not in this session's conversation")
  }
  const wantsCode = mode === 'code' || mode === 'both'
  const wantsConversation = mode === 'conversation' || mode === 'both'
  if (wantsConversation) {
    const boundary = findLastCompactBoundaryIndex(ctx.messages)
    if (boundary !== -1 && turnIndex <= boundary) {
      return refusedRewind(mode, 'before-compaction', 'that point lies before the last compaction fold — its summary cannot be unpicked; pick a later point or /clear')
    }
  }
  const receipt: SessionRewindOutcomeV1 = { outcome: 'applied', mode, ...(dryRun ? { dryRun: true } : {}) }
  if (wantsCode) {
    if (!fileHistoryEnabled()) {
      return refusedRewind(mode, 'capture-off', 'file checkpoints are off for this session (Settings › File checkpointing) — the conversation can still be restored')
    }
    const state = ctx.getAppState()
    if (!fileHistoryCanRestore(state.fileHistory, uuid as UUID)) {
      return refusedRewind(mode, 'no-checkpoint', 'no saved files at this point — the checkpoint store holds nothing for it')
    }
    let restored: Awaited<ReturnType<typeof fileHistoryRestore>>
    try {
      restored = await fileHistoryRestore(state.fileHistory, uuid as UUID, {
        dryRun,
        ownerKey: `rewind:${uuid}`,
        drift: ctx.drift,
      })
    } catch (error) {
      return refusedRewind(mode, 'restore-failed', `the restore threw before any file was written: ${errorMessage(error)}`)
    }
    if (!restored.ok) return refusedRewind(mode, restored.kind, restored.detail)
    receipt.code = { filesChanged: restored.changed, insertions: restored.insertions, deletions: restored.deletions }
    if (!wantsConversation && restored.changed.length === 0) {
      return { ...receipt, outcome: 'noop', detail: 'the files already match this point — nothing to restore' }
    }
  }
  if (wantsConversation) {
    const removed = ctx.messages.length - turnIndex
    if (dryRun) {
      receipt.conversation = { turnUuid: uuid, removed }
      return receipt
    }
    const record = createOperatorRewindRecordMessage({ turnUuid: uuid, removed })
    ctx.messages.push(record)
    try {
      await recordTranscript([record], undefined, uuid as UUID, ctx.messages)
      await flushSessionStorage()
    } catch (error) {
      const landed = receipt.code !== undefined ? `the files were restored (${receipt.code.filesChanged.length}); ` : ''
      return { ...receipt, outcome: 'refused', refusal: 'restore-failed', detail: `${landed}the conversation boundary could not be written to the transcript: ${errorMessage(error)}` }
    }
    receipt.conversation = { turnUuid: uuid, removed }
  }
  return receipt
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
    return { ok: false, error: `'${String(mode)}' is not a permission mode; the modes are ${PERMISSION_MODES.join(', ')}` }
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
  return {
    ok: true,
    context: {
      ...transitionPermissionMode(toolPermissionContext.mode, mode, toolPermissionContext),
      mode,
    },
  }
}
