type StoppedContinuationRow = {
  message?: unknown
  content?: unknown
}

export function stoppedContinuationMessage(row: StoppedContinuationRow): string {
  if (typeof row.message === 'string') return row.message
  if (typeof row.content === 'string') return row.content
  return ''
}
