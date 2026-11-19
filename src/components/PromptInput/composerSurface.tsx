import React from 'react'
import type { Command } from '../../commands.js'
import type { Notification } from '../../context/notifications.js'
import type { useHistorySearch } from '../../hooks/useHistorySearch.js'
import { Box, Text } from '../../ink.js'
import type { AppState } from '../../state/AppState.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import type { Message } from '../../types/message.js'
import type { Theme } from '../../utils/theme.js'
import { MercuryCommandPalette } from '../MercuryCommandPalette.js'
import { MercuryContentSearch } from '../MercuryContentSearch.js'
import { MercuryFileOpen } from '../MercuryFileOpen.js'
import { ThinkingToggle } from '../ThinkingToggle.js'
import { BackgroundTasksDialog } from '../tasks/BackgroundTasksDialog.js'
import type { useComposerCrewmate } from '../tasks/useCrewmateView.js'
import type { OverlaySurface } from './composerOverlay.js'
import { crewmateCommandReceipt, openCrewmateModelPickerFor } from './crewmateCommands.js'
import type { PromptInputProps } from './PromptInput.js'
import type { ComposerAttachments } from './useComposerAttachments.js'
import type { useComposerModelDoors } from './useComposerModelDoors.js'

export function composerSurface({
  externalEditorActive,
  borderStyle,
  borderColor,
  overlay,
  setOverlay,
  getToolUseContext,
  messages,
  engineModel,
  showCommandPalette,
  setShowCommandPalette,
  showFileOpen,
  setShowFileOpen,
  showContentSearch,
  setShowContentSearch,
  commands,
  historySearch,
  commandCrewmateRef,
  setAppState,
  addNotification,
  insertAtomic,
  doors,
  appStateStore,
}: {
  externalEditorActive: boolean
  borderStyle: 'round' | undefined
  borderColor: keyof Theme
  overlay: OverlaySurface
  setOverlay: React.Dispatch<React.SetStateAction<OverlaySurface>>
  getToolUseContext: PromptInputProps['getToolUseContext']
  messages: Message[]
  engineModel: AppState['engineModel']
  showCommandPalette: boolean
  setShowCommandPalette: React.Dispatch<React.SetStateAction<boolean>>
  showFileOpen: boolean
  setShowFileOpen: React.Dispatch<React.SetStateAction<boolean>>
  showContentSearch: boolean
  setShowContentSearch: React.Dispatch<React.SetStateAction<boolean>>
  commands: Command[]
  historySearch: ReturnType<typeof useHistorySearch>
  commandCrewmateRef: React.MutableRefObject<ReturnType<typeof useComposerCrewmate>>
  setAppState: (f: (prev: AppState) => AppState) => void
  addNotification: (notification: Notification) => void
  insertAtomic: ComposerAttachments['insertAtomic']
  doors: ReturnType<typeof useComposerModelDoors>
  appStateStore: AppStateStore
}): React.ReactNode {
  if (externalEditorActive) {
    return (
      <Box
        borderStyle={borderStyle}
        borderColor={borderColor as string}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        justifyContent="center"
      >
        <Text dimColor italic>
          editing in your external editor — save and close to continue
        </Text>
      </Box>
    )
  }
  if (overlay === 'tasks-dialog') {
    return (
      <BackgroundTasksDialog
        onDone={() => setOverlay(null)}
        toolUseContext={getToolUseContext(messages, [], new AbortController(), engineModel ?? '')}
      />
    )
  }
  if (showCommandPalette) {
    return (
      <MercuryCommandPalette
        commands={commands}
        actions={[
          {
            kind: 'open', action: 'app:fileOpen', context: 'Global',
            label: 'open a file',
            run: () => { setShowCommandPalette(false); setShowFileOpen(true) },
          },
          {
            label: 'search file contents',
            run: () => { setShowCommandPalette(false); setShowContentSearch(true) },
            kind: 'open', action: 'app:contentSearch', context: 'Global',
          },
          {
            label: 'reverse history search',
            kind: 'open',
            run: () => {
              setShowCommandPalette(false)
              historySearch.handleStartSearch()
            },
          },
          {
            label: 'open the model picker',
            kind: 'open',
            action: 'chat:modelPicker',
            context: 'Chat',
            run: () => {
              setShowCommandPalette(false)
              const crewmate = commandCrewmateRef.current
              if (crewmate !== null) {
                void openCrewmateModelPickerFor(crewmate, { setAppState, receipt: crewmateCommandReceipt(addNotification) })
                return
              }
              setOverlay('model-picker')
            },
          },
        ]}
        onRun={text => {
          setShowCommandPalette(false)
          insertAtomic(text)
        }}
        onClose={() => setShowCommandPalette(false)}
      />
    )
  }
  if (showFileOpen) {
    return (
      <MercuryFileOpen
        onPick={text => {
          setShowFileOpen(false)
          insertAtomic(text)
        }}
        onClose={() => setShowFileOpen(false)}
      />
    )
  }
  if (showContentSearch) {
    return (
      <MercuryContentSearch
        onPick={text => {
          setShowContentSearch(false)
          insertAtomic(text)
        }}
        onClose={() => setShowContentSearch(false)}
      />
    )
  }
  if (doors.surface !== null) return doors.surface
  if (overlay === 'thinking-toggle') {
    return (
      <ThinkingToggle
        currentValue={(appStateStore.getState().thinkingEnabled ?? true) === true}
        isMidConversation={messages.some(message => message.type === 'assistant')}
        onSelect={next => {
          setAppState(prev => ({ ...prev, thinkingEnabled: next }))
          setOverlay(null)
          addNotification({
            key: 'thinking-toggled-hotkey',
            text: `Thinking ${next ? 'on' : 'off'}`,
            color: next ? 'suggestion' : 'subtle',
            priority: 'high',
            timeoutMs: 3000,
          })
        }}
        onCancel={() => setOverlay(null)}
      />
    )
  }
  return null
}
