import { randomUUID } from 'node:crypto'
import { BOARD_PACKET_RULE, type BoardEvent, type BoardPacket, type BoardPrincipal, type BoardRead } from '../contracts.js'
import { digest } from './shared.js'
import type { StoreContext } from './context.js'

export function read(ctx: StoreContext, p: BoardPrincipal, input: BoardRead): BoardPacket {
  const { transaction, checkPrincipal, db, latest, events, eventLabels } = ctx
  return transaction(() => {
    checkPrincipal(p)
    const agent = p.author.agentId
    const state = db.prepare('SELECT joined, cursor FROM seat_state WHERE agent = ?').get(agent)!
    const top = Math.min(input.snapshot ?? latest(), latest())
    const cursor = input.since ?? Number(state.cursor)
    for (const id of input.acknowledge ?? []) db.prepare("UPDATE deliveries SET state = 'acknowledged' WHERE recipient = ? AND event = ? AND state = 'presented'").run(agent, id)
    const where = ['seq <= ?', 'NOT EXISTS (SELECT 1 FROM mirror_events WHERE event = events.id)']
    const args: (string | number)[] = [top]
    if (input.thread !== undefined) { where.push('thread = ?'); args.push(input.thread) }
    if (input.team !== undefined) { const labels = eventLabels(input.team); where.push(`json_extract(record, '$.team') IN (${labels.map(() => '?').join(',')})`); args.push(...labels) }
    if (input.task !== undefined) { where.push("(json_extract(record, '$.taskId') = ? OR EXISTS (SELECT 1 FROM json_each(events.record, '$.relatedTasks') WHERE value = ?))"); args.push(input.task, input.task) }
    if (input.mentions !== undefined) { where.push("EXISTS (SELECT 1 FROM json_each(events.record, '$.mentions') WHERE value = ?)"); args.push(input.mentions) }
    if (input.files?.length) { where.push(`EXISTS (SELECT 1 FROM json_each(events.record, '$.files') WHERE value IN (${input.files.map(() => '?').join(',')}))`); args.push(...input.files) }
    const seenClause = 'EXISTS (SELECT 1 FROM seen_events WHERE agent = ? AND event = events.id)'
    const skippedSeen = input.since === undefined ? Number(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${where.join(' AND ')} AND seq > ? AND ${seenClause}`).get(...args, Number(state.joined), agent)!.n) : 0
    if (input.since === undefined) { where.push(`NOT ${seenClause}`); args.push(agent) }
    const chosen = events(db.prepare(`SELECT record FROM events WHERE ${where.join(' AND ')} AND seq > ? ORDER BY seq`).all(...args, cursor))
    const packetId = chosen.length ? randomUUID() : undefined
    if (packetId !== undefined) for (const event of chosen) db.prepare('INSERT INTO read_events VALUES (?, ?, ?)').run(packetId, agent, event.eventId)
    return { events: chosen, snapshot: top, cursor: chosen.at(-1)?.seq ?? cursor, skippedSeen, reread: 'Use since: 0 or since: <seq> to re-read deliberately.', ...(packetId === undefined ? {} : { packetId }) }
  })
}

export function leadPosts(ctx: StoreContext, since: number): BoardEvent[] {
  const { events, db } = ctx
  return events(db.prepare("SELECT e.record FROM deliveries d JOIN events e ON e.id = d.event WHERE d.recipient = 'main' AND d.mode LIKE 'mention-%' AND e.seq > ? ORDER BY e.seq").all(since))
}

export function leadPainted(ctx: StoreContext): number {
  const { db } = ctx
  const row = db.prepare("SELECT seq FROM lead_paint WHERE recipient = 'main'").get() as { seq?: number } | null
  return Number(row?.seq ?? 0)
}

export function markLeadPainted(ctx: StoreContext, seq: number): void {
  const { readOnly, db } = ctx
  if (readOnly) return
  db.prepare("INSERT INTO lead_paint (recipient, seq) VALUES ('main', ?) ON CONFLICT(recipient) DO UPDATE SET seq = MAX(seq, excluded.seq)").run(seq)
}

export function boundary(ctx: StoreContext, p: BoardPrincipal, seen: ReadonlySet<string>): { text: string; eventIds: string[] } | null {
  const { transaction, checkPrincipal, wakes, seats, db, packetText } = ctx
  return transaction(() => {
    checkPrincipal(p)
    const agent = p.author.agentId
    const parts: string[] = []
    const ids: string[] = []
    if (agent === 'main') {
      const waits = wakes.open(seats())
      const id = `waits:${digest(JSON.stringify(waits))}`
      if (waits.length && !seen.has(id)) {
        parts.push(`${JSON.stringify({ waits })}\n${waits.map(wait => `${wait.seat} · waiting on ${wait.event}`).join('\n')}`)
        ids.push(id)
      }
    }
    if (agent === 'main') for (const row of db.prepare('SELECT id, text FROM lead_notices WHERE presented = 0 ORDER BY rowid').all()) {
      if (seen.has(String(row.id))) continue
      parts.push(`crew-board-event:${row.id}\n${JSON.stringify({ notice: row.text })}`); ids.push(String(row.id))
    }
    for (const row of db.prepare('SELECT id, record FROM roster_changes WHERE recipient = ? ORDER BY rowid').all(agent)) {
      if (seen.has(String(row.id))) continue
      parts.push(`crew-board-event:${row.id}\n${JSON.stringify({ roster: JSON.parse(String(row.record)) })}`); ids.push(String(row.id))
    }
    const pending = db.prepare("SELECT e.record FROM deliveries d JOIN events e ON e.id = d.event WHERE d.recipient = ? AND d.state = 'pending' AND NOT EXISTS (SELECT 1 FROM seen_events WHERE agent = d.recipient AND event = d.event) ORDER BY CASE WHEN d.mode LIKE 'mention-%' THEN 0 WHEN d.mode LIKE 'thread-%' THEN 1 ELSE 2 END, e.seq").all(agent)
    for (const row of pending) {
      const event = JSON.parse(String(row.record)) as BoardEvent
      if (seen.has(event.eventId)) continue
      parts.push(`crew-board-event:${event.eventId}\n${packetText(event)}`); ids.push(event.eventId)
    }
    return parts.length ? { text: `${BOARD_PACKET_RULE}\n${parts.join('\n')}`, eventIds: ids } : null
  })
}

export function presented(ctx: StoreContext, p: BoardPrincipal, ids: string[], requestId: string, packets: string[]): void {
  const { transaction, checkPrincipal, db, markSeen, advance, publish } = ctx
  transaction(() => {
    checkPrincipal(p)
    const agent = p.author.agentId
    for (const id of new Set(ids)) {
      db.prepare('DELETE FROM roster_changes WHERE recipient = ? AND id = ?').run(agent, id)
      if (agent === 'main') db.prepare('UPDATE lead_notices SET presented = 1 WHERE id = ?').run(id)
      db.prepare("UPDATE deliveries SET state = 'presented', request = ? WHERE recipient = ? AND event = ? AND state = 'pending'").run(requestId, agent, id)
      if (db.prepare('SELECT event FROM deliveries WHERE recipient = ? AND event = ?').get(agent, id)) markSeen(agent, id)
    }
    for (const id of new Set(packets)) for (const event of db.prepare('SELECT event FROM read_events WHERE recipient = ? AND packet = ?').all(agent, id)) markSeen(agent, String(event.event))
    advance(agent)
  })
  publish()
}
