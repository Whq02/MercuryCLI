import type { Message } from '../../types/message.js'
import { COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG, LOCAL_COMMAND_CAVEAT_TAG, LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js'

function textOf(row: Message | undefined): string {
  if (row?.type === 'user' && typeof row.message.content === 'string') return row.message.content
  if (row?.type === 'system' && row.subtype === 'local_command') return row.content
  return ''
}

export function placeLocalCommandRows(rows: readonly Message[]): readonly Message[] {
  const placed: Array<{ at: number; rows: readonly Message[] }> = []
  let moved = false
  let floor = 0
  for (let i = 0; i < rows.length; i++) {
    const first = rows[i]!
    const caveat = textOf(first).startsWith(`<${LOCAL_COMMAND_CAVEAT_TAG}>`)
    const echo = rows[i + (caveat ? 1 : 0)]
    const text = textOf(echo)
    const answer = textOf(rows[i + (caveat ? 2 : 1)])
    const at = Date.parse(first.timestamp)
    if ((text.startsWith(`<${COMMAND_MESSAGE_TAG}>`) || text.startsWith(`<${COMMAND_NAME_TAG}>`)) && (answer.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) || answer.startsWith(`<${LOCAL_COMMAND_STDERR_TAG}>`))) {
      const count = caveat ? 3 : 2
      const group = { at, rows: rows.slice(i, i + count) }
      const before = placed.findIndex((entry, index) => index >= floor && entry.at > at)
      if (before >= 0) {
        placed.splice(before, 0, group)
        moved = true
      } else placed.push(group)
      i += count - 1
    } else {
      placed.push({ at, rows: [first] })
      if (first.type === 'system' && first.subtype === 'compact_boundary') floor = placed.length
    }
  }
  return moved ? placed.flatMap(entry => entry.rows) : rows
}
