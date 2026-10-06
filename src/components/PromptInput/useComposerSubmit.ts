import type React from 'react'
import { useCallback, useRef } from 'react'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { Command } from '../../commands.js'
import type { Notification } from '../../context/notifications.js'
import * as pendingInput from '../../input-core/pending-input.js'
import type { AppState } from '../../state/AppState.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import { composerTargetTaskId } from '../../state/selectors.js'
import { CREWMATE_BETWEEN_TURNS_DETAIL, crewmateQueuedWords, crewmateRefusedWords, crewmateResumedWords, operatorLinePlate } from '../../utils/cockpit/crewmateWords.js'
import { queueCrewmateLine, refuseCrewmateLine } from '../tasks/crewmateQueue.js'
import { classifyAgentViewSubmission } from './promptIntent.js'
import { isManageableTask } from '../tasks/taskStatusUtils.js'
import { appendMessageToLocalAgent, isLocalAgentTask, queueOperatorMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { sendLiveMessage } from '../../services/crew/liveComms.js'
import { isCrewEnabled } from '../../utils/crewEnabled.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { danglingReferences, pasteUnavailableLine } from '../../history.js'
import { parseDirectMemberMessage, sendDirectMemberMessage } from '../../utils/directMemberMessage.js'
import { handleSpeculationAccept } from '../../services/PromptSuggestion/speculation.js'
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js'
import type { SuggestionsState } from '../../hooks/useTypeahead.js'
import type { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js'
import type { useInputBuffer } from '../../hooks/useInputBuffer.js'
import type { useArrowKeyHistory } from '../../hooks/useArrowKeyHistory.js'
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js'
import type { useComposerCrewmate } from '../tasks/useCrewmateView.js'

const DOUBLED_SLASH = '//'

export type ComposerSubmitOptions = { fromKeybinding?: boolean; isSlashPick?: boolean }

export type ComposerSubmit = (raw: string, options: ComposerSubmitOptions) => Promise<void>

export type ComposerSubmitInput = {
  compactWork: CompactWorkControls | undefined
  appStateStore: AppStateStore
  suggestionApi: ReturnType<typeof usePromptSuggestion>
  crewContext: AppState['crewContext']
  commands: Command[]
  helpers: PromptInputHelpers
  buffer: ReturnType<typeof useInputBuffer>
  history: ReturnType<typeof useArrowKeyHistory>
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: {
      state: unknown
      speculationSessionTimeSavedMs: number
      setAppState: (f: (prev: AppState) => AppState) => void
    },
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>
  onAgentSubmit: ((text: string) => void) | undefined
  setAppState: (f: (prev: AppState) => AppState) => void
  setCursorOffset: (offset: number) => void
  addNotification: (notification: Notification) => void
  removeNotification: (key: string) => void
  composerCrewmateRef: React.MutableRefObject<ReturnType<typeof useComposerCrewmate>>
  suggestionsMirrorRef: React.MutableRefObject<SuggestionsState>
  writeDraft: (text: string) => void
}

export function useComposerSubmit({
  compactWork,
  appStateStore,
  suggestionApi,
  crewContext,
  commands,
  helpers,
  buffer,
  history,
  onSubmit,
  onAgentSubmit,
  setAppState,
  setCursorOffset,
  addNotification,
  removeNotification,
  composerCrewmateRef,
  suggestionsMirrorRef,
  writeDraft,
}: ComposerSubmitInput): ComposerSubmit {
  const sameDispatchSubmitRef = useRef(false)
  const submit = useCallback(
    async (
      raw: string,
      options: { fromKeybinding?: boolean; isSlashPick?: boolean },
    ): Promise<void> => {
      if (compactWork !== undefined && compactWork.read() !== 'composer') return
      const value = raw.replace(/\s+$/, '')
      const fresh = appStateStore.getState() as AppState

      if (fresh.footerSelection !== null) {
        const stillVisible =
          fresh.footerSelection === 'tasks'
            ? Object.values(fresh.tasks).some(isManageableTask) ||
              fresh.viewingAgentTaskId !== undefined
            : fresh.footerSelection === 'bagel'
                ? fresh.bagelActive === true
                : fresh.remoteControlEnabled
        if (stillVisible) return
      }
      if (fresh.viewSelectionMode === 'selecting-agent') return

      const hasImages = Object.values(pendingInput.pastedContents()).some(
        entry => (entry as { type?: string }).type === 'image',
      )

      const suggestion = suggestionApi.suggestion
      const suggestionSeen =
        ((fresh as { promptSuggestion?: { shownAt?: number | null } })
          .promptSuggestion?.shownAt ?? 0) > 0
      let submitted = value
      let speculationAccept:
        | {
            state: unknown
            speculationSessionTimeSavedMs: number
            setAppState: (f: (prev: AppState) => AppState) => void
          }
        | undefined
      if (
        suggestion !== null &&
        suggestionSeen &&
        !hasImages &&
        composerTargetTaskId(fresh) === undefined &&
        (value === '' || value === suggestion)
      ) {
        suggestionApi.markAccepted()
        submitted = suggestion
        const spec = (fresh as { speculation?: { status?: string } }).speculation
        if (spec?.status === 'active') {
          const savedMs =
            (fresh as { speculationSessionTimeSavedMs?: number }).speculationSessionTimeSavedMs ?? 0
          handleSpeculationAccept(spec, savedMs, setAppState, suggestion, undefined)
          speculationAccept = {
            state: spec,
            speculationSessionTimeSavedMs: savedMs,
            setAppState,
          }
        }
      }

      const takeLine = (): void => {
        pendingInput.clearForSubmit(submitted)
        writeDraft('')
        buffer.clearBuffer()
        history.resetHistory()
        setCursorOffset(0)
      }
      const handBack = (): void => {
        const restored = `${submitted}${pendingInput.text()}`
        writeDraft(restored)
        setCursorOffset(restored.length)
      }

      if (!options.fromKeybinding) {
        if (sameDispatchSubmitRef.current) return
        sameDispatchSubmitRef.current = true
        queueMicrotask(() => {
          sameDispatchSubmitRef.current = false
        })
      }

      if (isCrewEnabled() && crewContext !== undefined && submitted.startsWith('@')) {
        const parsed = parseDirectMemberMessage(submitted)
        if (parsed !== null) {
          const result = await sendDirectMemberMessage(
            parsed.recipientName,
            parsed.message,
            crewContext,
            sendLiveMessage,
          )
          if (result.success) {
            takeLine()
            addNotification({
              key: 'direct-message-sent',
              text: `sent to @${result.recipientName}`,
              priority: 'medium',
              timeoutMs: 3000,
              fold: (_accumulated, incoming) => incoming,
            })
            return
          }
        }
      }

      if (submitted === '' && !hasImages) return

      {
        const dangling = danglingReferences(submitted, pendingInput.pastedContents())
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
      }

      const open = suggestionsMirrorRef.current.suggestions
      const isSlashSubmission =
        options.isSlashPick === true || submitted.trimStart().startsWith('/')
      if (
        open.length > 0 &&
        !isSlashSubmission &&
        !open.every(item => item.description === 'directory')
      ) {
        return
      }

      suggestionApi.logOutcomeAtSubmission(
        submitted,
        speculationAccept !== undefined ? { skipReset: true } : undefined,
      )
      removeNotification('stash-hint')

      if (pendingInput.mode() === 'bash') {
        await onSubmit(submitted, helpers, speculationAccept, {
          fromKeybinding: options.fromKeybinding === true,
        })
        return
      }

      const targetId = composerTargetTaskId(fresh)
      if (targetId !== undefined) {
        const intent = classifyAgentViewSubmission(
          submitted,
          options.fromKeybinding === true,
          commands,
        )
        const targetName = composerCrewmateRef.current?.taskId === targetId ? composerCrewmateRef.current.name : targetId
        const sendReceipt = (text: string, color?: 'warning'): void =>
          addNotification({ key: 'crewmate-send', text, priority: 'medium', timeoutMs: 6000, ...(color !== undefined ? { color } : {}), fold: (_accumulated, incoming) => incoming })
        const deliver = async (text: string): Promise<boolean> => {
          if (onAgentSubmit) {
            onAgentSubmit(text)
            return true
          }
          const task = fresh.tasks[targetId]
          if (task !== undefined && isLocalAgentTask(task)) {
            if (task.status !== 'running') {
              sendReceipt(crewmateRefusedWords(targetName, CREWMATE_BETWEEN_TURNS_DETAIL), 'warning')
              return false
            }
            queueOperatorMessage(task.id, text, setAppState)
            appendMessageToLocalAgent(
              task.id,
              { ...createUserMessage({ content: text }), queued: true },
              setAppState,
            )
            sendReceipt(`${operatorLinePlate(targetName)} ${crewmateQueuedWords(targetName)}`)
            return true
          }
          queueCrewmateLine(targetId, text)
          const receipt = await getFocusedSessionConnector().resumeAgent(targetId, text)
          if (receipt.outcome !== 'applied') {
            const why = receipt.detail ?? 'no reason given'
            refuseCrewmateLine(targetId, text, targetName, why)
            sendReceipt(crewmateRefusedWords(targetName, why), 'warning')
            return false
          }
          const queued = typeof receipt.detail === 'string' && receipt.detail.includes('"queued":true')
          sendReceipt(`${operatorLinePlate(targetName)} ${queued ? crewmateQueuedWords(targetName) : crewmateResumedWords(targetName)}`)
          return true
        }
        switch (intent.kind) {
          case 'session-command':
            await onSubmit(submitted, helpers, undefined, {
              fromKeybinding: options.fromKeybinding === true,
            })
            return
          case 'unknown-command':
            addNotification({
              key: 'agent-view-unknown-command',
              text: `Unknown command: /${intent.bareName} — commands run in this session; ${DOUBLED_SLASH} sends the line to the agent as text`,
              priority: 'medium',
              timeoutMs: 6000,
            })
            return
          case 'agent-literal':
          case 'agent-command':
          case 'agent-guidance': {
            takeLine()
            if (!(await deliver(intent.kind === 'agent-literal' ? intent.text : submitted))) handBack()
            return
          }
        }
      }

      await onSubmit(submitted, helpers, speculationAccept, {
        fromKeybinding: options.fromKeybinding === true,
      })
    },
    [compactWork, appStateStore, suggestionApi, crewContext, commands, helpers, buffer, history, onSubmit, onAgentSubmit, setAppState, setCursorOffset, addNotification, removeNotification, writeDraft],
  )

  return submit
}
