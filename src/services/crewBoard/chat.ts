import type { BoardModule, BoardViewSnapshot } from './contracts.js'

type Traffic = NonNullable<Parameters<BoardModule['view']>[0]['traffic']>
type ChatRow = { id: string; at: string; name: string; team?: string; kind: string; text: string; thread: string; parent?: string; reply: boolean; traffic: boolean }

export function chatRows(snapshot: BoardViewSnapshot, traffic: Traffic = [], team?: string, thread?: string): ChatRow[] {
  const board = snapshot.events.map(event => ({ id: event.eventId, at: event.createdAt, name: event.authorName ?? event.author.agentId, team: event.team, kind: snapshot.events.some(correction => correction.corrects === event.eventId) ? `${event.kind} → correction` : event.kind, text: event.text, thread: event.threadId, parent: event.corrects ?? event.replyTo, reply: event.replyTo !== undefined || event.corrects !== undefined, traffic: event.kind === 'message' || event.kind === 'notice' }))
  const mirrored = new Set(snapshot.events.map(event => event.clientOpId.replace(/^(message|resume):/, 'crew:')))
  const extra: ChatRow[] = traffic.filter(row => !mirrored.has(row.key) && !snapshot.events.some(event => (event.authorName === row.agent || event.author.agentId === row.agent) && event.text === row.text)).map(row => ({
    id: row.key, at: row.at, name: row.dir === 'to' ? 'main' : row.agent,
    team: snapshot.events.find(event => event.authorName === row.agent || event.author.agentId === row.agent)?.team,
    kind: row.via === 'launch' ? 'brief' : row.via === 'reply' ? 'notice' : 'message',
    text: row.text, thread: row.key, reply: false, traffic: true,
  }))
  const rows = [...board, ...extra].filter(row => (team === undefined || row.team === team) && (thread === undefined || row.thread === thread)).sort((a, b) => a.at.localeCompare(b.at))
  const threads = new Map<string, ChatRow[]>()
  for (const row of rows) {
    const group = threads.get(row.thread) ?? []
    group.push(row)
    threads.set(row.thread, group)
  }
  return [...threads.values()].sort((a, b) => a.at(-1)!.at.localeCompare(b.at(-1)!.at)).flatMap(group => {
    const placed = new Set<string>()
    const visit = (row: ChatRow): ChatRow[] => {
      if (placed.has(row.id)) return []
      placed.add(row.id)
      return [row, ...group.filter(child => child.parent === row.id).flatMap(visit)]
    }
    return [...group.filter(row => !group.some(parent => parent.id === row.parent)).flatMap(visit), ...group.flatMap(visit)]
  })
}
