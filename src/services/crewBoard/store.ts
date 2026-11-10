import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { BOARD_PACKET_RULE, boardReachNote, boardSeatName, boardLabelKey, type BoardChannel, type BoardEvent, type BoardPacket, type BoardPost, type BoardPrincipal, type BoardReach, type BoardReceipt, type BoardSeat, type BoardStore, type BoardViewSnapshot } from './contracts.js'
import { CHAT_OFF, type BoardChat } from './party.js'
import type { CrewChatLifecycle } from '../../types/message.js'
import { resolveWatchRoot } from '../../utils/watchRoot.js'
import { boardAddressesSeat, boardWaitWords, parseBoardWait } from './waits.js'
import { createWakeState } from './wakeState.js'

type Database = {
  exec(sql: string): unknown
  prepare(sql: string): { all(...values: (string | number)[]): Record<string, unknown>[]; get(...values: (string | number)[]): Record<string, unknown> | null | undefined; run(...values: (string | number)[]): unknown }
  close(): void
}
const requireRuntime = createRequire(import.meta.url)
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const normalize = (input: BoardPost) => ({
  clientOpId: input.clientOpId, kind: input.kind, text: input.text,
  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
  ...(input.corrects === undefined ? {} : { corrects: input.corrects }),
  ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  ...(input.about === undefined ? {} : { about: input.about }),
  ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
  mentions: [...new Set([...(input.mentions ?? []), ...(input.to ?? []), ...Array.from(input.text.matchAll(/(?<![\w@])@([\p{L}\p{N}_][\p{L}\p{N}_.-]*)/gu), match => match[1]!.replace(/[.]+$/, ''))].map(name => name.replace(/^@/, '')))].sort(),
  relatedTasks: [...new Set(input.relatedTasks ?? [])].sort(),
  files: [...new Set(input.files ?? [])].sort(), refs: input.refs ?? [],
})
const feeds = new Map<string, Set<() => void>>()
const validTeam = (team: string): boolean => /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,79}$/u.test(team) && !['all', 'general'].includes(team.toLowerCase())

export function open(path: string, sessionId: string, now: () => number = Date.now, readOnly = false, live: (agent: string) => boolean = () => true): BoardStore {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const sqlite = requireRuntime(process.versions.bun ? 'bun:sqlite' : 'node:sqlite')
  const db: Database = process.versions.bun
    ? readOnly ? new sqlite.Database(path, { readonly: true }) : new sqlite.Database(path)
    : new sqlite.DatabaseSync(path, { readOnly })
  db.exec('PRAGMA busy_timeout = 5000')
  const hasTable = (name: string): boolean => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null
  if (!readOnly) {
    db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS identity (session TEXT PRIMARY KEY, wave TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS seat_state (agent TEXT PRIMARY KEY, joined INTEGER NOT NULL, cursor INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS seen_events (agent TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(agent, event));
    CREATE TABLE IF NOT EXISTS mirror_events (event TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS lead_notices (id TEXT PRIMARY KEY, agent TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL, presented INTEGER NOT NULL DEFAULT 0, UNIQUE(agent, subject));
    CREATE TABLE IF NOT EXISTS members (agent TEXT PRIMARY KEY, name TEXT NOT NULL, execution TEXT NOT NULL, enrolled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS captains (team TEXT PRIMARY KEY, agent TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS enrollments (agent TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT, captain INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS retirements (agent TEXT PRIMARY KEY, successor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS roster_changes (id TEXT NOT NULL, recipient TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(id, recipient));
    CREATE TABLE IF NOT EXISTS read_events (packet TEXT NOT NULL, recipient TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(packet, event));
    CREATE TABLE IF NOT EXISTS interests (agent TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(agent, kind, value));
    CREATE TABLE IF NOT EXISTS lead_paint (recipient TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chat_state (id INTEGER PRIMARY KEY CHECK (id = 1), switched INTEGER NOT NULL DEFAULT 1, filter TEXT NOT NULL DEFAULT '{"kind":"all"}', cursor INTEGER NOT NULL DEFAULT 0, intro INTEGER NOT NULL DEFAULT 0, introduced INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, op TEXT NOT NULL, digest TEXT NOT NULL, thread TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(author, op));
    CREATE TABLE IF NOT EXISTS deliveries (recipient TEXT NOT NULL, event TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', request TEXT, PRIMARY KEY(recipient, event));
    DROP TABLE IF EXISTS board_limits; DROP TABLE IF EXISTS wave_controls; DROP TABLE IF EXISTS cap_notices; DROP TABLE IF EXISTS whole_deliveries; DROP TABLE IF EXISTS reads; DROP TABLE IF EXISTS requests;`)
    for (const [table, columns] of [['members', ['credits', 'refilled', 'posts', 'admitted']], ['seat_state', ['read_cost']], ['deliveries', ['packet', 'charge']]] as const) {
      const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)))
      for (const column of columns) if (present.has(column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    }
  }
  const identity = () => db.prepare('SELECT session, wave FROM identity').get()
  let prior = identity()
  if (prior == null && !readOnly) {
    db.exec('BEGIN IMMEDIATE')
    try { db.prepare('INSERT OR IGNORE INTO identity SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM identity)').run(sessionId, randomUUID()); prior = identity(); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  if (prior == null) { db.close(); throw new Error('This board has no session.') }
  if (prior.session !== sessionId) { db.close(); throw new Error('This board belongs to another session.') }
  if (!readOnly) {
    db.exec('INSERT OR IGNORE INTO chat_state (id) VALUES (1); INSERT OR IGNORE INTO seat_state (agent, joined, cursor) SELECT agent, 0, 0 FROM members WHERE enrolled = 1;')
  }
  const hasCaptains = hasTable('captains')
  const hasChat = hasTable('chat_state')
  const wakes = createWakeState(db, readOnly)
  const hasEnrollments = hasTable('enrollments')
  const waveId = String(db.prepare('SELECT wave FROM identity').get()!.wave)
  const boardId = `board-${waveId}`
  const listeners = new Set<() => void>()
  const feedKey = resolve(path)
  let watcher: FSWatcher | undefined
  let closed = false
  const version = (): string => JSON.stringify([db.prepare('SELECT MAX(seq) AS seq FROM events').get()!.seq, db.prepare("SELECT agent, value FROM interests WHERE kind = 'membership' ORDER BY agent").all(), hasCaptains ? db.prepare('SELECT team, agent FROM captains ORDER BY team').all() : [], wakes.version(), db.prepare('SELECT agent FROM members WHERE enrolled = 1 ORDER BY agent').all()])
  let observed = version()
  const emit = (): void => {
    if (closed) return
    let next: string
    try { next = version() } catch { return }
    if (observed === next) return
    observed = next
    for (const listener of listeners) { try { listener() } catch {} }
  }
  const publish = (): void => {
    const signal = `${path}.${randomUUID()}.notify`
    try { writeFileSync(signal, '', { mode: 0o600 }); renameSync(signal, `${path}.notify`) } catch { try { rmSync(signal, { force: true }) } catch {} }
    for (const listener of feeds.get(feedKey) ?? []) listener()
  }
  const transaction = <T,>(fn: () => T): T => {
    if (closed) throw new Error('The board is closed.')
    if (readOnly) throw new Error('This board reader cannot write.')
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const member = (agent: string): boolean => !closed && db.prepare('SELECT agent FROM members WHERE agent = ? AND enrolled = 1').get(agent) != null
  const checkPrincipal = (p: BoardPrincipal): void => {
    if (p.author.sessionId !== sessionId || !member(p.author.agentId)) throw new Error('This seat is not enrolled in this wave.')
    if (db.prepare('SELECT execution FROM members WHERE agent = ?').get(p.author.agentId)?.execution !== p.author.executionId) throw new Error('This execution no longer holds this seat.')
  }
  const notice = (agent: string, subject: string, detail: string): void => {
    const name = String(db.prepare('SELECT name FROM members WHERE agent = ?').get(agent)?.name ?? agent)
    db.prepare('INSERT OR IGNORE INTO lead_notices (id, agent, subject, text) VALUES (?, ?, ?, ?)').run(`notice:${randomUUID()}`, agent, subject, `${name}: ${detail}`)
  }
  const markSeen = (agent: string, event: string): void => { db.prepare('INSERT OR IGNORE INTO seen_events VALUES (?, ?)').run(agent, event); wakes.presented(agent, [event]) }
  const advance = (agent: string): number => {
    const current = Number(db.prepare('SELECT cursor FROM seat_state WHERE agent = ?').get(agent)!.cursor)
    const next = Number(db.prepare('SELECT COALESCE(MIN(seq) - 1, (SELECT COALESCE(MAX(seq), 0) FROM events)) AS cursor FROM events WHERE seq > ? AND NOT EXISTS (SELECT 1 FROM mirror_events WHERE event = events.id) AND NOT EXISTS (SELECT 1 FROM seen_events WHERE agent = ? AND event = events.id)').get(current, agent)!.cursor)
    db.prepare('UPDATE seat_state SET cursor = ? WHERE agent = ?').run(Math.max(current, next), agent)
    return Math.max(current, next)
  }
  const events = (rows: Record<string, unknown>[]): BoardEvent[] => rows.map(row => JSON.parse(String(row.record)) as BoardEvent)
  const leadPending = (order: 'ASC' | 'DESC'): BoardEvent | null => {
    const row = db.prepare(`SELECT e.record FROM deliveries d JOIN events e ON e.id = d.event WHERE d.recipient = 'main' AND d.mode = 'mention-wake-body' AND d.state = 'pending' AND NOT EXISTS (SELECT 1 FROM seen_events WHERE agent = d.recipient AND event = d.event) ORDER BY e.seq ${order} LIMIT 1`).get()
    return row ? JSON.parse(String(row.record)) as BoardEvent : null
  }
  const latest = (): number => Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()!.seq)
  const packetText = (e: BoardEvent): string => {
    const owner = e.authorRole === 'owner'
    const envelope = JSON.stringify({ eventId: e.eventId, seq: e.seq, who: e.author.agentId, when: e.createdAt, kind: e.kind, authorRole: e.authorRole ?? 'peer', ...(owner && e.channel ? { channel: e.channel } : {}), thread: e.threadId, ...(e.taskId === undefined ? {} : { task: e.taskId }), about: e.about, refs: e.refs })
    if (owner) return `${envelope}\n[owner]: ${e.text}`
    return `${envelope}\n[${boardSeatName({ name: e.authorName ?? e.author.agentId, captain: e.captain })}]${e.team ? ` [${e.team}]` : ''} [${e.kind}]: ${e.text}`
  }
  const canonicalTeam = (team: string): string => {
    const labels = [...db.prepare("SELECT value FROM interests WHERE kind = 'membership' ORDER BY rowid").all(), ...(hasEnrollments ? db.prepare("SELECT team AS value FROM enrollments WHERE team != '' ORDER BY rowid").all() : [])]
    return labels.map(row => String(row.value)).find(label => boardLabelKey(label) === boardLabelKey(team)) ?? team
  }
  const teamOf = (agent: string): string | undefined => {
    const value = db.prepare("SELECT value FROM interests WHERE agent = ? AND kind = 'membership'").get(agent)?.value
    return value === undefined ? undefined : canonicalTeam(String(value))
  }
  const roster = () => db.prepare('SELECT agent, name FROM members WHERE enrolled = 1 ORDER BY rowid').all()
  const captainRows = (team: string) => hasCaptains ? db.prepare('SELECT team, agent FROM captains ORDER BY rowid').all().filter(row => boardLabelKey(String(row.team)) === boardLabelKey(team)) : []
  const captainId = (team: string | undefined): string | undefined => team === undefined ? undefined : captainRows(team)[0]?.agent as string | undefined
  const eventLabels = (team: string): string[] => [...new Set([team, ...db.prepare("SELECT DISTINCT json_extract(record, '$.team') AS value FROM events WHERE json_extract(record, '$.team') IS NOT NULL").all().map(row => String(row.value)).filter(label => boardLabelKey(label) === boardLabelKey(team))])]
  const seats = (): BoardSeat[] => roster().map(row => {
    const agent = String(row.agent), team = teamOf(agent), wait = wakes.wait(agent), wakeProblem = wakes.problem(agent)
    return { agent, name: String(row.name), state: wakes.state(agent), ...(wait ? { wait } : {}), ...(wakeProblem ? { wakeProblem } : {}), ...(team !== undefined ? { team } : {}), ...(captainId(team) === agent ? { captain: true as const } : {}) }
  })
  const reserveCount = (team: string, agent: string): number => new Set(db.prepare("SELECT agent, value FROM interests JOIN members USING (agent) WHERE kind = 'membership' AND enrolled = 1 UNION ALL SELECT agent, team AS value FROM enrollments").all().filter(row => row.agent !== agent && row.agent !== 'main' && boardLabelKey(String(row.value)) === boardLabelKey(team)).map(row => String(row.agent))).size
  const checkEnrollment = (agent: string, team: string | undefined, captain = false): void => {
    if (team !== undefined && !validTeam(team)) throw new Error('Use a team label of letters, numbers, dots, dashes or underscores; all and general are reserved.')
    if (team !== undefined && agent !== 'main' && reserveCount(team, agent) >= 4 && !captainId(team) && !captain) throw new Error(`Name a captain for team ${team} before its fifth seat, or launch this named seat with captain: true.`)
  }
  const appoint = (team: string, agent: string): void => {
    const current = captainRows(team)
    if (current.length === 1 && current[0]!.agent === agent) return
    for (const row of current) db.prepare('DELETE FROM captains WHERE team = ? COLLATE BINARY').run(String(row.team))
    db.prepare('INSERT INTO captains VALUES (?, ?)').run(canonicalTeam(team), agent)
    wakes.captains(seats(), latest())
    const seat = seats().find(seat => seat.agent === agent)!
    const record = JSON.stringify({ team, captain: seat.agent, name: boardSeatName(seat) })
    const id = `roster:${randomUUID()}`
    for (const member of roster()) db.prepare('INSERT INTO roster_changes VALUES (?, ?, ?)').run(id, String(member.agent), record)
  }
  const takeName = (name: string, agent: string): boolean => {
    const carries = (other: unknown): boolean => String(other).toLowerCase() === name.toLowerCase()
    const holders = roster().filter(row => row.agent !== 'main' && row.agent !== agent && carries(row.name)).map(row => String(row.agent))
    const launching = db.prepare('SELECT agent, name FROM enrollments').all().some(row => row.agent !== agent && carries(row.name))
    if (launching || holders.some(holder => wakes.state(holder) === 'running' && live(holder))) throw new Error(`A seat named ${name} is running on this board; stop it, or launch this one under another name.`)
    for (const holder of holders) {
      db.prepare('UPDATE seat_state SET active = 0 WHERE agent = ?').run(holder)
      wakes.settle(holder, String(db.prepare('SELECT execution FROM members WHERE agent = ?').get(holder)!.execution), latest())
      db.prepare('UPDATE members SET enrolled = 0 WHERE agent = ?').run(holder)
      db.prepare('INSERT INTO retirements VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET successor = excluded.successor').run(holder, agent)
    }
    return holders.length > 0
  }
  const reinstate = (launches: string, ...agents: string[]): boolean => {
    const back = db.prepare(`SELECT agent FROM retirements WHERE successor IN (${launches})`).all(...agents)
    for (const row of back) db.prepare('UPDATE members SET enrolled = 1 WHERE agent = ?').run(String(row.agent))
    db.prepare(`DELETE FROM retirements WHERE successor IN (${launches})`).run(...agents)
    return back.length > 0
  }
  const succeed = (agent: string, team: string | undefined): void => {
    for (const row of db.prepare('SELECT agent FROM retirements WHERE successor = ?').all(agent)) {
      const retired = String(row.agent)
      wakes.retire(retired, agent)
      for (const led of db.prepare('SELECT team, agent FROM captains ORDER BY rowid').all().filter(captaincy => captaincy.agent === retired)) {
        if (team !== undefined && boardLabelKey(String(led.team)) === boardLabelKey(team)) appoint(team, agent)
        else db.prepare('DELETE FROM captains WHERE agent = ?').run(retired)
      }
    }
  }
  const appendEvent = (event: BoardEvent): void => {
    db.prepare('INSERT INTO events (id, author, op, digest, thread, record) VALUES (?, ?, ?, ?, ?, ?)').run(event.eventId, event.author.agentId, event.clientOpId, event.payloadDigest, event.threadId, '{}')
    event.seq = latest()
    db.prepare('UPDATE events SET record = ? WHERE id = ?').run(JSON.stringify(event), event.eventId)
  }
  const lifecycleEvent = (p: BoardPrincipal, lifecycle: CrewChatLifecycle, text: string): void => {
    const post = normalize({ clientOpId: `lifecycle:${lifecycle.kind}`, kind: 'notice', text })
    const team = teamOf(p.author.agentId)
    const event: BoardEvent = { ...post, mentions: [], addresses: [], authorRole: 'system', lifecycle, ...(team === undefined ? {} : { team }), ...(captainId(team) === p.author.agentId ? { captain: true } : {}), schema: 1, boardId, waveId, seq: 0, eventId: randomUUID(), author: p.author, authorName: p.name, createdAt: new Date(now()).toISOString(), payloadDigest: digest(JSON.stringify(post)), threadId: randomUUID(), policyRevision: 1 }
    appendEvent(event)
    db.prepare('INSERT INTO mirror_events VALUES (?)').run(event.eventId)
  }
  const resolveMentions = (names: string[]): { mentions: string[]; unknownMentions: string[] } => {
    const members = roster()
    const mentions = new Set<string>()
    const unknownMentions: string[] = []
    for (const name of names) {
      const targets = name.toLowerCase() === 'all' ? members : members.filter(row => String(row.agent).toLowerCase() === name.toLowerCase() || String(row.name).toLowerCase() === name.toLowerCase() || boardLabelKey(teamOf(String(row.agent)) ?? '') === boardLabelKey(name))
      if (!targets.length) unknownMentions.push(name)
      for (const target of targets) mentions.add(String(target.agent))
    }
    return { mentions: [...mentions].sort(), unknownMentions }
  }
  const snapshot = (before?: number, thread?: string, team?: string): BoardViewSnapshot => {
    const top = latest()
    const end = before ?? top + 1
    const filters = ['seq < ?', "COALESCE(json_extract(record, '$.lifecycle.kind'), 'done') NOT IN ('launched', 'joined')"]
    const values: (string | number)[] = [end]
    if (thread !== undefined) { filters.push('thread = ?'); values.push(thread) }
    if (team !== undefined) { const labels = eventLabels(team); filters.push(`json_extract(record, '$.team') IN (${labels.map(() => '?').join(',')})`); values.push(...labels) }
    const filter = filters.join(' AND ')
    const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${filter}`).get(...values)!.n)
    const labels = new Map<string, string>()
    for (const row of [...db.prepare("SELECT value FROM interests WHERE kind = 'membership' ORDER BY rowid").all(), ...db.prepare("SELECT json_extract(record, '$.team') AS value FROM events WHERE json_extract(record, '$.team') IS NOT NULL GROUP BY value ORDER BY MIN(seq)").all()]) {
      const label = canonicalTeam(String(row.value)), key = boardLabelKey(label)
      if (!labels.has(key)) labels.set(key, label)
    }
    const teams = [...labels.values()].sort()
    const names = db.prepare("SELECT name FROM members UNION SELECT COALESCE(json_extract(record, '$.authorName'), json_extract(record, '$.author.agentId')) AS name FROM events").all().map(row => String(row.name))
    const duplicateMinutes = db.prepare("SELECT substr(json_extract(record, '$.createdAt'), 1, 16) AS minute FROM events GROUP BY minute HAVING COUNT(*) > 1").all().map(row => String(row.minute))
    return { on: true, events: events(db.prepare(`SELECT record FROM events WHERE ${filter} ORDER BY seq DESC LIMIT 32`).all(...values)).reverse(), seats: seats(), teams, names, duplicateMinutes, snapshot: top, omitted: Math.max(0, count - 32), later: Math.max(0, top - end + 1), chat: chat(), peerTurns: wakes.turns(), record: { path, sessionId } }
  }
  const chat = (): BoardChat => {
    const row = hasChat ? db.prepare('SELECT switched, filter FROM chat_state WHERE id = 1').get() : null
    return row ? { on: row.switched === 1, filter: JSON.parse(String(row.filter)) } : CHAT_OFF
  }
  const store: BoardStore = {
    chat,
    setChat(next) {
      transaction(() => {
        db.prepare('UPDATE chat_state SET switched = ?, filter = ?, cursor = CASE WHEN ? THEN (SELECT COALESCE(MAX(seq), 0) FROM events) ELSE cursor END WHERE id = 1').run(next.on ? 1 : 0, JSON.stringify(next.filter), next.on ? 1 : 0)
        if (next.on) db.prepare("UPDATE chat_state SET intro = (SELECT COALESCE(MIN(seq), 0) FROM events WHERE json_extract(record, '$.lifecycle.kind') = 'launched'), introduced = 1 WHERE id = 1 AND introduced = 0").run()
      })
      for (const listener of listeners) listener()
    },
    screenEvents(since) { return events(db.prepare('SELECT record FROM events WHERE seq > ? ORDER BY seq LIMIT 200').all(since)) },
    screenCursor() { return hasChat ? Number(db.prepare('SELECT cursor FROM chat_state WHERE id = 1').get()?.cursor ?? 0) : 0 },
    markScreenCursor(seq) {
      if (readOnly || !hasChat) return
      db.prepare('UPDATE chat_state SET cursor = MAX(cursor, MIN(?, (SELECT COALESCE(MAX(seq), 0) FROM events))) WHERE id = 1').run(seq)
    },
    screenIntroduction() {
      const seq = hasChat ? Number(db.prepare('SELECT intro FROM chat_state WHERE id = 1').get()?.intro ?? 0) : 0
      const row = seq > 0 ? db.prepare('SELECT record FROM events WHERE seq = ?').get(seq) : null
      return row ? events([row])[0]! : null
    },
    markScreenIntroduced() {
      if (readOnly || !hasChat) return
      db.prepare('UPDATE chat_state SET intro = 0 WHERE id = 1').run()
    },
    settle(p) {
      transaction(() => {
        checkPrincipal(p)
        db.prepare('UPDATE seat_state SET active = 0 WHERE agent = ?').run(p.author.agentId)
        wakes.settle(p.author.agentId, p.author.executionId, latest())
      })
      publish()
    },
    complete(p, outcome) {
      const lifecycle = transaction((): CrewChatLifecycle | undefined => {
        checkPrincipal(p)
        const seat = seats().find(seat => seat.agent === p.author.agentId)!
        if (!wakes.complete(seat, p.author.executionId, latest(), outcome)) return undefined
        db.prepare('UPDATE seat_state SET active = 0 WHERE agent = ?').run(p.author.agentId)
        if (outcome !== 'completed') return undefined
        const wait = wakes.wait(seat.agent)
        return wait ? { kind: 'parked', event: boardWaitWords(wait.predicate) } : { kind: 'done' }
      })
      publish()
      return lifecycle
    },
    resumeAdmitted(p) {
      transaction(() => { checkPrincipal(p); wakes.admit(p.author.agentId) })
      publish()
    },
    pendingWakes() { return wakes.pending().filter(wake => member(wake.agent)) },
    claimWake(p, wake) {
      const claim = transaction(() => {
        checkPrincipal(p)
        if (p.author.agentId !== 'main') throw new Error('Only the lead runner dispatches board wakes.')
        return member(wake.agent) ? wakes.claim(wake) : null
      })
      if (claim) publish()
      return claim
    },
    wakePacket(p, claim) {
      checkPrincipal(p)
      if (p.author.agentId !== 'main' || !wakes.holds(claim)) return null
      const member = db.prepare('SELECT name, execution FROM members WHERE agent = ? AND enrolled = 1').get(claim.agent)
      if (!member) return null
      return store.boundary({ author: { sessionId, agentId: claim.agent, executionId: String(member.execution) }, name: String(member.name) }, new Set())
    },
    admitWake(p, claim) {
      transaction(() => {
        checkPrincipal(p)
        if (p.author.agentId !== 'main') throw new Error('Only the lead runner dispatches board wakes.')
        wakes.admitted(claim)
      })
      publish()
    },
    holdWake(p, claim, reason, problem) {
      const held = transaction(() => {
        checkPrincipal(p)
        if (p.author.agentId !== 'main' || !wakes.holds(claim)) return false
        wakes.hold(claim, reason, problem)
        notice(claim.agent, `wake:${claim.id}`, `The board resume did not start: ${reason} The lead can use ResumeCrewmate.`)
        return true
      })
      if (held) publish()
      return held
    },
    reserveEnrollment(p, seat) {
      const retired = transaction(() => {
        checkPrincipal(p)
        if (p.author.agentId !== 'main') throw new Error('Only the lead launches board seats.')
        if (!seat.agent || !seat.name.trim() || seat.agent.toLowerCase() === 'owner' || seat.name.trim().toLowerCase() === 'owner') throw new Error('Owner is reserved for the operator.')
        if (seat.name.trim().toLowerCase() === 'main') throw new Error('Main is reserved for the lead.')
        if (seat.agent.toLowerCase() === 'all' || seat.name.trim().toLowerCase() === 'all') throw new Error('All is reserved for the whole crew.')
        if (member(seat.agent)) throw new Error('This seat is already enrolled; use swarm_captain to appoint it.')
        if (seat.captain && !seat.team) throw new Error('A captain launch needs name and team.')
        const team = seat.team === undefined ? undefined : canonicalTeam(seat.team)
        const took = seat.named === true && takeName(seat.name, seat.agent)
        checkEnrollment(seat.agent, team, seat.captain)
        db.prepare('INSERT INTO enrollments (agent, name, team, captain) VALUES (?, ?, ?, ?)').run(seat.agent, seat.name, team ?? '', seat.captain ? 1 : 0)
        return took
      })
      if (retired) publish()
    },
    cancelEnrollment(p, agent) {
      const back = transaction(() => {
        checkPrincipal(p)
        if (p.author.agentId !== 'main') throw new Error('Only the lead cancels a launch.')
        const reinstated = reinstate('SELECT agent FROM enrollments WHERE agent = ?', agent)
        db.prepare('DELETE FROM enrollments WHERE agent = ?').run(agent)
        return reinstated
      })
      if (back) publish()
    },
    enroll(p) {
      if (p.author.sessionId !== sessionId) throw new Error('A board cannot enroll another session.')
      if (p.author.agentId.toLowerCase() === 'owner' || p.name.trim().toLowerCase() === 'owner') throw new Error('Owner is reserved for the operator.')
      if (p.author.agentId !== 'main' && p.name.trim().toLowerCase() === 'main') throw new Error('Main is reserved for the lead.')
      if (p.author.agentId.toLowerCase() === 'all' || p.name.trim().toLowerCase() === 'all') throw new Error('All is reserved for the whole crew.')
      transaction(() => {
        if (p.author.agentId === 'main') {
          const stored = db.prepare('SELECT execution FROM members WHERE agent = ?').get('main')?.execution
          if (stored !== undefined && stored !== p.author.executionId) {
            reinstate('SELECT agent FROM enrollments')
            db.prepare('DELETE FROM enrollments').run()
          }
        }
        const reservation = db.prepare('SELECT name, team, captain FROM enrollments WHERE agent = ?').get(p.author.agentId)
        const assigned = teamOf(p.author.agentId) ?? (reservation ? String(reservation.team) || undefined : p.team)
        const team = assigned === undefined ? undefined : canonicalTeam(assigned)
        const fresh = !member(p.author.agentId)
        const returning = db.prepare('SELECT agent FROM retirements WHERE agent = ?').get(p.author.agentId) != null
        if (returning) takeName(p.name, p.author.agentId)
        if (!reservation && (fresh || teamOf(p.author.agentId) !== team)) checkEnrollment(p.author.agentId, team)
        db.prepare('INSERT INTO members (agent, name, execution) VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET name = excluded.name, execution = excluded.execution').run(p.author.agentId, p.name, p.author.executionId)
        if (returning) {
          db.prepare('UPDATE members SET enrolled = 1 WHERE agent = ?').run(p.author.agentId)
          db.prepare('DELETE FROM retirements WHERE agent = ?').run(p.author.agentId)
        }
        db.prepare('INSERT INTO seat_state (agent, joined, cursor) VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET active = 1').run(p.author.agentId, latest(), latest())
        wakes.enroll(p.author.agentId, p.author.executionId)
        if (team !== undefined && teamOf(p.author.agentId) === undefined) db.prepare("INSERT INTO interests VALUES (?, 'membership', ?)").run(p.author.agentId, team)
        if (reservation?.captain === 1 && team !== undefined) appoint(team, p.author.agentId)
        succeed(p.author.agentId, team)
        db.prepare('DELETE FROM enrollments WHERE agent = ?').run(p.author.agentId)
        if (fresh && !returning) lifecycleEvent(p, p.author.agentId === 'main' ? { kind: 'launched' } : { kind: 'joined' }, p.author.agentId === 'main' ? 'Swarm launched' : 'Joined')
      })
      publish()
    },
    member,
    seats() { return closed ? [] : seats() },
    captain(team) { return closed ? undefined : seats().find(seat => seat.agent === captainId(team)) },
    assignCaptain(p, team, seat) {
      const result = transaction(() => {
        checkPrincipal(p)
        if (p.author.agentId !== 'main') return { ok: false, reason: 'Only the lead appoints a captain.' }
        const matches = seats().filter(row => row.agent !== 'main' && (row.agent === seat || row.name.toLowerCase() === seat.toLowerCase()) && row.team !== undefined && boardLabelKey(row.team) === boardLabelKey(team))
        if (matches.length !== 1) return { ok: false, reason: 'Name one enrolled seat in that team.' }
        const row = matches[0]!
        appoint(row.team!, row.agent)
        return { ok: true, name: row.name, team: row.team }
      })
      if (result.ok) publish()
      return result
    },
    assignTeam(p, seat, team) {
      const result = transaction(() => {
        checkPrincipal(p)
        if (p.author.agentId !== 'main') return { ok: false, reason: 'Only the lead assigns teams.' }
        if (!validTeam(team)) return { ok: false, reason: 'Use a team label of letters, numbers, dots, dashes or underscores; all and general are reserved.' }
        const matches = roster().filter(row => row.agent === seat || row.name === seat)
        if (matches.length !== 1) return { ok: false, reason: 'Name one enrolled seat.' }
        const row = matches[0]!
        const agent = String(row.agent), current = teamOf(agent)
        team = canonicalTeam(team)
        if (current !== team && captainId(current) === agent) return { ok: false, reason: `Name a replacement captain for ${current} before moving this seat.` }
        try { checkEnrollment(agent, team) } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
        db.prepare("DELETE FROM interests WHERE agent = ? AND kind = 'membership'").run(String(row.agent))
        db.prepare("INSERT INTO interests VALUES (?, 'membership', ?)").run(String(row.agent), team)
        return { ok: true, name: String(row.name), team }
      })
      if (result.ok) publish()
      return result
    },
    post(p, input, delivery): BoardReceipt {
      let result: BoardReceipt
      try {
        result = transaction(() => {
          if (input.kind === 'message' || input.kind === 'notice') {
            if (p.author.sessionId !== sessionId) throw new Error('This message belongs to another session.')
            db.prepare('INSERT INTO members (agent, name, execution, enrolled) VALUES (?, ?, ?, 0) ON CONFLICT(agent) DO NOTHING').run(p.author.agentId, p.name, p.author.executionId)
          } else checkPrincipal(p)
          const post = normalize(input)
          const mirrored = delivery === 'mirror' && (post.kind === 'message' || post.kind === 'notice')
          if (!['ask', 'answer', 'blocker', 'result', 'correction', 'message', 'notice'].includes(post.kind)) return { ok: false, reason: 'The board accepts questions, answers, blockers, results and corrections, not ownership or control commands.' }
          if (!post.clientOpId || post.clientOpId.length > 160) return { ok: false, reason: 'A post needs a retry key of at most 160 characters.' }
          const hash = digest(JSON.stringify(post))
          const prior = db.prepare('SELECT id, seq, digest, record FROM events WHERE author = ? AND op = ?').get(p.author.agentId, post.clientOpId)
          if (prior != null) return prior.digest === hash ? { ok: true, eventId: String(prior.id), seq: Number(prior.seq), replay: true, ...(JSON.parse(String(prior.record)).unknownMentions?.length ? { unknownMentions: JSON.parse(String(prior.record)).unknownMentions } : {}) } : { ok: false, reason: 'That retry key already names a different post.' }
          if (!post.text.trim()) return { ok: false, reason: 'A post needs text.' }
          if (post.files.length > 32 || post.refs.length > 8) return { ok: false, reason: 'A post holds at most 32 files and 8 references.' }
          if (post.files.some(file => !file || file.startsWith('/') || file.split(/[\\/]/).includes('..'))) return { ok: false, reason: 'Files must be exact paths relative to the task repository.' }
          if (post.kind === 'correction' && !post.corrects) return { ok: false, reason: 'A correction names its earlier post with corrects.' }
          const target = post.corrects ?? post.replyTo
          const reply = target === undefined ? undefined : db.prepare('SELECT record FROM events WHERE id = ?').get(target)
          if (target !== undefined && reply == null) return { ok: false, reason: 'The earlier post is not in this wave.' }
          const question = reply == null ? undefined : JSON.parse(String(reply.record)) as BoardEvent
          const ownReply = question?.author.agentId === p.author.agentId
          if (post.kind === 'answer' && question?.kind !== 'ask' && !ownReply) return { ok: false, reason: 'An answer names an ask or your own earlier post with replyTo.' }
          const thread = question?.threadId ?? post.threadId ?? randomUUID()
          if (post.threadId !== undefined && question !== undefined && post.threadId !== question.threadId) return { ok: false, reason: 'The reply belongs to the earlier post’s thread.' }
          const addressing = resolveMentions(post.mentions)
          const team = teamOf(p.author.agentId)
          if (!mirrored && addressing.unknownMentions.length > 0 && addressing.mentions.length === 0 && team === undefined && !post.mentions.some(name => name.toLowerCase() === 'main')) return { ok: false, reason: `no seat named ${addressing.unknownMentions.join(', ')} — a seat exists once Crewmate launches it` }
          const time = now()
          const own = seats().find(seat => seat.agent === p.author.agentId)
          const declared = !mirrored && own ? parseBoardWait(post, own, seats()) : null
          const eventId = randomUUID()
          const event: BoardEvent = { ...post, addresses: post.mentions, mentions: addressing.mentions, recipients: seats().filter(seat => addressing.mentions.includes(seat.agent)), ...(post.lifecycle ? { authorRole: 'system' as const } : {}), ...(addressing.unknownMentions.length ? { unknownMentions: addressing.unknownMentions } : {}), ...(team === undefined ? {} : { team }), ...(captainId(team) === p.author.agentId ? { captain: true } : {}), ...(post.taskId === undefined && question?.taskId !== undefined ? { taskId: question.taskId } : {}), schema: 1, boardId, waveId, seq: 0, eventId, author: p.author, authorName: p.name, createdAt: new Date(time).toISOString(), payloadDigest: hash, threadId: thread, policyRevision: 1 }
          appendEvent(event)
          if (mirrored) db.prepare('INSERT INTO mirror_events VALUES (?)').run(eventId)
          let reach: BoardReach | undefined
          if (delivery !== 'mirror') {
            if (declared) wakes.declare(p.author.agentId, event, declared)
            const waiting = new Set(wakes.posted(event, seats()))
            const root = db.prepare('SELECT author FROM events WHERE thread = ? ORDER BY seq LIMIT 1').get(thread)
            const replies = new Set([...(question ? [question.author.agentId] : []), ...(root ? [String(root.author)] : [])])
            const queued = new Set(wakes.pending().filter(wake => wake.eventId === eventId).map(wake => wake.agent))
            const addressed = seats().filter(seat => seat.agent !== p.author.agentId && (event.mentions.includes(seat.agent) || replies.has(seat.agent) || waiting.has(seat.agent)))
            const idle = addressed.filter(seat => seat.state === 'parked' && !queued.has(seat.agent))
            reach = { running: addressed.filter(seat => seat.state !== 'parked').map(seat => seat.name), wakes: addressed.filter(seat => queued.has(seat.agent)).map(seat => seat.name), held: idle.filter(seat => boardAddressesSeat(event, seat)).map(seat => seat.name), parked: idle.filter(seat => !boardAddressesSeat(event, seat)).length }
            const captains = new Set((post.kind === 'ask' || post.kind === 'blocker') ? seats().filter(seat => seat.captain && seat.team && (seat.team === team || event.recipients?.some(recipient => recipient.team === seat.team))).map(seat => seat.agent) : [])
            const recipients = new Set([...event.mentions, ...replies, ...waiting, ...captains, ...roster().map(row => String(row.agent))])
            recipients.delete(p.author.agentId)
            for (const recipient of recipients) {
              const named = (names: readonly string[]): boolean => post.mentions.some(name => names.includes(name.toLowerCase()))
              const captain = captainId(team) === recipient && !named(['all']) && ((post.kind === 'ask' || post.kind === 'blocker') || (['result', 'answer', 'correction'].includes(post.kind) && named([recipient.toLowerCase(), String(db.prepare('SELECT name FROM members WHERE agent = ?').get(recipient)?.name).toLowerCase()])))
              const wake = recipient === 'main' && ((post.kind === 'ask' || post.kind === 'blocker') ? named(['main', 'all']) : named(['main'])) || captain || captains.has(recipient) || waiting.has(recipient)
              const mode = wake ? 'mention-wake-body' : event.mentions.includes(recipient) ? 'mention-body' : replies.has(recipient) ? 'thread-body' : 'body'
              db.prepare('INSERT INTO deliveries (recipient, event, mode) VALUES (?, ?, ?)').run(recipient, eventId, mode)
            }
          }
          const note = reach ? boardReachNote(reach) : undefined
          return { ok: true, eventId, seq: event.seq, replay: false, ...(addressing.unknownMentions.length ? { unknownMentions: addressing.unknownMentions } : {}), ...(reach ? { reach } : {}), ...(note ? { note } : {}) }
        })
      } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
      if (result.ok && !result.replay) publish()
      return result
    },
    postOwner(p, input) {
      let result: ReturnType<BoardStore['postOwner']>
      try {
        result = transaction(() => {
          checkPrincipal(p)
          if (p.author.agentId !== 'main') return { ok: false, reason: 'Only the operator command path posts as owner.' }
          const hash = digest(JSON.stringify(input))
          const prior = db.prepare("SELECT record, digest FROM events WHERE author = 'owner' AND op = ?").get(input.clientOpId)
          if (prior) {
            if (prior.digest !== hash) return { ok: false, reason: 'That retry key already names a different post.' }
            const event = JSON.parse(String(prior.record)) as BoardEvent
            return { ok: true, eventId: event.eventId, seq: event.seq, replay: true, channel: event.channel!, recipients: event.mentions }
          }
          if (!input.clientOpId || input.clientOpId.length > 160) return { ok: false, reason: 'A post needs a retry key of at most 160 characters.' }
          if (!input.text.trim()) return { ok: false, reason: 'A post needs text.' }
          const roster = seats().filter(seat => seat.agent !== 'main')
          const target = (input.target ?? '').replace(/^@/, '')
          let recipients: BoardSeat[], channel: BoardChannel, address: string
          if (input.channel === 'general') {
            recipients = roster; channel = { kind: 'general' }; address = 'all'
          } else if (input.channel === 'team') {
            const labels = [...new Set(roster.flatMap(seat => seat.team ? [seat.team] : []))]
            const label = labels.find(label => boardLabelKey(label) === boardLabelKey(target))
            if (!label) return { ok: false, reason: 'Name one team on the board.', candidates: labels }
            const captain = captainId(label)
            recipients = roster.filter(seat => captain ? seat.agent === captain : seat.team === label)
            channel = { kind: 'team', target: label }; address = label
          } else if (input.channel === 'whisper') {
            if (['main', 'owner'].includes(target.toLowerCase())) return { ok: false, reason: 'Use the prompt line for main.' }
            recipients = roster.filter(seat => seat.agent === target || seat.name.toLowerCase() === target.toLowerCase())
            if (recipients.length !== 1) return { ok: false, reason: 'Name one enrolled crewmate.', candidates: (recipients.length ? recipients : roster).map(seat => roster.filter(other => other.name.toLowerCase() === seat.name.toLowerCase()).length > 1 ? `${seat.name} (${seat.agent})` : seat.name) }
            channel = { kind: 'whisper', target: recipients[0]!.name }; address = recipients[0]!.name
          } else return { ok: false, reason: 'Use general, team or whisper.' }
          const event: BoardEvent = { schema: 1, boardId, waveId, seq: 0, eventId: randomUUID(), author: { ...p.author, agentId: 'owner' }, authorName: 'owner', authorRole: 'owner', kind: 'ask', text: input.text, clientOpId: input.clientOpId, channel, addresses: [address, 'main'], mentions: [...new Set(['main', ...recipients.map(seat => seat.agent)])], recipients: seats().filter(seat => seat.agent === 'main' || recipients.some(recipient => recipient.agent === seat.agent)), relatedTasks: [], files: [], refs: [], createdAt: new Date(now()).toISOString(), payloadDigest: hash, threadId: randomUUID(), policyRevision: 1 }
          appendEvent(event)
          const waiting = wakes.posted(event, seats())
          for (const recipient of new Set([...event.mentions, ...waiting])) db.prepare('INSERT INTO deliveries (recipient, event, mode) VALUES (?, ?, ?)').run(recipient, event.eventId, recipient === 'main' || waiting.includes(recipient) ? 'mention-wake-body' : 'mention-body')
          return { ok: true, eventId: event.eventId, seq: event.seq, replay: false, channel, recipients: event.mentions }
        })
      } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
      if (result.ok && !result.replay) publish()
      return result
    },
    read(p, input): BoardPacket {
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
    },
    leadPosts(since) {
      return events(db.prepare("SELECT e.record FROM deliveries d JOIN events e ON e.id = d.event WHERE d.recipient = 'main' AND d.mode LIKE 'mention-%' AND e.seq > ? ORDER BY e.seq").all(since))
    },
    leadPainted() {
      const row = db.prepare("SELECT seq FROM lead_paint WHERE recipient = 'main'").get() as { seq?: number } | null
      return Number(row?.seq ?? 0)
    },
    markLeadPainted(seq) {
      if (readOnly) return
      db.prepare("INSERT INTO lead_paint (recipient, seq) VALUES ('main', ?) ON CONFLICT(recipient) DO UPDATE SET seq = MAX(seq, excluded.seq)").run(seq)
    },
    leadMention() {
      return leadPending('ASC')
    },
    leadMentionNewest() {
      return leadPending('DESC')
    },
    boundary(p, seen) {
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
    },
    presented(p, ids, requestId, packets = []) {
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
    },
    view(before, thread, team) { return snapshot(before, thread, team) },
    subscribe(listener) {
      if (closed) throw new Error('The board is closed.')
      listeners.add(listener)
      if (listeners.size === 1) {
        observed = version()
        let feed = feeds.get(feedKey)
        if (!feed) { feed = new Set(); feeds.set(feedKey, feed) }
        feed.add(emit)
        watcher = watch(resolveWatchRoot(dirname(path)), { persistent: false }, (_event, file) => {
          if (file === null || [basename(path), `${basename(path)}-wal`].includes(String(file)) || (String(file).startsWith(`${basename(path)}.`) && String(file).endsWith('.notify'))) emit()
        })
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { watcher?.close(); watcher = undefined; feeds.get(feedKey)?.delete(emit); if (!feeds.get(feedKey)?.size) feeds.delete(feedKey) }
      }
    },
    close() { if (closed) return; closed = true; watcher?.close(); listeners.clear(); feeds.get(feedKey)?.delete(emit); if (!feeds.get(feedKey)?.size) feeds.delete(feedKey); db.close() },
  }
  return store
}
