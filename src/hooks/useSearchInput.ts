
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

const REJECTED_KEY_NAMES = new Set([
  'pageup',
  'pagedown',
  'insert',
  'wheelup',
  'wheeldown',
  'mouse',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
])

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

  const killRingRef = useRef<string[]>([])
  const killAccumulatingRef = useRef(false)
  const yankRef = useRef<{ at: number; length: number; ringIndex: number } | null>(null)

  const commit = useCallback((text: string, cursor: number): void => {
    queryRef.current = text
    cursorRef.current = Math.max(0, Math.min(cursor, text.length))
    setQueryState(text)
    setCursorOffset(cursorRef.current)
  }, [])

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
      if (!isKillKey && !isMetaBackspaceKill) killAccumulatingRef.current = false
      if (!isYankKey) yankRef.current = null

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
        if (backspaceExitsOnEmpty) cancelOrExit()
        return
      }
      if (e.ctrl && lower === 'd' && text === '') {
        e.stopImmediatePropagation()
        cancelOrExit()
        return
      }
      if (e.ctrl && (lower === 'g' || lower === 'c')) {
        e.stopImmediatePropagation()
        onCancel?.()
        return
      }

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
      if (e.ctrl || e.meta) {
        e.stopImmediatePropagation()
        return
      }
      if (REJECTED_KEY_NAMES.has(lower)) {
        e.stopImmediatePropagation()
        return
      }
      if (key.length >= 1 && key >= ' ') {
        e.stopImmediatePropagation()
        commit(text.slice(0, at) + key + text.slice(at), at + key.length)
      }
    },
    [isActive, onExit, onCancel, onExitUp, passthroughCtrlKeys, backspaceExitsOnEmpty, commit, pushKill],
  )

  useInput(
    (input, key, event) => {
      const e = new KeyboardEvent(event.keypress)
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
