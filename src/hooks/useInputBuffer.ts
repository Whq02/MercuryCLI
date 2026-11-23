import { useCallback, useRef, useState } from 'react'
import type { PastedContent } from '../utils/config.js'

type InputBufferEntry = {
  text: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
}

type UseInputBufferProps = {
  maxBufferSize: number
  debounceMs: number
}

type UseInputBufferResult = {
  pushToBuffer: (
    text: string,
    cursorOffset: number,
    pastedContents?: Record<number, PastedContent>,
  ) => void
  pushAtomic: (
    text: string,
    cursorOffset: number,
    pastedContents?: Record<number, PastedContent>,
  ) => void
  undo: (current: InputBufferEntry) => InputBufferEntry | undefined
  redo: (current: InputBufferEntry) => InputBufferEntry | undefined
  canUndo: boolean
  canRedo: boolean
  clearBuffer: () => void
}

function pushBounded(
  stack: InputBufferEntry[],
  entry: InputBufferEntry,
  maxSize: number,
): void {
  const cap = Math.max(0, maxSize)
  if (cap === 0) {
    stack.length = 0
    return
  }
  stack.push(entry)
  if (stack.length > cap) {
    stack.splice(0, stack.length - cap)
  }
}

export function useInputBuffer({
  maxBufferSize,
  debounceMs,
}: UseInputBufferProps): UseInputBufferResult {
  const undoStackRef = useRef<InputBufferEntry[]>([])
  const redoStackRef = useRef<InputBufferEntry[]>([])
  const lastPushTimeRef = useRef<number | null>(null)
  const [flags, setFlags] = useState({ canUndo: false, canRedo: false })

  const syncFlags = useCallback(() => {
    const canUndo = undoStackRef.current.length > 0
    const canRedo = redoStackRef.current.length > 0
    setFlags(prev =>
      prev.canUndo === canUndo && prev.canRedo === canRedo
        ? prev
        : { canUndo, canRedo },
    )
  }, [])

  const pushToBuffer = useCallback(
    (
      text: string,
      cursorOffset: number,
      pastedContents: Record<number, PastedContent> = {},
    ) => {
      const now = Date.now()
      if (
        lastPushTimeRef.current !== null &&
        now - lastPushTimeRef.current < debounceMs
      ) {
        lastPushTimeRef.current = now
        return
      }
      const stack = undoStackRef.current
      const latest = stack[stack.length - 1]
      if (latest !== undefined && latest.text === text) {
        redoStackRef.current.length = 0
        syncFlags()
        return
      }
      pushBounded(stack, { text, cursorOffset, pastedContents }, maxBufferSize)
      redoStackRef.current.length = 0
      lastPushTimeRef.current = now
      syncFlags()
    },
    [maxBufferSize, debounceMs, syncFlags],
  )

  const pushAtomic = useCallback(
    (
      text: string,
      cursorOffset: number,
      pastedContents: Record<number, PastedContent> = {},
    ) => {
      pushBounded(
        undoStackRef.current,
        { text, cursorOffset, pastedContents },
        maxBufferSize,
      )
      redoStackRef.current.length = 0
      lastPushTimeRef.current = null
      syncFlags()
    },
    [maxBufferSize, syncFlags],
  )

  const undo = useCallback(
    (current: InputBufferEntry): InputBufferEntry | undefined => {
      lastPushTimeRef.current = null
      const popped = undoStackRef.current.pop()
      if (popped === undefined) return undefined
      pushBounded(redoStackRef.current, current, maxBufferSize)
      syncFlags()
      return popped
    },
    [maxBufferSize, syncFlags],
  )

  const redo = useCallback(
    (current: InputBufferEntry): InputBufferEntry | undefined => {
      lastPushTimeRef.current = null
      const popped = redoStackRef.current.pop()
      if (popped === undefined) return undefined
      pushBounded(undoStackRef.current, current, maxBufferSize)
      syncFlags()
      return popped
    },
    [maxBufferSize, syncFlags],
  )

  const clearBuffer = useCallback(() => {
    undoStackRef.current.length = 0
    redoStackRef.current.length = 0
    lastPushTimeRef.current = null
    syncFlags()
  }, [syncFlags])

  return {
    pushToBuffer,
    pushAtomic,
    undo,
    redo,
    canUndo: flags.canUndo,
    canRedo: flags.canRedo,
    clearBuffer,
  }
}
