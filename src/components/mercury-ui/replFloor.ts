
import type { Theme } from '../../utils/theme.js'

export const COMPOSER_BORDER_SHED_ROWS = 14

export function composerBorderRole(empty: boolean): keyof Theme {
  return empty ? 'promptBorderResting' : 'promptBorder'
}

export function composerBorderStyle(rows: number): 'round' | undefined {
  return rows < COMPOSER_BORDER_SHED_ROWS ? undefined : 'round'
}

export const WHEEL_STEP_ROWS = 3

export function pageStepRows(viewportRows: number): number {
  return Math.max(4, viewportRows - 1)
}
