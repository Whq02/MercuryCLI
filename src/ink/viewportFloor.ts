
import { HELM_HOME_MIN_COLS } from '../utils/helmGeometry.js'

export const VIEWPORT_FLOOR_COLS = HELM_HOME_MIN_COLS

export const VIEWPORT_FLOOR_ROWS = 22

export const VIEWPORT_FLOOR_EXIT_BAND = 3

export type ViewportFloorVerdict = { fits: true } | { fits: false; line: string }

export function viewportFloorVerdict(columns: number, rows: number, surfaceUp: boolean): ViewportFloorVerdict {
  const colFloor = surfaceUp ? VIEWPORT_FLOOR_COLS - VIEWPORT_FLOOR_EXIT_BAND : VIEWPORT_FLOOR_COLS
  if (columns >= colFloor && rows >= VIEWPORT_FLOOR_ROWS) return { fits: true }
  return { fits: false, line: viewportFloorLine(columns, rows) }
}

export function viewportFloorLine(columns: number, rows: number): string {
  const forms = [
    `Mercury needs ${VIEWPORT_FLOOR_COLS} columns and ${VIEWPORT_FLOOR_ROWS} rows · this window is ${columns}×${rows} · resize the terminal to continue`,
    `needs ${VIEWPORT_FLOOR_COLS} columns × ${VIEWPORT_FLOOR_ROWS} rows · ${columns}×${rows} · resize to continue`,
    `needs ${VIEWPORT_FLOOR_COLS}×${VIEWPORT_FLOOR_ROWS} · resize`,
  ]
  const room = Math.max(0, columns - 2)
  return forms.find(f => f.length <= room) ?? forms[forms.length - 1]!
}
