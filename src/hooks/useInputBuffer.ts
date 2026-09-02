// The composer's undo/redo timeline. Both stacks live in REFS —
// legible and writable at the instant the handler runs. Held in component
// state, the restored entry has to be recovered inside an updater callback,
// which produces the right answer exactly once on an idle queue and
// thereafter silently produces nothing: an undo that works in a fresh
// session and never again.

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
  /** Wall-clock stamp of the last recorded TYPING push; 0 = no open burst. */
  const burstAtRef = useRef(0)
  // Depth projections for affordance repaints only — never the record.
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
      // Coalescing: a push inside the debounce window of the last TYPING
      // push is skipped, and each skipped push restarts the window.
      if (burstAtRef.current !== 0 && now - burstAtRef.current < debounceMs) {
        burstAtRef.current = now
        return
      }
      // A typing push whose text equals the last snapshot is a duplicate
      // boundary — skipped, but the redo stack still clears.
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
      // A hard transaction boundary: never coalesces, and closes any open
      // typing burst so the next typing push starts a new entry.
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
      // The live argument captures an in-progress coalesced burst; what the
      // operator most recently typed is what the first undo removes.
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
