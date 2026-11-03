export function retreiveFirstCell(row: string): string {
  return row.split(',')[0] ?? ''
}
