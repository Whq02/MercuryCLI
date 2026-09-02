// A reusable single-line editor with readline/emacs bindings and a kill
// ring. The exit grammar, the passthrough list, and the rule that
// every control- or meta-modified key is CONSUMED whether or not it maps to
// an action are the contract; kill/yank state resets happen AFTER the
// passthrough check and BEFORE dispatch, so a passthrough key disturbs
// neither.

import { wordStartAfter, wordStartBefore } from '../utils/intl.js'
import { useCallback, useRef, useState } from 'react'
import { useInput } from '../ink.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { useTerminalSize } from './useTerminalSize.js'

export type UseSearchInputOptions = {
  isActive: boolean
  onExit: () => void
  onCancel?: () => void
  onExitUp?: () => void
  columns?: number
  passthroughCtrlKeys?: string[]
  initialQuery?: string
  backspaceExitsOnEmpty?: boolean
}

export type UseSearchInputReturn = {
  query: string
  setQuery: (q: string) => void
  cursorOffset: number
  handleKeyDown: (e: KeyboardEvent) => void
}

/** Key names that must never leak in as literal text. */
const REJECTED_KEY_NAMES = new Set([
  'pageup',
  'pagedown',
  'insert',
  'wheelup',
  'wheeldown',
  'mouse',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
])

// Word steps and kills share the composer's locale grammar (utils/intl.ts)
// — one word-deletion behaviour across prompt, search and dialog fields.
const prevWordStart = (text: string, at: number): number => wordStartBefore(text, at)
const nextWordEnd = (text: string, at: number): number => wordStartAfter(text, at)

export function useSearchInput({
  isActive,
  onExit,
  onCancel,
  onExitUp,
  columns,
  passthroughCtrlKeys,
  initialQuery,
  backspaceExitsOnEmpty = true,
}: UseSearchInputOptions): UseSearchInputReturn {
  const { columns: terminalColumns } = useTerminalSize()
  void (columns ?? terminalColumns)
  const [query, setQueryState] = useState(initialQuery ?? '')
  const [cursorOffset, setCursorOffset] = useState((initialQuery ?? '').length)
  const queryRef = useRef(query)
  queryRef.current = query
  const cursorRef = useRef(cursorOffset)
  cursorRef.current = cursorOffset

  // Kill ring with accumulation; yank span for yank-pop.
  const killRingRef = useRef<string[]>([])
  const killAccumulatingRef = useRef(false)
  const yankRef = useRef<{ at: number; length: number; ringIndex: number } | null>(null)

  const commit = useCallback((text: string, cursor: number): void => {
    queryRef.current = text
    cursorRef.current = Math.max(0, Math.min(cursor, text.length))
    setQueryState(text)
    setCursorOffset(cursorRef.current)
  }, [])

  /** The exposed setter moves the cursor to the end of what it writes. */
  const setQuery = useCallback(
    (next: string): void => {
      commit(next, next.length)
    },
    [commit],
  )

  const pushKill = useCallback((killed: string, side: 'append' | 'prepend'): void => {
    if (killed === '') return
    if (killAccumulatingRef.current && killRingRef.current.length > 0) {
      const head = killRingRef.current[killRingRef.current.length - 1] as string
      killRingRef.current[killRingRef.current.length - 1] =
        side === 'append' ? head + killed : killed + head
    } else {
      killRingRef.current.push(killed)
    }
    killAccumulatingRef.current = true
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (!isActive) return
      const text = queryRef.current
      const at = cursorRef.current
      const key = e.key
      const lower = key.toLowerCase()

      // Passthrough FIRST: neither consumes nor edits, and disturbs no
      // kill/yank state.
      if (
        e.ctrl &&
        passthroughCtrlKeys?.some(k => k.toLowerCase() === lower) === true
      ) {
        return
      }

      const isKillKey =
        e.ctrl && (lower === 'k' || lower === 'u' || lower === 'w')
      const isMetaBackspaceKill = e.meta && key === 'backspace'
      const isYankKey = (e.ctrl && lower === 'y') || (e.meta && lower === 'y')
      // Resets after passthrough, before dispatch.
      if (!isKillKey && !isMetaBackspaceKill) killAccumulatingRef.current = false
      if (!isYankKey) yankRef.current = null

      // ── exit grammar ───────────────────────────────────────────────────
      if (key === 'return' || key === 'down') {
        e.stopImmediatePropagation()
        onExit()
        return
      }
      if (key === 'up') {
        e.stopImmediatePropagation()
        if (onExitUp) onExitUp()
        return
      }
      if (key === 'escape') {
        e.stopImmediatePropagation()
        if (onCancel) {
          onCancel()
          return
        }
        if (text !== '') commit('', 0)
        else onExit()
        return
      }
      const cancelOrExit = (): void => {
        if (onCancel) onCancel()
        else onExit()
      }
      if ((key === 'backspace' || (e.ctrl && lower === 'h')) && text === '') {
        e.stopImmediatePropagation()
        // The pager convention, gated by the flag; a held backspace must
        // not throw the user out when the flag is off.
        if (backspaceExitsOnEmpty) cancelOrExit()
        return
      }
      if (e.ctrl && lower === 'd' && text === '') {
        // NOT gated by the empty-backspace flag (deliberate asymmetry).
        e.stopImmediatePropagation()
        cancelOrExit()
        return
      }
      if (e.ctrl && (lower === 'g' || lower === 'c')) {
        e.stopImmediatePropagation()
        // Escape-with-cancel semantics; silent fall-through with no cancel.
        onCancel?.()
        return
      }

      // ── editing ────────────────────────────────────────────────────────
      const wordwise = e.ctrl || e.meta || e.fn

      if (key === 'left' || (e.ctrl && lower === 'b') || (e.meta && lower === 'b')) {
        e.stopImmediatePropagation()
        commit(text, wordwise && key === 'left' ? prevWordStart(text, at) : e.meta && lower === 'b' ? prevWordStart(text, at) : at - 1)
        return
      }
      if (key === 'right' || (e.ctrl && lower === 'f') || (e.meta && lower === 'f')) {
        e.stopImmediatePropagation()
        commit(text, wordwise && key === 'right' ? nextWordEnd(text, at) : e.meta && lower === 'f' ? nextWordEnd(text, at) : at + 1)
        return
      }
      if (key === 'home' || (e.ctrl && lower === 'a')) {
        e.stopImmediatePropagation()
        commit(text, 0)
        return
      }
      if (key === 'end' || (e.ctrl && lower === 'e')) {
        e.stopImmediatePropagation()
        commit(text, text.length)
        return
      }
      if ((key === 'backspace' && !e.ctrl) || (e.ctrl && lower === 'h')) {
        e.stopImmediatePropagation()
        if (at > 0) commit(text.slice(0, at - 1) + text.slice(at), at - 1)
        return
      }
      if (key === 'delete' || (e.ctrl && lower === 'd')) {
        e.stopImmediatePropagation()
        if (at < text.length) commit(text.slice(0, at) + text.slice(at + 1), at)
        return
      }
      if (e.meta && lower === 'd') {
        e.stopImmediatePropagation()
        const end = nextWordEnd(text, at)
        commit(text.slice(0, at) + text.slice(end), at)
        return
      }
      if (e.ctrl && lower === 'k') {
        e.stopImmediatePropagation()
        pushKill(text.slice(at), 'append')
        commit(text.slice(0, at), at)
        return
      }
      if (e.ctrl && lower === 'u') {
        e.stopImmediatePropagation()
        pushKill(text.slice(0, at), 'prepend')
        commit(text.slice(at), 0)
        return
      }
      // ctrl+backspace joins the word-kill chords (the composer's grammar —
      // useTextInput): it kills the word but stays OUT of the accumulation
      // set, so consecutive presses leave separate ring entries.
      if ((e.ctrl && lower === 'w') || ((e.ctrl || e.meta) && key === 'backspace')) {
        e.stopImmediatePropagation()
        const start = prevWordStart(text, at)
        pushKill(text.slice(start, at), 'prepend')
        commit(text.slice(0, start) + text.slice(at), start)
        return
      }
      if (e.ctrl && lower === 'y') {
        e.stopImmediatePropagation()
        const ring = killRingRef.current
        if (ring.length === 0) return
        const ringIndex = ring.length - 1
        const inserted = ring[ringIndex] as string
        commit(text.slice(0, at) + inserted + text.slice(at), at + inserted.length)
        yankRef.current = { at, length: inserted.length, ringIndex }
        return
      }
      if (e.meta && lower === 'y') {
        e.stopImmediatePropagation()
        const yank = yankRef.current
        const ring = killRingRef.current
        if (yank === null || ring.length === 0) return
        const nextIndex = (yank.ringIndex - 1 + ring.length) % ring.length
        const replacement = ring[nextIndex] as string
        const current = queryRef.current
        commit(
          current.slice(0, yank.at) + replacement + current.slice(yank.at + yank.length),
          yank.at + replacement.length,
        )
        yankRef.current = { at: yank.at, length: replacement.length, ringIndex: nextIndex }
        return
      }
      if (key === 'tab') {
        e.stopImmediatePropagation()
        return
      }
      // Every remaining control/meta chord is consumed without editing.
      if (e.ctrl || e.meta) {
        e.stopImmediatePropagation()
        return
      }
      if (REJECTED_KEY_NAMES.has(lower)) {
        e.stopImmediatePropagation()
        return
      }
      // Multi-character payloads insert whole (batched writes, pastes).
      if (key.length >= 1 && key >= ' ') {
        e.stopImmediatePropagation()
        commit(text.slice(0, at) + key + text.slice(at), at + key.length)
      }
    },
    [isActive, onExit, onCancel, onExitUp, passthroughCtrlKeys, backspaceExitsOnEmpty, commit, pushKill],
  )

  // Compatibility bridge: the legacy input channel while active.
  useInput(
    (input, key, event) => {
      const e = new KeyboardEvent(event.keypress)
      // Batched printable chunks (a fast burst or paste grouped into one
      // atom) parse with an EMPTY key name, which short-circuits the
      // projection's `name ?? sequence` fallback — the event arrives with
      // key '' and the text never inserts. The legacy channel still carries
      // the text, so re-key the event from it; the multi-character branch
      // then inserts the payload whole, as documented.
      if (e.key === '' && input.length > 0 && !key.ctrl && !key.meta && !key.escape) {
        handleKeyDown(new KeyboardEvent({ ...event.keypress, name: undefined, sequence: input }))
        return
      }
      handleKeyDown(e)
    },
    { isActive },
  )

  return {
    query,
    setQuery,
    cursorOffset,
    handleKeyDown,
  }
}
