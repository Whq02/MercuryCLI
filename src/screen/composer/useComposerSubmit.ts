import type React from 'react'
import { useCallback, useRef } from 'react'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { imageBlocksOf } from '../../engine/connector/daemonConnector.js'
import { getCommandName, type Command } from '../../commands/catalogue/commands.js'
import type { Notification } from '../notifications/notifications.js'
import * as pendingInput from './input-core/pending-input.js'
import type { AppState } from '../app-state/AppState.js'
import type { AppStateStore } from '../app-state/AppStateStore.js'
import { composerTargetTaskId } from '../app-state/selectors.js'
import { CREWMATE_BETWEEN_TURNS_DETAIL, LEAD_ROW_NAME, crewmateCommandUnreachableWords, crewmateQueuedWords, crewmateRefusedWords, crewmateResumedWords, operatorLinePlate } from '../cockpit/crewmateWords.js'
import { queueCrewmateLine, refuseCrewmateLine } from '../tasks/crewmateQueue.js'
import { classifyCrewmateViewSubmission } from './promptIntent.js'
import { unknownCommandLine } from '../../engine/user-input/processSlashCommand.js'
import { crewmateCommandReceipt, runCrewmateCommand } from './crewmateCommands.js'
import { isManageableTask } from '../tasks/taskStatus.js'
import { appendMessageToCrewmate, isCrewmateTask, queueOperatorMessage } from '../../engine/tasks/local-agent/crewmateTask.js'
import { createUserMessage } from '../../engine/message-shapes/factories.js'
import { danglingReferences, expandPastedTextRefs, pasteUnavailableLine, resolvePastedContents } from '../../sessions/promptHistory.js'
import { handleSpeculationAccept } from '../prompt-suggestion/speculation.js'
import type { ComposerHelpers } from './input-core/composerHelpers.js'
import type { SuggestionsState } from './typeahead/useTypeahead.js'
import type { usePromptSuggestion } from './usePromptSuggestion.js'
import type { useInputUndo } from './useInputUndo.js'
import type { useArrowKeyHistory } from './useArrowKeyHistory.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'
import type { useComposerCrewmate } from '../tasks/useCrewmateView.js'
import { startMicrotask } from '../../platform/async/timers.js'

const CREWMATE_IMAGE_DETAIL = `a crewmate cannot read images; send the image to ${LEAD_ROW_NAME}, or describe it in words`

type ComposerSubmitOptions = { fromKeybinding?: boolean; isSlashPick?: boolean }

export type ComposerSubmit = (raw: string, options: ComposerSubmitOptions) => Promise<void>

type ComposerSubmitInput = {
  compactWork?: CompactWorkControls
  appStateStore: AppStateStore
  setAppState: (f: (prev: AppState) => AppState) => void
  suggestionApi: ReturnType<typeof usePromptSuggestion>
  commands: Command[]
  helpers: ComposerHelpers
  buffer: ReturnType<typeof useInputUndo>
  history: ReturnType<typeof useArrowKeyHistory>
  onSubmit: (
    input: string,
    helpers: ComposerHelpers,
    speculationAccept?: {
      state: unknown
      sessionTimeSaved: number
      setAppState: (f: (prev: AppState) => AppState) => void
    },
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>
  onCrewmateSubmit?: (input: string) => void | Promise<void>
  setCursorOffset: (offset: number) => void
  writeDraft: (text: string) => void
  addNotification: (notification: Notification) => void
  removeNotification: (key: string) => void
  composerCrewmateRef: React.MutableRefObject<ReturnType<typeof useComposerCrewmate>>
  commandCrewmateRef: React.MutableRefObject<ReturnType<typeof useComposerCrewmate>>
  suggestionsMirrorRef: React.MutableRefObject<SuggestionsState>
}

function footerSelectionVisible(state: AppState): boolean {
  if (state.footerSelection === null) return false
  if (state.footerSelection === 'tasks') {
    return Object.values(state.tasks).some(isManageableTask) || state.viewingCrewmateTaskId !== undefined
  }
  if (state.footerSelection === 'bagel') {
    return state.bagelActive === true
  }
  return state.remoteControlEnabled
}

async function deliverCrewmateLine({
  targetTaskId,
  targetName,
  payload,
  onCrewmateSubmit,
  appStateStore,
  setAppState,
  addNotification,
  notifyCrewmate,
}: {
  targetTaskId: string
  targetName: string
  payload: string
  onCrewmateSubmit?: (input: string) => void | Promise<void>
  appStateStore: AppStateStore
  setAppState: (f: (prev: AppState) => AppState) => void
  addNotification: (notification: Notification) => void
  notifyCrewmate: (noticeText: string, color?: 'warning') => void
}): Promise<boolean> {
  const livePastes = pendingInput.pastedContents()
  const resolved = await resolvePastedContents(payload, livePastes)
  if (resolved.missing.length > 0) {
    addNotification({
      key: 'paste-ref-dangling',
      text: pasteUnavailableLine(resolved.missing[0]!),
      color: 'warning',
      priority: 'high',
      timeoutMs: 8000,
    })
    return false
  }
  if (imageBlocksOf(resolved.pastedContents).length > 0) {
    notifyCrewmate(crewmateRefusedWords(targetName, CREWMATE_IMAGE_DETAIL), 'warning')
    return false
  }
  const expanded = expandPastedTextRefs(payload, resolved.pastedContents)
  if (onCrewmateSubmit !== undefined) {
    await onCrewmateSubmit(expanded)
    return true
  }
  const localTask = appStateStore.getState().tasks[targetTaskId]
  if (localTask !== undefined && isCrewmateTask(localTask)) {
    if (localTask.status !== 'running') {
      notifyCrewmate(crewmateRefusedWords(targetName, CREWMATE_BETWEEN_TURNS_DETAIL), 'warning')
      return false
    }
    queueOperatorMessage(targetTaskId, expanded, setAppState)
    appendMessageToCrewmate(
      targetTaskId,
      { ...createUserMessage({ content: expanded }), queued: true },
      setAppState,
    )
    notifyCrewmate(`${operatorLinePlate(targetName)} ${crewmateQueuedWords(targetName)}`)
    return true
  }
  queueCrewmateLine(targetTaskId, expanded)
  const receipt = await getFocusedSessionConnector().resumeAgent(targetTaskId, expanded)
  if (receipt.outcome === 'refused') {
    const detail = receipt.detail ?? 'no reason given'
    refuseCrewmateLine(targetTaskId, expanded, targetName, detail)
    notifyCrewmate(crewmateRefusedWords(targetName, detail), 'warning')
    return false
  }
  const isQueued = receipt.detail?.includes('"queued":true') === true
  const taken = isQueued ? crewmateQueuedWords(targetName) : crewmateResumedWords(targetName)
  notifyCrewmate(`${operatorLinePlate(targetName)} ${taken}`)
  return true
}

export function useComposerSubmit({
  compactWork,
  appStateStore,
  setAppState,
  suggestionApi,
  commands,
  helpers,
  buffer,
  history,
  onSubmit,
  onCrewmateSubmit,
  setCursorOffset,
  writeDraft,
  addNotification,
  removeNotification,
  composerCrewmateRef,
  commandCrewmateRef,
  suggestionsMirrorRef,
}: ComposerSubmitInput): ComposerSubmit {
  const submittingRef = useRef(false)

  return useCallback<ComposerSubmit>(
    async (raw, options) => {
      if (compactWork !== undefined && compactWork.read() !== 'composer') return

      let text = raw.replace(/\s+$/, '')

      const state = appStateStore.getState()
      if (footerSelectionVisible(state)) return
      if (state.viewSelectionMode === 'selecting-agent') return

      const pastedContents = pendingInput.pastedContents()
      const hasImages = imageBlocksOf(pastedContents).length > 0
      const targetTaskId = composerTargetTaskId(state)

      let speculationAccept:
        | {
            state: unknown
            sessionTimeSaved: number
            setAppState: (f: (prev: AppState) => AppState) => void
          }
        | undefined

      const shownSuggestion =
        state.promptSuggestion.shownAt > 0
          ? text === ''
            ? suggestionApi.suggestion
            : state.promptSuggestion.text
          : null

      if (
        !hasImages &&
        targetTaskId === undefined &&
        shownSuggestion !== null &&
        (text === '' || text === shownSuggestion)
      ) {
        text = shownSuggestion
        suggestionApi.markAccepted()
        if (state.speculation.status === 'active') {
          handleSpeculationAccept(
            state.speculation,
            state.speculationSessionTimeSavedMs,
            setAppState,
            shownSuggestion,
            {},
          )
          speculationAccept = {
            state: state.speculation,
            sessionTimeSaved: state.speculationSessionTimeSavedMs,
            setAppState,
          }
        }
      }

      if (!options.fromKeybinding) {
        if (submittingRef.current) return
        submittingRef.current = true
        startMicrotask(() => {
          submittingRef.current = false
        })
      }

      if (text === '' && !hasImages) return

      const dangling = danglingReferences(text, pastedContents)
      if (dangling.length > 0) {
        addNotification({
          key: 'paste-ref-dangling',
          text: pasteUnavailableLine(dangling[0]!.match),
          color: 'warning',
          priority: 'high',
          timeoutMs: 8000,
        })
        return
      }

      const openSuggestions = suggestionsMirrorRef.current.suggestions
      if (
        !options.isSlashPick &&
        !text.startsWith('/') &&
        openSuggestions.length > 0 &&
        !openSuggestions.every(item => item.description === 'directory')
      ) {
        return
      }

      suggestionApi.logOutcomeAtSubmission(
        text,
        speculationAccept !== undefined ? { skipReset: true } : undefined,
      )
      removeNotification('stash-hint')

      if (pendingInput.mode() === 'bash') {
        await onSubmit(text, helpers, speculationAccept, {
          fromKeybinding: options.fromKeybinding,
        })
        return
      }

      if (targetTaskId !== undefined) {
        const composerCrewmate = composerCrewmateRef.current
        const targetName =
          composerCrewmate !== null && composerCrewmate.taskId === targetTaskId
            ? composerCrewmate.name
            : targetTaskId
        const commandCrewmate = commandCrewmateRef.current

        const takeLine = (submitted: string): void => {
          pendingInput.clearForSubmit(submitted)
          writeDraft('')
          buffer.clearBuffer()
          history.resetHistory()
          setCursorOffset(0)
        }

        const notifyCrewmate = (noticeText: string, color?: 'warning'): void => {
          addNotification({
            key: 'crewmate-send',
            text: noticeText,
            priority: 'medium',
            timeoutMs: 6000,
            ...(color !== undefined ? { color } : {}),
            fold: (_current, incoming) => incoming,
          })
        }

        const intent = classifyCrewmateViewSubmission(
          expandPastedTextRefs(text, pastedContents),
          options.fromKeybinding === true,
          commands,
        )

        switch (intent.kind) {
          case 'unknown-command':
            notifyCrewmate(unknownCommandLine(intent.bareName, commands), 'warning')
            return
          case 'session-command':
          case 'agent-command': {
            if (intent.kind === 'session-command' || intent.command.name === 'model' || intent.command.name === 'effort') {
              await onSubmit(text, helpers, undefined, { fromKeybinding: options.fromKeybinding })
              return
            }
            takeLine(text)
            const receipt = crewmateCommandReceipt(addNotification)
            if (commandCrewmate === null) {
              receipt(crewmateCommandUnreachableWords(targetName, getCommandName(intent.command)), 'warning')
              return
            }
            await runCrewmateCommand(intent.command, text, commandCrewmate, { setAppState, receipt })
            return
          }
          case 'agent-literal':
          case 'agent-guidance': {
            const payload = intent.kind === 'agent-literal' ? intent.text : text
            takeLine(text)
            const delivered = await deliverCrewmateLine({
              targetTaskId,
              targetName,
              payload,
              onCrewmateSubmit,
              appStateStore,
              setAppState,
              addNotification,
              notifyCrewmate,
            })
            if (!delivered) {
              const currentDraft = pendingInput.text()
              const restored = currentDraft.length > 0 ? text + currentDraft : text
              writeDraft(restored)
              setCursorOffset(restored.length)
            }
            return
          }
        }
      }

      await onSubmit(text, helpers, speculationAccept, {
        fromKeybinding: options.fromKeybinding,
      })
    },
    [
      compactWork,
      appStateStore,
      setAppState,
      suggestionApi,
      commands,
      helpers,
      buffer,
      history,
      onSubmit,
      onCrewmateSubmit,
      setCursorOffset,
      writeDraft,
      addNotification,
      removeNotification,
      composerCrewmateRef,
      commandCrewmateRef,
      suggestionsMirrorRef,
    ],
  )
}
