import { boardLabelKey, type BoardPrincipal, type BoardSeat } from '../contracts.js'
import { validTeam } from './shared.js'
import type { StoreContext } from './context.js'

export function reserveEnrollment(ctx: StoreContext, p: BoardPrincipal, seat: Omit<BoardSeat, 'captain'> & { captain?: boolean; named?: boolean }): void {
  const { transaction, checkPrincipal, member, canonicalTeam, takeName, checkEnrollment, db, publish } = ctx
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
}

export function cancelEnrollment(ctx: StoreContext, p: BoardPrincipal, agent: string): void {
  const { transaction, checkPrincipal, reinstate, db, publish } = ctx
  const back = transaction(() => {
    checkPrincipal(p)
    if (p.author.agentId !== 'main') throw new Error('Only the lead cancels a launch.')
    const reinstated = reinstate('SELECT agent FROM enrollments WHERE agent = ?', agent)
    db.prepare('DELETE FROM enrollments WHERE agent = ?').run(agent)
    return reinstated
  })
  if (back) publish()
}

export function enroll(ctx: StoreContext, p: BoardPrincipal): void {
  const { sessionId, transaction, db, reinstate, teamOf, canonicalTeam, member, takeName, checkEnrollment, latest, wakes, appoint, succeed, lifecycleEvent, publish } = ctx
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
    if (fresh || teamOf(p.author.agentId) !== team) checkEnrollment(p.author.agentId, team, reservation?.captain === 1)
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
}

export function assignCaptain(ctx: StoreContext, p: BoardPrincipal, team: string, seat: string): { ok: boolean; reason?: string; name?: string; team?: string } {
  const { transaction, checkPrincipal, seats, appoint, publish } = ctx
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
}

export function assignTeam(ctx: StoreContext, p: BoardPrincipal, seat: string, team: string): { ok: boolean; reason?: string; name?: string; team?: string } {
  const { transaction, checkPrincipal, roster, teamOf, canonicalTeam, captainId, checkEnrollment, db, publish } = ctx
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
}
