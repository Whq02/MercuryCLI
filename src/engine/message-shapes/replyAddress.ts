const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`)

export function formatClock(ts?: string): string | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export const REPLY_ADDRESS_LEAD = 'answering your'

export function replyAddressLine(marks: ReadonlyArray<{ at?: string }> | undefined): string | null {
  if (marks === undefined || marks.length === 0) return null
  const clocks = [...new Set(marks.map(mark => formatClock(mark.at)).filter((clock): clock is string => clock !== null))]
  if (clocks.length === 0) return `${REPLY_ADDRESS_LEAD} message`
  if (clocks.length === 1) return `${REPLY_ADDRESS_LEAD} ${clocks[0]} message`
  return `${REPLY_ADDRESS_LEAD} ${clocks.slice(0, -1).join(', ')} and ${clocks[clocks.length - 1]} messages`
}

export function replyMarksOf(entry: { inReplyTo?: unknown }): Array<{ at?: string }> | undefined {
  return Array.isArray(entry.inReplyTo) ? (entry.inReplyTo as Array<{ at?: string }>) : undefined
}
