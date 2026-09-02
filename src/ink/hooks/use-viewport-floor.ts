
import { useRef } from 'react'
import type { TerminalSize } from '../components/TerminalSizeContext.js'
import { VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_ROWS, viewportFloorLive } from '../viewportFloor.js'

export type ViewportFloorState = {
  fits: boolean
  line: string | null
  surfaceSize: TerminalSize | null
}

export function useViewportFloor(size: TerminalSize | null, active: boolean): ViewportFloorState {
  const lastFitRef = useRef<TerminalSize | null>(null)
  const verdict = !active || size === null ? ({ fits: true } as const) : viewportFloorLive(size.columns, size.rows)
  if (verdict.fits && size !== null) lastFitRef.current = size
  if (!verdict.fits && lastFitRef.current === null && size !== null) {
    lastFitRef.current = { columns: VIEWPORT_FLOOR_COLS, rows: Math.max(size.rows, VIEWPORT_FLOOR_ROWS) }
  }
  return {
    fits: verdict.fits,
    line: verdict.fits ? null : verdict.line,
    surfaceSize: verdict.fits ? size : lastFitRef.current,
  }
}
