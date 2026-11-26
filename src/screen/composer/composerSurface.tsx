import React, { useMemo } from 'react'
import type { Command } from '../../commands/catalogue/commands.js'
import type { Notification } from '../notifications/notifications.js'
import type { useHistorySearch } from './history-search/useHistorySearch.js'
import { Box, Text } from '../themedRenderer.js'
import type { AppState } from '../app-state/AppState.js'
import type { AppStateStore } from '../app-state/AppStateStore.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { Theme } from '../theme/theme.js'
import { MercuryCommandPalette } from './MercuryCommandPalette.js'
import { MercuryContentSearch } from './MercuryContentSearch.js'
import { MercuryFileOpen } from './MercuryFileOpen.js'
import { ThinkingToggle } from './ThinkingToggle.js'
import { BackgroundTasksDialog } from '../tasks/BackgroundTasksDialog.js'
import type { useComposerCrewmate } from '../tasks/useCrewmateView.js'
import type { OverlaySurface } from './composerOverlay.js'
import { useSetPromptOverlayDialog } from '../overlays/promptOverlay.js'
import { requestCommandDispatch } from '../cockpit/helmFocus.js'
import type { ComposerProps } from './Composer.js'
import type { ComposerAttachments } from './useComposerAttachments.js'
import type { useComposerModelDoors } from './useComposerModelDoors.js'

const EXTERNAL_EDITOR_TEXT = 'editing in your external editor — save and close to continue'

export function useRunsPopup({ fullscreen, overlay, setOverlay, getToolUseContext, messages, engineModel }: {
  fullscreen: boolean
  overlay: OverlaySurface
  setOverlay: React.Dispatch<React.SetStateAction<OverlaySurface>>
  getToolUseContext: ComposerProps['getToolUseContext']
  messages: Message[]
  engineModel: AppState['engineModel']
}): void {
  const open = fullscreen && overlay === 'tasks-dialog'
  const dialog = useMemo(
    () => open ? (
      <BackgroundTasksDialog
        onDone={() => setOverlay(null)}
        toolUseContext={getToolUseContext(messages, [], new AbortController(), engineModel ?? '')}
      />
    ) : null,
    [open, setOverlay, getToolUseContext, messages, engineModel],
  )
  useSetPromptOverlayDialog(dialog)
}

export function composerSurface({
  externalEditorActive,
  borderStyle,
  borderColor,
  fullscreen,
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
  fullscreen: boolean
  overlay: OverlaySurface
  setOverlay: React.Dispatch<React.SetStateAction<OverlaySurface>>
  getToolUseContext: ComposerProps['getToolUseContext']
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
        borderColor={borderColor}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        justifyContent="center"
      >
        <Text dimColor italic>
          {EXTERNAL_EDITOR_TEXT}
        </Text>
      </Box>
    )
  }

  if (overlay === 'tasks-dialog' && !fullscreen) {
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
            label: 'open a file',
            action: 'app:fileOpen',
            context: 'Global',
            kind: 'open',
            run: () => {
              setShowCommandPalette(false)
              setShowFileOpen(true)
            },
          },
          {
            label: 'search file contents',
            action: 'app:contentSearch',
            context: 'Global',
            kind: 'open',
            run: () => {
              setShowCommandPalette(false)
              setShowContentSearch(true)
            },
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
            action: 'chat:modelPicker',
            context: 'Chat',
            kind: 'open',
            run: () => {
              setShowCommandPalette(false)
              const crewmate = commandCrewmateRef.current
              if (crewmate !== null) {
                requestCommandDispatch('/model')
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

  if (doors.surface !== null) {
    return doors.surface
  }

  if (overlay === 'thinking-toggle') {
    const currentValue = appStateStore.getState().thinkingEnabled ?? true
    const isMidConversation = messages.some(message => message.type === 'assistant')
    return (
      <ThinkingToggle
        currentValue={currentValue}
        isMidConversation={isMidConversation}
        onSelect={enabled => {
          setAppState(prev => ({ ...prev, thinkingEnabled: enabled }))
          setOverlay(null)
          addNotification({
            key: 'thinking-toggled-hotkey',
            text: enabled ? 'Thinking on' : 'Thinking off',
            color: enabled ? 'suggestion' : 'subtle',
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
