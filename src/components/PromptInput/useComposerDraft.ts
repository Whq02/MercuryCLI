import type React from 'react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as pendingInput from '../../input-core/pending-input.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { Notification } from '../../context/notifications.js'
import type { AppState } from '../../state/AppState.js'
import type { PastedContent } from '../../utils/config.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import { useInputBuffer } from '../../hooks/useInputBuffer.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { getGlobalConfig } from '../../utils/config.js'
import { parseReferences } from '../../history.js'
import { setPromptEmpty } from '../../utils/cockpit/helmFocus.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import { getModeFromInput, getValueFromInput } from './inputModes.js'
import { expandTabs, stripControls } from './composerText.js'

const UNDO_BUFFER_SIZE = 50
const UNDO_COALESCE_MS = 1000

export type ComposerDraftInput = {
  helpOpen: boolean
  setHelpOpen: (open: boolean) => void
  speculationActive: boolean
  footerSelection: AppState['footerSelection']
  setAppState: (f: (prev: AppState) => AppState) => void
  addNotification: (notification: Notification) => void
  removeNotification: (key: string) => void
}

export type ComposerDraft = {
  editGen: number
  input: string
  mode: PromptInputMode
  pastedContents: Record<number, PastedContent>
  stash: ReturnType<typeof pendingInput.stashedPrompt>
  cursorOffset: number
  setCursorOffset: (offset: number) => void
  lastSelfWriteRef: React.MutableRefObject<string>
  writeDraft: (text: string) => void
  buffer: ReturnType<typeof useInputBuffer>
  setMode: (next: PromptInputMode) => void
  setPastedContents: (
    next:
      | Record<number, PastedContent>
      | ((prev: Record<number, PastedContent>) => Record<number, PastedContent>),
  ) => void
  deferredSpaceArmedRef: React.MutableRefObject<boolean>
  deferredSpaceShiftRef: React.MutableRefObject<number>
  onChange: (raw: string) => void
}

export function useComposerDraft({
  helpOpen,
  setHelpOpen,
  speculationActive,
  footerSelection,
  setAppState,
  addNotification,
  removeNotification,
}: ComposerDraftInput): ComposerDraft {
  const editGen = useSyncExternalStore(
    pendingInput.subscribePendingInput,
    pendingInput.editGeneration,
    pendingInput.editGeneration,
  )
  const input = pendingInput.text()
  const mode = pendingInput.mode()
  const pastedContents = pendingInput.pastedContents()
  const stash = pendingInput.stashedPrompt()

  const [cursorOffset, setCursorOffsetState] = useState(() => {
    const draft = pendingInput.readDraftFor(getFocusedSessionConnector().sessionId())
    if (
      input !== '' &&
      draft !== null &&
      draft.text === input &&
      typeof draft.cursorOffset === 'number'
    ) {
      return Math.max(0, Math.min(draft.cursorOffset, input.length))
    }
    return input.length
  })
  const setCursorOffset = useCallback((offset: number): void => {
    setCursorOffsetState(offset)
    pendingInput.reportCursor(offset)
  }, [])

  const lastSelfWriteRef = useRef(input)
  const writeDraft = useCallback((text: string): void => {
    pendingInput.edit(text)
    lastSelfWriteRef.current = text
  }, [])
  if (lastSelfWriteRef.current !== input) {
    lastSelfWriteRef.current = input
    setCursorOffsetState(input.length)
    pendingInput.reportCursor(input.length)
  }

  const buffer = useInputBuffer({
    maxBufferSize: UNDO_BUFFER_SIZE,
    debounceMs: UNDO_COALESCE_MS,
  })

  const bufferSessionRef = useRef(getFocusedSessionConnector().sessionId())
  if (bufferSessionRef.current !== getFocusedSessionConnector().sessionId()) {
    bufferSessionRef.current = getFocusedSessionConnector().sessionId()
    buffer.clearBuffer();
  }

  const cursorSessionRef = useRef(getFocusedSessionConnector().sessionId())
  const cursorAtRepointRef = useRef<number | null>(null)
  useEffect(() => {
    const focusedId = getFocusedSessionConnector().sessionId()
    if (cursorSessionRef.current === focusedId) return
    if (cursorAtRepointRef.current === null) cursorAtRepointRef.current = cursorOffset
    const draft = pendingInput.readDraftFor(focusedId)
    if (draft !== null && draft.text === input && input !== '') {
      cursorSessionRef.current = focusedId
      const untouched = cursorAtRepointRef.current === cursorOffset
      cursorAtRepointRef.current = null
      if (untouched && typeof draft.cursorOffset === 'number') {
        setCursorOffset(Math.max(0, Math.min(draft.cursorOffset, input.length)))
      }
    } else if (input === '' && (draft === null || (draft.text ?? '') === '')) {
      cursorSessionRef.current = focusedId
      cursorAtRepointRef.current = null
    }
  })

  const setMode = useCallback((next: PromptInputMode): void => {
    pendingInput.setMode(next)
  }, [])
  const setPastedContents = useCallback(
    (
      next:
        | Record<number, PastedContent>
        | ((prev: Record<number, PastedContent>) => Record<number, PastedContent>),
    ): void => {
      const resolved =
        typeof next === 'function' ? next(pendingInput.pastedContents()) : next
      pendingInput.setPastedContents(resolved)
    },
    [],
  )

  const deferredSpaceArmedRef = useRef(false)
  const deferredSpaceShiftRef = useRef(0)

  const stashPeakRef = useRef(0)

  useEffect(() => {
    setPromptEmpty(input.trim() === '')
  }, [input])

  const onChange = useCallback(
    (raw: string): void => {
      if (raw === '?' && input === '') {
        setHelpOpen(!helpOpen)
        return
      }
      if (helpOpen) setHelpOpen(false)

      let value = expandTabs(stripControls(raw))

      if (deferredSpaceArmedRef.current) {
        deferredSpaceArmedRef.current = false
        if (
          cursorOffset === input.length &&
          value.length === input.length + 1 &&
          value.startsWith(input) &&
          value.slice(input.length) !== ' ' &&
          value.slice(input.length).trim() !== ''
        ) {
          value = `${input} ${value.slice(input.length)}`
          deferredSpaceShiftRef.current = 1
        }
      }

      if (mode === 'prompt') {
        if (
          value.length === input.length + 1 &&
          value.startsWith('!') &&
          value.slice(1) === input
        ) {
          writeDraft(input)
          setMode('bash')
          return
        }
        if (
          input === '' &&
          value.length > 1 &&
          !value.includes('\n') &&
          getModeFromInput(value) === 'bash'
        ) {
          buffer.pushAtomic(input, cursorOffset, pastedContents)
          setMode('bash')
          const remainder = expandTabs(getValueFromInput(value))
          writeDraft(remainder)
          setCursorOffset(remainder.length)
          return
        }
      }

      removeNotification('stash-hint')
      if (speculationActive) abortSpeculation(setAppState)
      if (footerSelection !== null) {
        setAppState(prev => ({ ...prev, footerSelection: null }))
      }

      buffer.pushToBuffer(input, cursorOffset, pastedContents)
      writeDraft(value)

      const previousLength = input.length
      stashPeakRef.current = Math.max(stashPeakRef.current, value.length)
      if (
        stashPeakRef.current >= 20 &&
        value.length <= 5 &&
        previousLength < 20 &&
        getGlobalConfig().hasUsedStash !== true
      ) {
        stashPeakRef.current = 0
        addNotification({
          key: 'stash-hint',
          text: `${getShortcutDisplay('chat:stash', 'Chat', 'ctrl+s')} stashes the draft for later`,
          priority: 'low',
          timeoutMs: 5000,
        })
      }
      if (value === '') stashPeakRef.current = 0

      const live = pendingInput.text()
      const present = new Set(parseReferences(live).map(ref => ref.id))
      {
        const prev = pendingInput.pastedContents()
        let changed = false
        const next: Record<number, PastedContent> = {}
        for (const [id, entry] of Object.entries(prev)) {
          if (present.has(Number(id))) next[Number(id)] = entry
          else changed = true
        }
        if (changed) pendingInput.setPastedContents(next)
      }
    },
    [input, mode, helpOpen, cursorOffset, pastedContents, buffer, speculationActive, footerSelection, setHelpOpen, setMode, setCursorOffset, removeNotification, addNotification, setAppState],
  )

  return {
    editGen,
    input,
    mode,
    pastedContents,
    stash,
    cursorOffset,
    setCursorOffset,
    lastSelfWriteRef,
    writeDraft,
    buffer,
    setMode,
    setPastedContents,
    deferredSpaceArmedRef,
    deferredSpaceShiftRef,
    onChange,
  }
}
