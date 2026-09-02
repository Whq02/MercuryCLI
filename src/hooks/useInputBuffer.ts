
import { useCallback, useRef, useState } from 'react'
import type { PastedContent } from '../utils/config.js'

export type BufferEntry = {
  text: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
}

export type UseInputBufferProps = {
  maxBufferSize: number
  debounceMs: number
}

export type UseInputBufferResult = {
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
  undo: (current: BufferEntry) => BufferEntry | undefined
  redo: (current: BufferEntry) => BufferEntry | undefined
  canUndo: boolean
  canRedo: boolean
  clearBuffer: () => void
}

export function useInputBuffer({
  maxBufferSize,
  debounceMs,
}: UseInputBufferProps): UseInputBufferResult {
  const undoStackRef = useRef<BufferEntry[]>([])
  const redoStackRef = useRef<BufferEntry[]>([])
  const burstAtRef = useRef(0)
  const [depths, setDepths] = useState({ undo: 0, redo: 0 })

  const syncDepths = useCallback((): void => {
    setDepths(previous => {
      const next = { undo: undoStackRef.current.length, redo: redoStackRef.current.length }
      return previous.undo === next.undo && previous.redo === next.redo
        ? previous
        : next
    })
  }, [])

  const bound = useCallback(
    (stack: BufferEntry[]): void => {
      while (stack.length > maxBufferSize) stack.shift()
    },
    [maxBufferSize],
  )

  const pushToBuffer = useCallback(
    (
      text: string,
      cursorOffset: number,
      pastedContents: Record<number, PastedContent> = {},
    ): void => {
      const now = Date.now()
      if (burstAtRef.current !== 0 && now - burstAtRef.current < debounceMs) {
        burstAtRef.current = now
        return
      }
      const last = undoStackRef.current[undoStackRef.current.length - 1]
      if (last !== undefined && last.text === text) {
        if (redoStackRef.current.length > 0) redoStackRef.current = []
        syncDepths()
        return
      }
      undoStackRef.current.push({ text, cursorOffset, pastedContents })
      bound(undoStackRef.current)
      if (redoStackRef.current.length > 0) redoStackRef.current = []
      burstAtRef.current = now
      syncDepths()
    },
    [debounceMs, bound, syncDepths],
  )

  const pushAtomic = useCallback(
    (
      text: string,
      cursorOffset: number,
      pastedContents: Record<number, PastedContent> = {},
    ): void => {
      undoStackRef.current.push({ text, cursorOffset, pastedContents })
      bound(undoStackRef.current)
      if (redoStackRef.current.length > 0) redoStackRef.current = []
      burstAtRef.current = 0
      syncDepths()
    },
    [bound, syncDepths],
  )

  const undo = useCallback(
    (current: BufferEntry): BufferEntry | undefined => {
      const restored = undoStackRef.current.pop()
      burstAtRef.current = 0
      if (restored === undefined) {
        syncDepths()
        return undefined
      }
      redoStackRef.current.push(current)
      bound(redoStackRef.current)
      syncDepths()
      return restored
    },
    [bound, syncDepths],
  )

  const redo = useCallback(
    (current: BufferEntry): BufferEntry | undefined => {
      const restored = redoStackRef.current.pop()
      burstAtRef.current = 0
      if (restored === undefined) {
        syncDepths()
        return undefined
      }
      undoStackRef.current.push(current)
      bound(undoStackRef.current)
      syncDepths()
      return restored
    },
    [bound, syncDepths],
  )

  const clearBuffer = useCallback((): void => {
    undoStackRef.current = []
    redoStackRef.current = []
    burstAtRef.current = 0
    syncDepths()
  }, [syncDepths])

  return {
    pushToBuffer,
    pushAtomic,
    undo,
    redo,
    canUndo: depths.undo > 0,
    canRedo: depths.redo > 0,
    clearBuffer,
  }
}
