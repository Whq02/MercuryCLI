export const LIMIT = 10

export function parseRow(row: string): string[] {
  return row.split(',').map(cell => cell.trim())
}
