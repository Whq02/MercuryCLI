
export const COMPOSER_COLUMNS = 96

export const COMPOSER_SLOT_MAX_ROWS = 8

export function promptsComposerRows(bufferLength: number): number {
  const inputLines = Math.max(1, Math.ceil((bufferLength + 1) / COMPOSER_COLUMNS))
  return Math.min(1 + inputLines, COMPOSER_SLOT_MAX_ROWS)
}
