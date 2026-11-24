import { wordStartAfter, wordStartBefore } from '../../../platform/text/textSegments.js'
import { useCallback, useRef, useState } from 'react'
import { useClaim } from '../../effects/effects.js'
import { useInput } from '../../themedRenderer.js'
import { KeyboardEvent } from '../../renderer/events/keyboard-event.js'
import { getLastKill, pushToKillRing, recordYank, resetKillAccumulation, resetYankState, updateYankLength, yankPop } from '../vim/textCursor.js'

type UseSearchInputOptions = {
  isActive: boolean
  onExit: () => void
  onCancel?: () => void
  onExitUp?: () => void
  passthroughCtrlKeys?: readonly string[]
  passthroughKeys?: (query: string) => readonly string[]
  initialQuery?: string
  backspaceExitsOnEmpty?: boolean
}

type UseSearchInputReturn = {
  query: string
  setQuery: (value: string | ((prev: string) => string)) => void
  cursorOffset: number
  handleKeyDown: (e: KeyboardEvent) => void
}

type SearchDispatchContext = {
  opts: UseSearchInputOptions
  queryRef: { current: string }
  cursorRef: { current: number }
  applyEdit: (nextQuery: string, nextCursor: number) => void
}

const REJECTED_KEY_NAMES = new Set<string>([
  'pageup',
  'pagedown',
  'insert',
  'wheelup',
  'wheeldown',
  'mouse',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
])

function consume(e: KeyboardEvent): void {
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
}

function isPassthrough(e: KeyboardEvent, opts: UseSearchInputOptions, query: string): boolean {
  const name = e.key.toLowerCase()
  if (e.ctrl) {
    return opts.passthroughCtrlKeys?.some(letter => letter.toLowerCase() === name) ?? false
  }
  if (e.meta || opts.passthroughKeys === undefined) return false
  return opts.passthroughKeys(query).includes(name)
}

function resetKillAndYank(): void {
  resetKillAccumulation()
  resetYankState()
}

function handleKillOrYank(e: KeyboardEvent, ctx: SearchDispatchContext): boolean {
  const { queryRef, cursorRef, applyEdit } = ctx
  const k = e.key
  const lower = k.toLowerCase()

  if (e.ctrl && !e.meta && lower === 'k') {
    consume(e)
    const q = queryRef.current
    const c = cursorRef.current
    const killed = q.slice(c)
    if (killed.length > 0) {
      pushToKillRing(killed, 'append')
      applyEdit(q.slice(0, c), c)
    }
    return true
  }

  if (e.ctrl && !e.meta && lower === 'u') {
    consume(e)
    const q = queryRef.current
    const c = cursorRef.current
    const killed = q.slice(0, c)
    if (killed.length > 0) {
      pushToKillRing(killed, 'prepend')
      applyEdit(q.slice(c), 0)
    }
    return true
  }

  if ((e.ctrl && !e.meta && lower === 'w') || (e.ctrl && k === 'backspace')) {
    consume(e)
    const q = queryRef.current
    const c = cursorRef.current
    const start = wordStartBefore(q, c)
    const killed = q.slice(start, c)
    if (killed.length > 0) {
      pushToKillRing(killed, 'prepend')
      applyEdit(q.slice(0, start) + q.slice(c), start)
    }
    return true
  }

  if (e.ctrl && !e.meta && lower === 'y') {
    consume(e)
    resetKillAccumulation()
    const top = getLastKill()
    if (top.length > 0) {
      const q = queryRef.current
      const c = cursorRef.current
      recordYank(c, top.length)
      applyEdit(q.slice(0, c) + top + q.slice(c), c + top.length)
    }
    return true
  }

  if (e.meta && !e.ctrl && lower === 'y') {
    consume(e)
    resetKillAccumulation()
    const popped = yankPop()
    if (popped !== null) {
      const q = queryRef.current
      updateYankLength(popped.text.length)
      applyEdit(q.slice(0, popped.start) + popped.text + q.slice(popped.start + popped.length), popped.start + popped.text.length)
    }
    return true
  }

  return false
}

function handleNavigation(e: KeyboardEvent, ctx: SearchDispatchContext): boolean {
  const { queryRef, cursorRef, applyEdit } = ctx
  const k = e.key
  const lower = k.toLowerCase()

  if (((e.ctrl || e.meta || e.fn) && k === 'left') || (e.meta && !e.ctrl && lower === 'b')) {
    resetKillAndYank()
    consume(e)
    applyEdit(queryRef.current, wordStartBefore(queryRef.current, cursorRef.current))
    return true
  }

  if (((e.ctrl || e.meta || e.fn) && k === 'right') || (e.meta && !e.ctrl && lower === 'f')) {
    resetKillAndYank()
    consume(e)
    applyEdit(queryRef.current, wordStartAfter(queryRef.current, cursorRef.current))
    return true
  }

  if ((!e.ctrl && !e.meta && !e.fn && k === 'left') || (e.ctrl && !e.meta && lower === 'b')) {
    resetKillAndYank()
    consume(e)
    applyEdit(queryRef.current, Math.max(0, cursorRef.current - 1))
    return true
  }

  if ((!e.ctrl && !e.meta && !e.fn && k === 'right') || (e.ctrl && !e.meta && lower === 'f')) {
    resetKillAndYank()
    consume(e)
    applyEdit(queryRef.current, Math.min(queryRef.current.length, cursorRef.current + 1))
    return true
  }

  if (k === 'home' || (e.ctrl && !e.meta && lower === 'a')) {
    resetKillAndYank()
    consume(e)
    applyEdit(queryRef.current, 0)
    return true
  }

  if (k === 'end' || (e.ctrl && !e.meta && lower === 'e')) {
    resetKillAndYank()
    consume(e)
    applyEdit(queryRef.current, queryRef.current.length)
    return true
  }

  return false
}

function processSearchKey(e: KeyboardEvent, ctx: SearchDispatchContext): void {
  const { opts, queryRef, cursorRef, applyEdit } = ctx
  if (!opts.isActive) return
  if (isPassthrough(e, opts, queryRef.current)) return

  const k = e.key
  const lower = k.toLowerCase()
  const backspaceExitsOnEmpty = opts.backspaceExitsOnEmpty ?? true

  if (k === 'return' || k === 'down') {
    resetKillAndYank()
    consume(e)
    opts.onExit()
    return
  }

  if (k === 'up') {
    resetKillAndYank()
    consume(e)
    opts.onExitUp?.()
    return
  }

  if (k === 'escape') {
    resetKillAndYank()
    consume(e)
    if (opts.onCancel) {
      opts.onCancel()
    } else if (queryRef.current.length > 0) {
      applyEdit('', 0)
    } else {
      opts.onExit()
    }
    return
  }

  if (e.ctrl && !e.meta && (lower === 'g' || lower === 'c')) {
    resetKillAndYank()
    consume(e)
    opts.onCancel?.()
    return
  }

  if ((!e.ctrl && k === 'backspace') || (e.ctrl && !e.meta && lower === 'h')) {
    resetKillAndYank()
    consume(e)
    const q = queryRef.current
    const c = cursorRef.current
    if (q.length === 0) {
      if (backspaceExitsOnEmpty) {
        ;(opts.onCancel ?? opts.onExit)()
      }
      return
    }
    if (c > 0) {
      applyEdit(q.slice(0, c - 1) + q.slice(c), c - 1)
    }
    return
  }

  if ((!e.ctrl && !e.meta && k === 'delete') || (e.ctrl && !e.meta && lower === 'd')) {
    resetKillAndYank()
    consume(e)
    const q = queryRef.current
    const c = cursorRef.current
    if (e.ctrl && lower === 'd' && q.length === 0) {
      ;(opts.onCancel ?? opts.onExit)()
      return
    }
    if (c < q.length) {
      applyEdit(q.slice(0, c) + q.slice(c + 1), c)
    }
    return
  }

  if (e.meta && !e.ctrl && lower === 'd') {
    resetKillAndYank()
    consume(e)
    const q = queryRef.current
    const c = cursorRef.current
    const end = wordStartAfter(q, c)
    if (end > c) {
      applyEdit(q.slice(0, c) + q.slice(end), c)
    }
    return
  }

  if (handleKillOrYank(e, ctx)) return
  if (handleNavigation(e, ctx)) return

  if (k === 'tab' || e.ctrl || e.meta || REJECTED_KEY_NAMES.has(lower)) {
    resetKillAndYank()
    consume(e)
    return
  }

  const text = k === 'space' ? ' ' : k
  if (text.length > 0 && text >= ' ' && text !== '\x7f') {
    resetKillAndYank()
    consume(e)
    const q = queryRef.current
    const c = cursorRef.current
    applyEdit(q.slice(0, c) + text + q.slice(c), c + text.length)
  }
}

export function useSearchInput(options: UseSearchInputOptions): UseSearchInputReturn {
  const initial = options.initialQuery ?? ''
  const [query, setQueryState] = useState(initial)
  const [cursorOffset, setCursorOffsetState] = useState(initial.length)

  const queryRef = useRef(query)
  const cursorRef = useRef(cursorOffset)
  const optionsRef = useRef(options)
  optionsRef.current = options

  useClaim(() => {
    if (!options.isActive) return undefined
    resetKillAndYank()
    return resetKillAndYank
  }, [options.isActive])

  const applyEdit = useCallback((nextQuery: string, nextCursor: number): void => {
    const clamped = Math.max(0, Math.min(nextQuery.length, nextCursor))
    queryRef.current = nextQuery
    cursorRef.current = clamped
    setQueryState(nextQuery)
    setCursorOffsetState(clamped)
  }, [])

  const setQuery = useCallback((value: string | ((prev: string) => string)): void => {
    const next = typeof value === 'function' ? value(queryRef.current) : value
    queryRef.current = next
    cursorRef.current = next.length
    setQueryState(next)
    setCursorOffsetState(next.length)
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      processSearchKey(e, {
        opts: optionsRef.current,
        queryRef,
        cursorRef,
        applyEdit,
      })
    },
    [applyEdit],
  )

  useInput(
    (input, key, event) => {
      const made = new KeyboardEvent(event.keypress)
      const unnamed = made.key === '' && input !== '' && !key.ctrl && !key.meta && !key.escape
      handleKeyDown(unnamed ? new KeyboardEvent({ ...event.keypress, name: undefined, sequence: input }) : made)
    },
    { isActive: options.isActive },
  )

  return {
    query,
    setQuery,
    cursorOffset,
    handleKeyDown,
  }
}
