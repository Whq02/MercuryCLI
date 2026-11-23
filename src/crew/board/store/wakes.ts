import { type BoardPrincipal } from '../contracts.js'
import type { CrewChatLifecycle } from '../../../engine/message-shapes/message.js'
import { boardWaitWords } from '../waits.js'
import type { BoardSettlement, BoardWake, BoardWakeClaim, BoardWakeProblem } from '../wakeState.js'
import type { StoreContext } from './context.js'

export function settle(ctx: StoreContext, p: BoardPrincipal): void {
  const { transaction, checkPrincipal, db, wakes, latest, publish } = ctx
  transaction(() => {
    checkPrincipal(p)
    db.prepare('UPDATE seat_state SET active = 0 WHERE agent = ?').run(p.author.agentId)
    wakes.settle(p.author.agentId, p.author.executionId, latest())
  })
  publish()
}

export function complete(ctx: StoreContext, p: BoardPrincipal, outcome: BoardSettlement): CrewChatLifecycle | undefined {
  const { transaction, checkPrincipal, seats, wakes, latest, db, publish } = ctx
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
}

export function resumeAdmitted(ctx: StoreContext, p: BoardPrincipal): void {
  const { transaction, checkPrincipal, wakes, publish } = ctx
  transaction(() => { checkPrincipal(p); wakes.admit(p.author.agentId) })
  publish()
}

export function claimWake(ctx: StoreContext, p: BoardPrincipal, wake: BoardWake): BoardWakeClaim | null {
  const { transaction, checkPrincipal, wakes, member, publish } = ctx
  const claim = transaction(() => {
    checkPrincipal(p)
    if (p.author.agentId !== 'main') throw new Error('Only the lead runner dispatches board wakes.')
    return member(wake.agent) ? wakes.claim(wake) : null
  })
  if (claim) publish()
  return claim
}

export function wakePacket(ctx: StoreContext, p: BoardPrincipal, claim: BoardWakeClaim): { text: string; eventIds: string[] } | null {
  const { checkPrincipal, wakes, db, store, sessionId } = ctx
  checkPrincipal(p)
  if (p.author.agentId !== 'main' || !wakes.holds(claim)) return null
  const member = db.prepare('SELECT name, execution FROM members WHERE agent = ? AND enrolled = 1').get(claim.agent)
  if (!member) return null
  return store.boundary({ author: { sessionId, agentId: claim.agent, executionId: String(member.execution) }, name: String(member.name) }, new Set())
}

export function admitWake(ctx: StoreContext, p: BoardPrincipal, claim: BoardWakeClaim): void {
  const { transaction, checkPrincipal, wakes, publish } = ctx
  transaction(() => {
    checkPrincipal(p)
    if (p.author.agentId !== 'main') throw new Error('Only the lead runner dispatches board wakes.')
    wakes.admitted(claim)
  })
  publish()
}

export function holdWake(ctx: StoreContext, p: BoardPrincipal, claim: BoardWakeClaim, reason: string, problem?: BoardWakeProblem): boolean {
  const { transaction, checkPrincipal, wakes, notice, publish } = ctx
  const held = transaction(() => {
    checkPrincipal(p)
    if (p.author.agentId !== 'main' || !wakes.holds(claim)) return false
    wakes.hold(claim, reason, problem)
    notice(claim.agent, `wake:${claim.id}`, `The board resume did not start: ${reason} The lead can use ResumeCrewmate.`)
    return true
  })
  if (held) publish()
  return held
}
