
export function appendRowWithIdentity<Row extends { uuid: string }>(
  rows: readonly Row[],
  message: Row,
): Row[] {
  const at = rows.findIndex(row => row.uuid === message.uuid)
  if (at < 0) return [...rows, message]
  const next = rows.slice()
  next[at] = message
  return next
}
