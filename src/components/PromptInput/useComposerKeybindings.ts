import type React from 'react'
import { useCallback } from 'react'
import * as pendingInput from '../../input-core/pending-input.js'
import type { Notification } from '../../context/notifications.js'
import type { PastedContent } from '../../utils/config.js'
import type { useInputBuffer } from '../../hooks/useInputBuffer.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import type { AppState } from '../../state/AppState.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import { expandPastedTextRefs } from '../../history.js'
import { getImageFromClipboard } from '../../utils/imagePaste.js'
import { editPromptInEditor } from '../../utils/promptEditor.js'
import { cyclePermissionMode } from '../../utils/permissions/getNextPermissionMode.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import type { OverlaySurface } from './composerOverlay.js'
import type { ComposerAttachments } from './useComposerAttachments.js'

export type ComposerKeybindingsInput = {
  buffer: ReturnType<typeof useInputBuffer>
  input: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
  writeDraft: (text: string) => void
  lastSelfWriteRef: React.MutableRefObject<string>
  setCursorOffset: (offset: number) => void
  addNotification: (notification: Notification) => void
  setExternalEditorActive: React.Dispatch<React.SetStateAction<boolean>>
  setOverlay: React.Dispatch<React.SetStateAction<OverlaySurface>>
  setHelpOpen: (open: boolean) => void
  helpOpen: boolean
  modalOverlayUp: boolean
  isSearchingHistory: boolean
  isLoading: boolean
  speculationActive: boolean
  onMessageActionsEnter: (() => void) | undefined
  appStateStore: AppStateStore
  setAppState: (f: (prev: AppState) => AppState) => void
  toolPermissionContext: AppState['toolPermissionContext']
  setToolPermissionContext: (
    context: AppState['toolPermissionContext'],
    options?: { preserveMode?: boolean },
  ) => void
  footerSelection: AppState['footerSelection']
  insertAtCursor: ComposerAttachments['insertAtCursor']
  handleImagePaste: ComposerAttachments['handleImagePaste']
  handleImageError: ComposerAttachments['handleImageError']
  setShowCommandPalette: React.Dispatch<React.SetStateAction<boolean>>
  setShowFileOpen: React.Dispatch<React.SetStateAction<boolean>>
  setShowContentSearch: React.Dispatch<React.SetStateAction<boolean>>
}

export type ComposerKeybindings = {
  performUndo: () => void
  crewmateFooterIndex: number
}

export function useComposerKeybindings({
  buffer,
  input,
  cursorOffset,
  pastedContents,
  writeDraft,
  lastSelfWriteRef,
  setCursorOffset,
  addNotification,
  setExternalEditorActive,
  setOverlay,
  setHelpOpen,
  helpOpen,
  modalOverlayUp,
  isSearchingHistory,
  isLoading,
  speculationActive,
  onMessageActionsEnter,
  appStateStore,
  setAppState,
  toolPermissionContext,
  setToolPermissionContext,
  footerSelection,
  insertAtCursor,
  handleImagePaste,
  handleImageError,
  setShowCommandPalette,
  setShowFileOpen,
  setShowContentSearch,
}: ComposerKeybindingsInput): ComposerKeybindings {
  const performUndo = useCallback((): void => {
    const entry = buffer.undo({ text: pendingInput.text(), cursorOffset, pastedContents: pendingInput.pastedContents() })
    if (entry === undefined) return
    writeDraft(entry.text)
    setCursorOffset(entry.cursorOffset)
    pendingInput.setPastedContents(entry.pastedContents)
    addNotification({ key: 'edit-history', text: 'undid the last edit', priority: 'low', timeoutMs: 2000, fold: (_accumulated, incoming) => incoming })
  }, [buffer, input, cursorOffset, pastedContents, setCursorOffset, addNotification])
  const performRedo = useCallback((): void => {
    const entry = buffer.redo({ text: pendingInput.text(), cursorOffset, pastedContents: pendingInput.pastedContents() })
    if (entry === undefined) return
    writeDraft(entry.text)
    setCursorOffset(entry.cursorOffset)
    pendingInput.setPastedContents(entry.pastedContents)
    addNotification({ key: 'edit-history', text: 'redid the last edit', priority: 'low', timeoutMs: 2000, fold: (_accumulated, incoming) => incoming })
  }, [buffer, input, cursorOffset, pastedContents, setCursorOffset, addNotification])

  const openExternalEditor = useCallback(async (): Promise<void> => {
    if (input.trim() === '' && Object.keys(pastedContents).length === 0) {
      addNotification({
        key: 'external-editor-empty',
        text: `type a draft first — ${getShortcutDisplay('chat:externalEditor', 'Chat', 'ctrl+x ctrl+e')} edits the current draft`,
        priority: 'medium',
        timeoutMs: 5000,
      })
      return
    }
    setExternalEditorActive(true)
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
        const edited = pendingInput.text()
        lastSelfWriteRef.current = edited
        setCursorOffset(edited.length)
      }
    } catch (error) {
      addNotification({
        key: 'external-editor-error',
        text: `external editor failed: ${error instanceof Error ? error.message : String(error)}`,
        color: 'warning',
        priority: 'high',
      })
    } finally {
      setExternalEditorActive(false)
    }
  }, [input, pastedContents, cursorOffset, buffer, setCursorOffset, addNotification])

  const performStash = useCallback((): void => {
    if (input.trim() === '') {
      const stashed = pendingInput.popStash()
      if (stashed === undefined) return
      lastSelfWriteRef.current = stashed.text
      setCursorOffset(stashed.cursorOffset)
      return
    }
    pendingInput.stashDraft(cursorOffset)
    lastSelfWriteRef.current = ''
    setCursorOffset(0)
    saveGlobalConfig(config => ({ ...config, hasUsedStash: true }))
  }, [input, cursorOffset, setCursorOffset])

  const cyclePermission = useCallback((): void => {
    const { nextMode, context: nextContext } = cyclePermissionMode(toolPermissionContext)
    setToolPermissionContext({ ...nextContext, mode: nextMode })
    setHelpOpen(false)
  }, [appStateStore, toolPermissionContext, setToolPermissionContext, setAppState, setHelpOpen])

  useKeybindings(
    {
      'chat:undo': () => {
        performUndo()
      },
      'chat:redo': () => {
        performRedo()
      },
      'chat:newline': () => {
        insertAtCursor('\n')
      },
      'chat:externalEditor': () => {
        void openExternalEditor()
      },
      'chat:stash': () => {
        performStash()
      },
      'chat:modelPicker': () => {
        setOverlay(current => (current === 'model-picker' ? null : 'model-picker'))
        setHelpOpen(false)
      },
      'chat:thinkingToggle': () => {
        setOverlay(current => (current === 'thinking-toggle' ? null : 'thinking-toggle'))
        setHelpOpen(false)
      },
      'chat:cycleMode': () => {
        cyclePermission()
      },
      'chat:imagePaste': () => {
        void (async () => {
          let image: Awaited<ReturnType<typeof getImageFromClipboard>>
          try {
            image = await getImageFromClipboard()
          } catch (error) {
            handleImageError(error instanceof Error ? error.message : String(error))
            return
          }
          if (image === null) {
            addNotification({
              key: 'no-image-in-clipboard',
              text:
                process.env.SSH_TTY !== undefined
                  ? 'no image in the clipboard (over SSH, transfer the file instead)'
                  : 'no image in the clipboard (copy one, then press the paste chord)',
              priority: 'low',
              timeoutMs: 1000,
            })
            return
          }
          handleImagePaste(
            image.base64,
            image.mediaType,
            undefined,
            image.dimensions,
            undefined,
            image.byteLength,
          )
        })()
      },
    },
    { context: 'Chat', isActive: !modalOverlayUp },
  )
  useKeybinding('app:commandPalette', () => {
    setShowCommandPalette(true)
  }, { context: 'Global', isActive: !modalOverlayUp })
  useKeybinding('app:fileOpen', () => {
    setShowFileOpen(true)
  }, { context: 'Global', isActive: !modalOverlayUp })
  useKeybinding('app:contentSearch', () => {
    setShowContentSearch(true)
  }, { context: 'Global', isActive: !modalOverlayUp })
  useKeybinding(
    'chat:messageActions',
    () => {
      if (onMessageActionsEnter && !isSearchingHistory) onMessageActionsEnter()
    },
    { context: 'Chat', isActive: !modalOverlayUp && !isSearchingHistory },
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

  const crewmateFooterIndex = 0
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
        const fresh = appStateStore.getState() as AppState
        if (fresh.viewSelectionMode === 'selecting-agent') return
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

  return { performUndo, crewmateFooterIndex }
}
