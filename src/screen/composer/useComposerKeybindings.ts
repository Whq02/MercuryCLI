import type React from 'react'
import { useCallback } from 'react'
import * as pendingInput from './input-core/pending-input.js'
import { pressSendNow } from './input-core/sendNowChord.js'
import { focusedSendNowLive, sendFocusedWordsNow } from '../../engine/connector/sendNowLive.js'
import { splitWayOut, type Notification } from '../notifications/notifications.js'
import type { PastedContent } from '../../platform/settings/config.js'
import type { useInputBuffer } from './useInputUndo.js'
import { useKeybinding, useKeybindings } from '../keys/useKeybinding.js'
import { getShortcutDisplay } from '../keys/shortcutFormat.js'
import type { AppState } from '../app-state/AppState.js'
import type { AppStateStore } from '../app-state/AppStateStore.js'
import { expandPastedTextRefs } from '../../sessions/promptHistory.js'
import { getImageFromClipboard } from './imagePaste.js'
import { editPromptInEditor } from './promptEditor.js'
import { cyclePermissionMode } from '../../permissions/rules/getNextPermissionMode.js'
import { saveGlobalConfig } from '../../platform/settings/config.js'
import { abortSpeculation } from '../prompt-suggestion/speculation.js'
import type { OverlaySurface } from './composerOverlay.js'
import type { ComposerAttachments } from './useComposerAttachments.js'
import type { useComposerCrewmate } from '../tasks/useCrewmateView.js'
import { crewmateThinkingKeyWords } from '../cockpit/crewmateWords.js'
import { crewmateCommandReceipt, openCrewmateModelPickerFor } from './crewmateCommands.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

type ComposerKeybindingsInput = {
  input: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
  buffer: ReturnType<typeof useInputBuffer>
  writeDraft: (text: string) => void
  setCursorOffset: (offset: number) => void
  lastSelfWriteRef: React.MutableRefObject<string>
  setOverlay: React.Dispatch<React.SetStateAction<OverlaySurface>>
  helpOpen: boolean
  setHelpOpen: (open: boolean) => void
  setExternalEditorActive: (active: boolean) => void
  setShowCommandPalette: React.Dispatch<React.SetStateAction<boolean>>
  setShowFileOpen: React.Dispatch<React.SetStateAction<boolean>>
  setShowContentSearch: React.Dispatch<React.SetStateAction<boolean>>
  onMessageActionsEnter?: () => void
  isLoading: boolean
  isSearchingHistory: boolean
  speculationActive: boolean
  modalOverlayUp: boolean
  footerSelection: AppState['footerSelection']
  appStateStore: AppStateStore
  setAppState: (f: (prev: AppState) => AppState) => void
  toolPermissionContext: AppState['toolPermissionContext']
  setToolPermissionContext: (
    context: AppState['toolPermissionContext'],
    options?: { preserveMode?: boolean },
  ) => void
  addNotification: (notification: Notification) => void
  insertAtCursor: ComposerAttachments['insertAtCursor']
  handleImagePaste: ComposerAttachments['handleImagePaste']
  handleImageError: ComposerAttachments['handleImageError']
  commandCrewmateRef: React.MutableRefObject<ReturnType<typeof useComposerCrewmate>>
}

type ComposerKeybindings = {
  performUndo: () => void
  crewmateFooterIndex: number
}

function pasteImageFromClipboard(
  handleImagePaste: ComposerAttachments['handleImagePaste'],
  handleImageError: ComposerAttachments['handleImageError'],
  addNotification: (notification: Notification) => void,
): void {
  void getImageFromClipboard().then(
    image => {
      if (image !== null) {
        handleImagePaste(
          image.base64,
          image.mediaType,
          undefined,
          image.dimensions,
          undefined,
          image.byteLength,
        )
      } else {
        const text = hostEnv().SSH_TTY
          ? 'no image in the clipboard (over SSH, transfer the file instead)'
          : 'no image in the clipboard (copy one, then press the paste chord)'
        addNotification({
          key: 'no-image-in-clipboard',
          text,
          priority: 'low',
          timeoutMs: 1000,
        })
      }
    },
    error => {
      handleImageError(error instanceof Error ? error.message : String(error))
    },
  )
}

export function useComposerKeybindings({
  input,
  cursorOffset,
  pastedContents,
  buffer,
  writeDraft,
  setCursorOffset,
  lastSelfWriteRef,
  setOverlay,
  helpOpen,
  setHelpOpen,
  setExternalEditorActive,
  setShowCommandPalette,
  setShowFileOpen,
  setShowContentSearch,
  onMessageActionsEnter,
  isLoading,
  isSearchingHistory,
  speculationActive,
  modalOverlayUp,
  footerSelection,
  appStateStore,
  setAppState,
  toolPermissionContext,
  setToolPermissionContext,
  addNotification,
  insertAtCursor,
  handleImagePaste,
  handleImageError,
  commandCrewmateRef,
}: ComposerKeybindingsInput): ComposerKeybindings {
  const performUndo = useCallback(() => {
    const restored = buffer.undo({
      text: pendingInput.text(),
      cursorOffset,
      pastedContents: pendingInput.pastedContents(),
    })
    if (restored === undefined) return
    writeDraft(restored.text)
    setCursorOffset(restored.cursorOffset)
    pendingInput.setPastedContents(restored.pastedContents)
    addNotification({
      key: 'edit-history',
      text: 'undid the last edit',
      priority: 'low',
      timeoutMs: 2000,
      fold: (_current, incoming) => incoming,
    })
  }, [buffer, cursorOffset, writeDraft, setCursorOffset, addNotification])

  const performRedo = useCallback(() => {
    const restored = buffer.redo({
      text: pendingInput.text(),
      cursorOffset,
      pastedContents: pendingInput.pastedContents(),
    })
    if (restored === undefined) return
    writeDraft(restored.text)
    setCursorOffset(restored.cursorOffset)
    pendingInput.setPastedContents(restored.pastedContents)
    addNotification({
      key: 'edit-history',
      text: 'redid the last edit',
      priority: 'low',
      timeoutMs: 2000,
      fold: (_current, incoming) => incoming,
    })
  }, [buffer, cursorOffset, writeDraft, setCursorOffset, addNotification])

  const handleExternalEditor = useCallback(() => {
    if (input.trim() === '' && Object.keys(pastedContents).length === 0) {
      const chord = getShortcutDisplay('chat:externalEditor', 'Chat', 'ctrl+x ctrl+e')
      addNotification({
        key: 'external-editor-empty',
        text: `type a draft first — ${chord} edits the current draft`,
        priority: 'medium',
        timeoutMs: 5000,
      })
      return
    }
    setExternalEditorActive(true)
    void (async () => {
      try {
        const expanded = expandPastedTextRefs(input, pastedContents)
        const result = await editPromptInEditor(expanded)
        if (result.error) {
          addNotification({
            key: 'external-editor-error',
            text: `external editor failed: ${result.error}`,
            color: 'warning',
            priority: 'high',
          })
        } else if (typeof result.content === 'string' && result.content !== expanded) {
          buffer.pushAtomic(input, cursorOffset, pastedContents)
          pendingInput.edit(result.content)
          const actual = pendingInput.text()
          lastSelfWriteRef.current = actual
          setCursorOffset(actual.length)
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        addNotification({
          key: 'external-editor-error',
          text: `external editor failed: ${detail}`,
          color: 'warning',
          priority: 'high',
        })
      } finally {
        setExternalEditorActive(false)
      }
    })()
  }, [
    input,
    pastedContents,
    cursorOffset,
    buffer,
    lastSelfWriteRef,
    setCursorOffset,
    setExternalEditorActive,
    addNotification,
  ])

  const handleStash = useCallback(() => {
    if (pressSendNow(focusedSendNowLive())) {
      void sendFocusedWordsNow().then(
        receipt => {
          if (receipt.outcome === 'refused') {
            const detail = receipt.detail ?? 'no reason given'
            addNotification({
              key: 'send-now',
              ...splitWayOut(detail),
              priority: 'immediate',
            })
          }
        },
        error => {
          const detail = error instanceof Error ? error.message : String(error)
          addNotification({
            key: 'send-now',
            ...splitWayOut(detail || 'no reason given'),
            priority: 'immediate',
          })
        },
      )
      return
    }
    if (pendingInput.text().trim() !== '') {
      pendingInput.stashDraft(cursorOffset)
      lastSelfWriteRef.current = ''
      setCursorOffset(0)
      saveGlobalConfig(current =>
        current.hasUsedStash ? current : { ...current, hasUsedStash: true },
      )
      return
    }
    const restored = pendingInput.popStash()
    if (restored !== undefined) {
      lastSelfWriteRef.current = pendingInput.text()
      setCursorOffset(restored.cursorOffset)
    }
  }, [cursorOffset, lastSelfWriteRef, setCursorOffset, addNotification])

  useKeybindings(
    {
      'chat:undo': performUndo,
      'chat:redo': performRedo,
      'chat:newline': () => {
        insertAtCursor('\n')
      },
      'chat:externalEditor': handleExternalEditor,
      'chat:stash': handleStash,
      'chat:modelPicker': () => {
        setHelpOpen(false)
        const crewmate = commandCrewmateRef.current
        if (crewmate !== null) {
          void openCrewmateModelPickerFor(crewmate, {
            setAppState,
            receipt: crewmateCommandReceipt(addNotification),
          })
          return
        }
        setOverlay(prev => (prev === 'model-picker' ? null : 'model-picker'))
      },
      'chat:thinkingToggle': () => {
        setHelpOpen(false)
        const crewmate = commandCrewmateRef.current
        if (crewmate !== null) {
          const key = getShortcutDisplay('chat:thinkingToggle', 'Chat', 'meta+t')
          addNotification({
            key: 'crewmate-thinking-key',
            text: crewmateThinkingKeyWords(crewmate.name, key),
            priority: 'medium',
            timeoutMs: 8000,
          })
          return
        }
        setOverlay(prev => (prev === 'thinking-toggle' ? null : 'thinking-toggle'))
      },
      'chat:cycleMode': () => {
        const { nextMode, context } = cyclePermissionMode(toolPermissionContext)
        setToolPermissionContext({ ...context, mode: nextMode })
        setHelpOpen(false)
      },
      'chat:imagePaste': () => {
        pasteImageFromClipboard(handleImagePaste, handleImageError, addNotification)
      },
    },
    { context: 'Chat', isActive: !modalOverlayUp },
  )

  useKeybindings(
    {
      'app:commandPalette': () => {
        setShowCommandPalette(true)
      },
      'app:fileOpen': () => {
        setShowFileOpen(true)
      },
      'app:contentSearch': () => {
        setShowContentSearch(true)
      },
    },
    { context: 'Global', isActive: !modalOverlayUp },
  )

  useKeybinding(
    'chat:messageActions',
    () => {
      onMessageActionsEnter?.()
    },
    {
      context: 'Chat',
      isActive: !modalOverlayUp && !isSearchingHistory && onMessageActionsEnter !== undefined,
    },
  )

  useKeybinding(
    'help:dismiss',
    () => {
      setHelpOpen(false)
    },
    { context: 'Help', isActive: helpOpen },
  )

  useKeybinding(
    'app:interrupt',
    () => {
      abortSpeculation(setAppState)
    },
    { context: 'Global', isActive: !isLoading && speculationActive },
  )

  useKeybindings(
    {
      'footer:up': () => {
        setAppState(prev => ({ ...prev, footerSelection: null }))
      },
      'footer:down': () => {
        if (footerSelection === 'tasks') {
          setOverlay('tasks-dialog')
          setAppState(prev => ({ ...prev, footerSelection: null }))
        }
      },
      'footer:next': () => {},
      'footer:previous': () => {},
      'footer:openSelected': () => {
        if (appStateStore.getState().viewSelectionMode === 'selecting-agent') return
        if (footerSelection === 'tasks') {
          setOverlay('tasks-dialog')
          setAppState(prev => ({ ...prev, footerSelection: null }))
        }
      },
      'footer:clearSelection': () => {
        setAppState(prev => ({ ...prev, footerSelection: null }))
      },
      'footer:close': () => false,
    },
    { context: 'Footer', isActive: footerSelection !== null && !modalOverlayUp },
  )

  return { performUndo, crewmateFooterIndex: 0 }
}
