import { LIMIT, parseRow } from './a.ts'

export function firstCells(row: string): string[] {
  return parseRow(row).slice(0, LIMIT)
}
