import { randomUUID } from 'node:crypto'
import { boardLabelKey, type BoardEvent, type BoardSeat } from './contracts.js'
import { boardNamesSeat, boardWaitWords, matchesBoardWait, type BoardWait, type BoardWaitPredicate } from './waits.js'

type Database = {
  exec(sql: string): unknown
  prepare(sql: string): { all(...values: (string | number)[]): Record<string, unknown>[]; get(...values: (string | number)[]): Record<string, unknown> | null | undefined; run(...values: (string | number)[]): unknown }
}
type WakeSeat = BoardSeat & { captain?: true }
export type BoardSettlement = 'completed' | 'failed' | 'stopped' | 'paused'
export type BoardWakeProblem = { kind: 'worktree-missing'; path: string }
export type BoardWake = { agent: string; eventId: string; seq: number; version: number }
export type BoardWakeClaim = BoardWake & { id: string }

export function createWakeState(db: Database, readOnly: boolean) {
  if (!readOnly) db.exec(`
    CREATE TABLE IF NOT EXISTS wake_seats (agent TEXT PRIMARY KEY, execution TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT NOT NULL, parked_seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wake_waits (agent TEXT PRIMARY KEY, event TEXT NOT NULL, seq INTEGER NOT NULL, version INTEGER NOT NULL, predicate TEXT NOT NULL, standing INTEGER NOT NULL, armed INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wake_events (agent TEXT NOT NULL, event TEXT NOT NULL, seq INTEGER NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(agent, event));
    CREATE TABLE IF NOT EXISTS wake_claims (agent TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, event TEXT NOT NULL, seq INTEGER NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wake_problems (agent TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wake_dispatches (id TEXT PRIMARY KEY, agent TEXT NOT NULL, event TEXT NOT NULL);`)
  const hasProblems = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wake_problems'").get() != null
  const exists = (): boolean => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wake_seats'").get() != null
  const wait = (agent: string): BoardWait | undefined => {
    if (!exists()) return undefined
    const row = db.prepare('SELECT * FROM wake_waits WHERE agent = ? AND armed = 1').get(agent)
    return row ? { eventId: String(row.event), seq: Number(row.seq), version: Number(row.version), predicate: JSON.parse(String(row.predicate)) as BoardWaitPredicate, standing: row.standing === 1 } : undefined
  }
  const arm = (agent: string, eventId: string, seq: number, predicate: BoardWaitPredicate, standing: boolean): void => {
    db.prepare('INSERT INTO wake_waits VALUES (?, ?, ?, 1, ?, ?, 1) ON CONFLICT(agent) DO UPDATE SET event = excluded.event, seq = excluded.seq, version = version + 1, predicate = excluded.predicate, standing = excluded.standing, armed = 1').run(agent, eventId, seq, JSON.stringify(predicate), standing ? 1 : 0)
    db.prepare('DELETE FROM wake_events WHERE agent = ? AND version != 0').run(agent)
  }
  const consume = (agent: string, version: number): void => {
    if (version === 0) return
    db.prepare('UPDATE wake_waits SET armed = 0 WHERE agent = ? AND version = ?').run(agent, version)
    db.prepare('DELETE FROM wake_events WHERE agent = ? AND version = ?').run(agent, version)
  }
  const state = (agent: string): 'running' | 'parked' => exists() && db.prepare('SELECT state FROM wake_seats WHERE agent = ?').get(agent)?.state === 'parked' ? 'parked' : 'running'
  const candidate = (row: Record<string, unknown>): BoardWake => ({ agent: String(row.agent), eventId: String(row.event), seq: Number(row.seq), version: Number(row.version) })
  const pending = (): BoardWake[] => exists() ? db.prepare("SELECT e.* FROM wake_events e JOIN wake_seats s USING (agent) WHERE s.state = 'parked' AND s.outcome IN ('completed', 'failed') AND NOT EXISTS (SELECT 1 FROM wake_claims c WHERE c.agent = e.agent) AND NOT EXISTS (SELECT 1 FROM seen_events v WHERE v.agent = e.agent AND v.event = e.event) AND (e.version = 0 OR EXISTS (SELECT 1 FROM wake_waits w WHERE w.agent = e.agent AND w.version = e.version AND w.armed = 1)) ORDER BY e.seq").all().map(candidate) : []
  return {
    wait,
    state,
    problem(agent: string): BoardWakeProblem | undefined {
      const row = hasProblems ? db.prepare('SELECT record FROM wake_problems WHERE agent = ?').get(agent) : undefined
      return row ? JSON.parse(String(row.record)) as BoardWakeProblem : undefined
    },
    version(): unknown {
      return exists() ? [db.prepare('SELECT * FROM wake_seats ORDER BY agent').all(), db.prepare('SELECT * FROM wake_waits ORDER BY agent').all(), db.prepare('SELECT * FROM wake_claims ORDER BY agent').all(), hasProblems ? db.prepare('SELECT * FROM wake_problems ORDER BY agent').all() : []] : []
    },
    enroll(agent: string, execution: string): void {
      const prior = db.prepare('SELECT execution FROM wake_seats WHERE agent = ?').get(agent)
      if (prior?.execution === execution) return
      db.prepare("INSERT INTO wake_seats VALUES (?, ?, 'running', '', 0) ON CONFLICT(agent) DO UPDATE SET execution = excluded.execution, state = 'running', outcome = ''").run(agent, execution)
    },
    admit(agent: string): void {
      db.prepare("DELETE FROM wake_claims WHERE agent = ? AND state = 'held'").run(agent)
      db.prepare('DELETE FROM wake_problems WHERE agent = ?').run(agent)
    },
    retire(agent: string, successor: string): void {
      db.prepare('DELETE FROM wake_events WHERE agent = ?').run(agent)
      db.prepare('DELETE FROM wake_claims WHERE agent = ?').run(agent)
      db.prepare('UPDATE wake_waits SET armed = 0 WHERE agent = ?').run(agent)
      db.prepare("UPDATE wake_waits SET predicate = json_set(predicate, '$.agent', ?) WHERE json_extract(predicate, '$.kind') = 'seat' AND json_extract(predicate, '$.agent') = ?").run(successor, agent)
    },
    settle(agent: string, execution: string, seq: number): void {
      db.prepare("UPDATE wake_seats SET state = 'parked', parked_seq = ? WHERE agent = ? AND execution = ? AND state = 'running'").run(seq, agent, execution)
    },
    complete(seat: WakeSeat, execution: string, seq: number, outcome: BoardSettlement): boolean {
      const prior = db.prepare('SELECT execution, outcome FROM wake_seats WHERE agent = ?').get(seat.agent)
      if (prior?.execution !== execution || prior.outcome !== '') return false
      db.prepare("UPDATE wake_seats SET state = 'parked', outcome = ?, parked_seq = ? WHERE agent = ?").run(outcome, seq, seat.agent)
      const current = wait(seat.agent)
      if (seat.captain && seat.team && (!current || current.standing)) arm(seat.agent, `standing:${execution}`, seq, { kind: 'team', team: seat.team }, true)
      return true
    },
    declare(agent: string, event: BoardEvent, predicate: BoardWaitPredicate): void {
      arm(agent, event.eventId, event.seq, predicate, false)
    },
    captains(seats: readonly WakeSeat[], seq: number): void {
      for (const seat of seats) {
        const current = wait(seat.agent)
        if (current?.standing && (!seat.captain || boardLabelKey(seat.team ?? '') !== (current.predicate.kind === 'team' ? boardLabelKey(current.predicate.team) : undefined))) {
          consume(seat.agent, current.version)
        }
        if (seat.captain && seat.team && !wait(seat.agent)) arm(seat.agent, `captain:${seat.agent}:${seq}`, seq, { kind: 'team', team: seat.team }, true)
      }
    },
    posted(event: BoardEvent, seats: readonly WakeSeat[]): string[] {
      const recipients: string[] = []
      for (const seat of seats) {
        const current = wait(seat.agent)
        const matches = current !== undefined && (!current.standing || state(seat.agent) === 'parked') && matchesBoardWait(event, current, seat.agent)
        const named = state(seat.agent) === 'parked' && boardNamesSeat(event, seat)
        if (!matches && !named) continue
        db.prepare('INSERT OR IGNORE INTO wake_events VALUES (?, ?, ?, ?)').run(seat.agent, event.eventId, event.seq, matches ? current!.version : 0)
        recipients.push(seat.agent)
      }
      return recipients
    },
    presented(agent: string, ids: readonly string[]): void {
      for (const id of ids) {
        const event = db.prepare('SELECT version FROM wake_events WHERE agent = ? AND event = ?').get(agent, id)
        if (event) consume(agent, Number(event.version))
        db.prepare('DELETE FROM wake_events WHERE agent = ? AND event = ?').run(agent, id)
      }
      const claim = db.prepare('SELECT event FROM wake_claims WHERE agent = ?').get(agent)
      if (claim && ids.includes(String(claim.event))) db.prepare('DELETE FROM wake_claims WHERE agent = ?').run(agent)
    },
    pending,
    holds(claim: BoardWakeClaim): boolean {
      return db.prepare('SELECT id FROM wake_claims WHERE agent = ?').get(claim.agent)?.id === claim.id
    },
    claim(wake: BoardWake): BoardWakeClaim | null {
      const current = pending().find(candidate => candidate.agent === wake.agent)
      if (!current || current.eventId !== wake.eventId || current.version !== wake.version) return null
      const id = randomUUID()
      db.prepare("INSERT INTO wake_claims VALUES (?, ?, ?, ?, ?, 'reserved', '')").run(wake.agent, id, wake.eventId, wake.seq, wake.version)
      return { ...wake, id }
    },
    hold(claim: BoardWakeClaim, error: string, problem?: BoardWakeProblem): void {
      db.prepare("UPDATE wake_claims SET state = 'held', error = ? WHERE agent = ? AND id = ?").run(error, claim.agent, claim.id)
      if (problem) db.prepare('INSERT INTO wake_problems VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET record = excluded.record').run(claim.agent, JSON.stringify(problem))
    },
    open(seats: readonly WakeSeat[]): { seat: string; event: string }[] {
      return seats.flatMap(seat => {
        const current = wait(seat.agent)
        return current ? [{ seat: seat.name, event: boardWaitWords(current.predicate) }] : []
      })
    },
    admitted(claim: BoardWakeClaim): void {
      const current = db.prepare('SELECT id FROM wake_claims WHERE agent = ?').get(claim.agent)
      if (current?.id !== claim.id) return
      db.prepare('INSERT OR IGNORE INTO wake_dispatches VALUES (?, ?, ?)').run(claim.id, claim.agent, claim.eventId)
      db.prepare("UPDATE wake_claims SET state = 'admitted' WHERE agent = ? AND id = ?").run(claim.agent, claim.id)
      consume(claim.agent, claim.version)
    },
    turns(): number {
      return exists() ? Number(db.prepare('SELECT COUNT(*) AS n FROM wake_dispatches').get()!.n) : 0
    },
  }
}
