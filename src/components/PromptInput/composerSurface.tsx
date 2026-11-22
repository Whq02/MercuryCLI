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
import { notBuilt } from '../../pi/holes.js'

export function composerSurface(arg0: {
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
  return notBuilt('src/components/PromptInput/composerSurface.tsx:22')
}
