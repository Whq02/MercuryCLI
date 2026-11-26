import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, resolve, toNamespacedPath } from 'node:path'
import { createRequire } from 'node:module'
import { SEAT_NAME_REFUSAL, boardSeatName, boardLabelKey, type BoardEvent, type BoardPacket, type BoardPrincipal, type BoardReceipt, type BoardSeat, type BoardStore, type BoardViewSnapshot } from './contracts.js'
import { CHAT_OFF, type BoardChat } from './party.js'
import type { CrewChatLifecycle } from '../../engine/message-shapes/message.js'
import { sleep } from '../../platform/async/sleep.js'
import { resolveWatchRoot } from '../../platform/processes/watchRoot.js'
import { createWakeState } from './wakeState.js'
import { digest, normalize, validTeam } from './store/shared.js'
import type { Database, StoreContext } from './store/context.js'
import { settle, complete, resumeAdmitted, claimWake, wakePacket, admitWake, holdWake } from './store/wakes.js'
import { reserveEnrollment, cancelEnrollment, enroll, assignCaptain, assignTeam } from './store/enrollment.js'
import { post, postOwner } from './store/posting.js'
import { read, leadPosts, leadPainted, markLeadPainted, boundary, presented } from './store/reading.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const requireRuntime = createRequire(import.meta.url)
const feeds = new Map<string, Set<() => void>>()
const BOARD_WAKE_FLOOR_MS = 2000
const watchBoard = (path: string, emit: () => void): (() => void) => {
  const watcher = watch(resolveWatchRoot(dirname(path)), { persistent: false }, (_event, file) => {
    if (file === null || [basename(path), `${basename(path)}-wal`].includes(String(file)) || (String(file).startsWith(`${basename(path)}.`) && String(file).endsWith('.notify'))) emit()
  })
  const floor = new AbortController()
  void (async () => { while (!floor.signal.aborted) { await sleep(BOARD_WAKE_FLOOR_MS, floor.signal, { unref: true }); if (!floor.signal.aborted) emit() } })()
  return () => { watcher.close(); floor.abort() }
}

const WINDOWS_MAX_PATH = 260
const SQLITE_JOURNAL_SUFFIX = '-journal'
const asSqliteOpens = (path: string): string => (path.length + SQLITE_JOURNAL_SUFFIX.length < WINDOWS_MAX_PATH ? path : toNamespacedPath(path))

export function open(path: string, sessionId: string, now: () => number = Date.now, readOnly = false, live: (agent: string) => boolean = () => true): BoardStore {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const sqlite = requireRuntime(process.versions.bun ? 'bun:sqlite' : 'node:sqlite')
  const file = asSqliteOpens(path)
  const db: Database = process.versions.bun
    ? readOnly ? new sqlite.Database(file, { readonly: true }) : new sqlite.Database(file)
    : new sqlite.DatabaseSync(file, { readOnly })
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
  let unwatch: (() => void) | undefined
  let closed = false
  const version = (): string => JSON.stringify([db.prepare('SELECT MAX(seq) AS seq FROM events').get()!.seq, db.prepare("SELECT agent, value FROM interests WHERE kind = 'membership' ORDER BY agent").all(), hasCaptains ? db.prepare('SELECT team, agent FROM captains ORDER BY team').all() : [], wakes.version(), db.prepare('SELECT agent FROM members WHERE enrolled = 1 ORDER BY agent').all()])
  let observed = version()
  const emit = (): void => {
    if (closed) return
    let next: string
    try { next = version() } catch (error) { passedOver(error); return }
    if (observed === next) return
    observed = next
    for (const listener of listeners) { try { listener() } catch (error) { passedOver(error) } }
  }
  const publish = (): void => {
    const signal = `${path}.${randomUUID()}.notify`
    try { writeFileSync(signal, '', { mode: 0o600 }); renameSync(signal, `${path}.notify`) } catch { try { rmSync(signal, { force: true }) } catch (error) { passedOver(error) } }
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
  const reserveCount = (team: string, agent: string): number => new Set(db.prepare("SELECT agent, value FROM interests JOIN members USING (agent) WHERE kind = 'membership' AND enrolled = 1 UNION ALL SELECT agent, team AS value FROM enrollments WHERE captain = 0").all().filter(row => row.agent !== agent && row.agent !== 'main' && boardLabelKey(String(row.value)) === boardLabelKey(team)).map(row => String(row.agent))).size
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
    const running = (): Error => Object.assign(new Error(`A seat named ${name} is running on this board; stop it, or launch this one under another name.`), { code: SEAT_NAME_REFUSAL })
    const launching = db.prepare('SELECT agent, name FROM enrollments').all().filter(row => row.agent !== agent && carries(row.name)).map(row => String(row.agent))
    if (launching.some(live)) throw running()
    for (const stopped of launching) {
      reinstate('?', stopped)
      db.prepare('DELETE FROM enrollments WHERE agent = ?').run(stopped)
      db.prepare('INSERT INTO retirements VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET successor = excluded.successor').run(stopped, agent)
    }
    const holders = roster().filter(row => row.agent !== 'main' && row.agent !== agent && carries(row.name)).map(row => String(row.agent))
    if (holders.some(holder => wakes.state(holder) === 'running' && live(holder))) throw running()
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
    settle(p) { settle(ctx, p) },
    complete(p, outcome) { return complete(ctx, p, outcome) },
    resumeAdmitted(p) { resumeAdmitted(ctx, p) },
    pendingWakes() { return wakes.pending().filter(wake => member(wake.agent)) },
    claimWake(p, wake) { return claimWake(ctx, p, wake) },
    wakePacket(p, claim) { return wakePacket(ctx, p, claim) },
    admitWake(p, claim) { admitWake(ctx, p, claim) },
    holdWake(p, claim, reason, problem) { return holdWake(ctx, p, claim, reason, problem) },
    reserveEnrollment(p, seat) { reserveEnrollment(ctx, p, seat) },
    cancelEnrollment(p, agent) { cancelEnrollment(ctx, p, agent) },
    enroll(p) { enroll(ctx, p) },
    member,
    seats() { return closed ? [] : seats() },
    captain(team) { return closed ? undefined : seats().find(seat => seat.agent === captainId(team)) },
    assignCaptain(p, team, seat) { return assignCaptain(ctx, p, team, seat) },
    assignTeam(p, seat, team) { return assignTeam(ctx, p, seat, team) },
    post(p, input, delivery): BoardReceipt { return post(ctx, p, input, delivery) },
    postOwner(p, input) { return postOwner(ctx, p, input) },
    read(p, input): BoardPacket { return read(ctx, p, input) },
    leadPosts(since) { return leadPosts(ctx, since) },
    leadPainted() { return leadPainted(ctx) },
    markLeadPainted(seq) { markLeadPainted(ctx, seq) },
    leadMention() {
      return leadPending('ASC')
    },
    leadMentionNewest() {
      return leadPending('DESC')
    },
    boundary(p, seen) { return boundary(ctx, p, seen) },
    presented(p, ids, requestId, packets = []) { presented(ctx, p, ids, requestId, packets) },
    view(before, thread, team) { return snapshot(before, thread, team) },
    subscribe(listener) {
      if (closed) throw new Error('The board is closed.')
      listeners.add(listener)
      if (listeners.size === 1) {
        observed = version()
        let feed = feeds.get(feedKey)
        if (!feed) { feed = new Set(); feeds.set(feedKey, feed) }
        feed.add(emit)
        unwatch = watchBoard(path, emit)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { unwatch?.(); unwatch = undefined; feeds.get(feedKey)?.delete(emit); if (!feeds.get(feedKey)?.size) feeds.delete(feedKey) }
      }
    },
    close() { if (closed) return; closed = true; unwatch?.(); listeners.clear(); feeds.get(feedKey)?.delete(emit); if (!feeds.get(feedKey)?.size) feeds.delete(feedKey); db.close() },
  }
  const ctx: StoreContext = { transaction, checkPrincipal, db, wakes, latest, publish, seats, member, store, sessionId, notice, appoint, canonicalTeam, takeName, checkEnrollment, reinstate, teamOf, succeed, lifecycleEvent, roster, captainId, events, resolveMentions, now, boardId, waveId, appendEvent, eventLabels, readOnly, packetText, markSeen, advance }
  return store
}
