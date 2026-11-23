import type React from 'react'
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { useLoad } from '../effects/effects.js'
import * as pendingInput from './input-core/pending-input.js'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import type { Notification } from '../notifications/notifications.js'
import type { AppState } from '../app-state/AppState.js'
import type { PastedContent } from '../../platform/settings/config.js'
import type { PromptInputMode } from './input-core/textInput.js'
import { useInputBuffer } from './useInputUndo.js'
import { bindLiveInputState, type LiveInputState } from './text-input/useTextInput.js'
import { getShortcutDisplay } from '../keys/shortcutFormat.js'
import { getGlobalConfig } from '../../platform/settings/config.js'
import { parseReferences } from '../../sessions/promptHistory.js'
import { abortSpeculation } from '../prompt-suggestion/speculation.js'
import { getModeFromInput, getValueFromInput } from './inputModes.js'
import { expandTabs, stripControls } from './composerText.js'

const UNDO_BUFFER_SIZE = 50
const UNDO_DEBOUNCE_MS = 1000
const SHORT_SHELL_PASTE_MAX = 800
const STASH_HINT_PEAK_THRESHOLD = 20
const STASH_HINT_SHRINK_MAX = 5

type ComposerDraftInput = {
  helpOpen: boolean
  setHelpOpen: (open: boolean) => void
  speculationActive: boolean
  footerSelection: AppState['footerSelection']
  setAppState: (f: (prev: AppState) => AppState) => void
  addNotification: (notification: Notification) => void
  removeNotification: (key: string) => void
}

type ComposerDraft = {
  editGen: number
  input: string
  mode: PromptInputMode
  pastedContents: Record<number, PastedContent>
  stash: pendingInput.StashedPrompt | undefined
  cursorOffset: number
  readLiveState: () => LiveInputState
  setCursorOffset: (offset: number) => void
  lastSelfWriteRef: React.MutableRefObject<string>
  writeDraft: (text: string) => void
  buffer: ReturnType<typeof useInputBuffer>
  setMode: (mode: PromptInputMode) => void
  setPastedContents: (
    next:
      | Record<number, PastedContent>
      | ((previous: Record<number, PastedContent>) => Record<number, PastedContent>),
  ) => void
  deferredSpaceArmedRef: React.MutableRefObject<boolean>
  deferredSpaceShiftRef: React.MutableRefObject<number>
  onChange: (value: string) => void
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
  const focusedSessionId = getFocusedSessionConnector().sessionId()

  const [cursorOffset, setCursorOffsetState] = useState<number>(() => {
    const initialText = pendingInput.text()
    if (initialText !== '') {
      const saved = pendingInput.readDraftFor(focusedSessionId)
      if (
        saved !== null &&
        saved.text === initialText &&
        typeof saved.cursorOffset === 'number'
      ) {
        return Math.max(0, Math.min(saved.cursorOffset, initialText.length))
      }
    }
    return initialText.length
  })

  const lastSelfWriteRef = useRef<string>(input)
  const liveTextRef = useRef<string>(input)
  const liveCursorRef = useRef<number>(cursorOffset)
  const lastSessionIdRef = useRef<string>(focusedSessionId)
  const pendingRestoreSessionRef = useRef<string | null>(null)
  const cursorMovedSinceRepointRef = useRef<boolean>(false)
  const deferredSpaceArmedRef = useRef<boolean>(false)
  const deferredSpaceShiftRef = useRef<number>(0)
  const peakLengthRef = useRef<number>(input.length)

  const buffer = useInputBuffer({
    maxBufferSize: UNDO_BUFFER_SIZE,
    debounceMs: UNDO_DEBOUNCE_MS,
  })
  const clearBuffer = buffer.clearBuffer

  const readLiveState = useCallback((): LiveInputState => {
    const actual = pendingInput.text()
    if (actual !== liveTextRef.current) {
      liveTextRef.current = actual
      liveCursorRef.current = actual.length
    }
    return { value: actual, offset: liveCursorRef.current }
  }, [])

  const setCursorOffset = useCallback((offset: number) => {
    const actual = pendingInput.text()
    const clamped = Math.max(0, Math.min(offset, actual.length))
    liveTextRef.current = actual
    liveCursorRef.current = clamped
    cursorMovedSinceRepointRef.current = true
    setCursorOffsetState(clamped)
    pendingInput.reportCursor(clamped)
  }, [])

  const writeDraft = useCallback((text: string) => {
    pendingInput.edit(text)
    const actual = pendingInput.text()
    lastSelfWriteRef.current = actual
    liveTextRef.current = actual
    if (liveCursorRef.current > actual.length) {
      liveCursorRef.current = actual.length
    }
  }, [])

  const setMode = useCallback((nextMode: PromptInputMode) => {
    pendingInput.setMode(nextMode)
  }, [])

  const setPastedContents = useCallback(
    (
      next:
        | Record<number, PastedContent>
        | ((previous: Record<number, PastedContent>) => Record<number, PastedContent>),
    ) => {
      const resolved =
        typeof next === 'function' ? next(pendingInput.pastedContents()) : next
      pendingInput.setPastedContents(resolved)
    },
    [],
  )

  useLoad(() => {
    if (focusedSessionId !== lastSessionIdRef.current) {
      lastSessionIdRef.current = focusedSessionId
      clearBuffer()
      pendingRestoreSessionRef.current = focusedSessionId
      cursorMovedSinceRepointRef.current = false
    }

    if (pendingRestoreSessionRef.current !== null) {
      if (cursorMovedSinceRepointRef.current) {
        pendingRestoreSessionRef.current = null
      } else {
        const saved = pendingInput.readDraftFor(pendingRestoreSessionRef.current)
        if (
          saved !== null &&
          saved.text !== '' &&
          saved.text === input &&
          typeof saved.cursorOffset === 'number'
        ) {
          const restored = Math.max(0, Math.min(saved.cursorOffset, input.length))
          lastSelfWriteRef.current = input
          liveTextRef.current = input
          liveCursorRef.current = restored
          setCursorOffsetState(restored)
          pendingInput.reportCursor(restored)
          pendingRestoreSessionRef.current = null
          return
        }
        if (input === '' && (saved === null || saved.text === '')) {
          pendingRestoreSessionRef.current = null
        }
      }
    }

    if (input !== lastSelfWriteRef.current) {
      lastSelfWriteRef.current = input
      liveTextRef.current = input
      liveCursorRef.current = input.length
      setCursorOffsetState(input.length)
      pendingInput.reportCursor(input.length)
    }
  }, [focusedSessionId, input, clearBuffer])

  const onChange = useCallback(
    (rawValue: string) => {
      const live = readLiveState()
      const prevText = live.value
      const prevCursor = live.offset
      const prevMode = pendingInput.mode()
      const prevPastes = pendingInput.pastedContents()

      if (rawValue === '?' && prevText === '') {
        setHelpOpen(!helpOpen)
        return
      }
      if (helpOpen) {
        setHelpOpen(false)
      }

      let next = expandTabs(stripControls(rawValue))

      if (deferredSpaceArmedRef.current) {
        deferredSpaceArmedRef.current = false
        if (
          prevCursor === prevText.length &&
          prevText.length > 0 &&
          next.startsWith(prevText)
        ) {
          const appended = next.slice(prevText.length)
          if ([...appended].length === 1 && !/\s/.test(appended)) {
            next = `${prevText} ${appended}`
            deferredSpaceShiftRef.current = 1
          }
        }
      }

      if (prevMode === 'prompt' && next === `!${prevText}`) {
        setMode('bash')
        return
      }

      if (
        prevMode === 'prompt' &&
        prevText === '' &&
        next.length > 1 &&
        next.length <= SHORT_SHELL_PASTE_MAX &&
        !next.includes('\n') &&
        getModeFromInput(next) === 'bash'
      ) {
        buffer.pushAtomic(prevText, prevCursor, prevPastes)
        setMode('bash')
        const remainder = getValueFromInput(next)
        writeDraft(remainder)
        setCursorOffset(pendingInput.text().length)
        return
      }

      removeNotification('stash-hint')
      if (speculationActive) {
        abortSpeculation(setAppState)
      }
      if (footerSelection !== null) {
        setAppState(prev =>
          prev.footerSelection === null ? prev : { ...prev, footerSelection: null },
        )
      }

      buffer.pushToBuffer(prevText, prevCursor, prevPastes)
      writeDraft(next)

      const actual = pendingInput.text()
      if (prevText.length > peakLengthRef.current) {
        peakLengthRef.current = prevText.length
      }
      if (actual.length > peakLengthRef.current) {
        peakLengthRef.current = actual.length
      }
      if (
        peakLengthRef.current >= STASH_HINT_PEAK_THRESHOLD &&
        actual.length <= STASH_HINT_SHRINK_MAX &&
        prevText.length < STASH_HINT_PEAK_THRESHOLD &&
        getGlobalConfig().hasUsedStash !== true
      ) {
        const chord = getShortcutDisplay('chat:stash', 'Chat', 'ctrl+s')
        addNotification({
          key: 'stash-hint',
          text: `${chord} stashes the draft for later`,
          priority: 'low',
          timeoutMs: 5000,
        })
        peakLengthRef.current = 0
      }
      if (actual.length === 0) {
        peakLengthRef.current = 0
      }

      const currentPastes = pendingInput.pastedContents()
      const pasteKeys = Object.keys(currentPastes)
      if (pasteKeys.length > 0) {
        const referencedIds = new Set(parseReferences(actual).map(ref => ref.id))
        let changed = false
        const pruned: Record<number, PastedContent> = {}
        for (const key of pasteKeys) {
          const id = Number(key)
          const entry = currentPastes[id]
          if (entry !== undefined && referencedIds.has(id)) {
            pruned[id] = entry
          } else {
            changed = true
          }
        }
        if (changed) {
          pendingInput.setPastedContents(pruned)
        }
      }
    },
    [
      readLiveState,
      helpOpen,
      setHelpOpen,
      setMode,
      buffer,
      writeDraft,
      setCursorOffset,
      removeNotification,
      speculationActive,
      setAppState,
      footerSelection,
      addNotification,
    ],
  )

  bindLiveInputState(onChange, readLiveState)

  return {
    editGen,
    input,
    mode,
    pastedContents,
    stash,
    cursorOffset,
    readLiveState,
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
