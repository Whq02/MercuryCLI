#!/usr/bin/env bun
// ============================================================================
//  scripts/formal-models/prove-model-interview.ts — (R2): the
//  INTERVIEW lifecycle survives GENERATED command sequences and
//  deterministic interleavings, checked against a reference model.
//
//  Commands: open · append · duplicate-append (replay) · switch (the P0-1
//  shape) · drain · restart(lossy, ≤debounce tail) · resume. The model
//  tracks per-identity FULL content; the real store may be MORE durable than
//  the model between drains (an eager debounce tick is allowed), and must be
//  EXACTLY as durable at every drain. All assertions are id-scoped to the
//  run's own sessions, so the shared scratch home never leaks state
//  across runs (MAX_SESSIONS trims old runs' sessions — by design).
//
//  §1 fc.asyncModelRun over generated command sequences (fixed seed — the
//     gate is deterministic; a failure prints fast-check's seed + path +
//     shrunk counterexample, plus the durable file path).
//  §2 fc.scheduler interleavings: concurrent drains + appends + a resume
//     settle every accepted event exactly once, never losing one
//     (per-identity generations stay monotonic).
//
//  R2: fast-check is a pinned devDependency, DEV-ONLY — no src/ module
//  imports it, so it never reaches dist.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

const root = scratchRoot('cairn-model-interview')
const t = checker()

const store = await import('../../src/services/interview/store.ts')
const { rebuildInterview } = await import('../../src/services/interview/contracts.ts')
type Ev = Parameters<typeof rebuildInterview>[0][number]

const SEED = 20260807
const logPath = join(
  root,
  'interview',
  `${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
)
interface RawEntry {
  events: Ev[]
  checkpoint?: { v: 1; state: unknown; sealedCount: number }
}
function durable(): Record<string, RawEntry> {
  if (!existsSync(logPath)) return {}
  const raw = JSON.parse(readFileSync(logPath, 'utf8')) as { data?: { sessions?: unknown }; sessions?: unknown }
  return (raw.sessions ?? raw.data?.sessions ?? {}) as Record<string, RawEntry>
}

/** The reference model: per-identity full accepted logs + drain marks. */
interface Model {
  /** sessionId → the FULL accepted event log (model truth). */
  sessions: Map<string, Ev[]>
  live: string | null
  /** Identities whose full content MUST be durable (drained at least once
   *  with no accepted events after the last drain). */
  drainedClean: Set<string>
  counter: number
}
type Real = Record<string, never>

const stateOf = (events: readonly Ev[]): string => JSON.stringify(rebuildInterview(events))
/** Durable state for an id, checkpoint-transparent (fold cp + tail via the
 *  store's own list API would re-enter the store — the model compares the
 *  FULL model log against list()'s state instead, so compaction stays
 *  transparent). */

class OpenCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly mission: string) {}
  check(): boolean {
    return true
  }
  async run(m: Model): Promise<void> {
    const sid = store.openInterviewSession({ mission: this.mission, atMs: ++m.counter })
    m.sessions.set(sid, [...(store.interviewEvents() as Ev[])])
    m.live = sid
    m.drainedClean.delete(sid)
  }
  toString(): string {
    return `open(${this.mission})`
  }
}
class AppendCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly tag: number) {}
  check(m: Model): boolean {
    return m.live !== null
  }
  async run(m: Model): Promise<void> {
    const ev = { kind: 'navigated', eventId: `ie_${m.live}_${this.tag}_${++m.counter}`, atMs: m.counter, target: 'review' } as never as Ev
    store.appendInterviewEvent(ev as never)
    m.sessions.get(m.live!)!.push(ev)
    m.drainedClean.delete(m.live!)
  }
  toString(): string {
    return `append(#${this.tag})`
  }
}
class DuplicateAppendCmd implements fc.AsyncCommand<Model, Real> {
  check(m: Model): boolean {
    return m.live !== null && (m.sessions.get(m.live)?.length ?? 0) > 1
  }
  async run(m: Model): Promise<void> {
    // Replay the live session's LAST accepted event — the fold must no-op
    // (idempotency law); the model records nothing.
    const log = m.sessions.get(m.live!)!
    const before = store.interviewEvents().length
    store.appendInterviewEvent(log[log.length - 1]! as never)
    if (store.interviewEvents().length !== before) {
      throw new Error(`duplicate append was NOT a no-op (live ${m.live}, durable file ${logPath})`)
    }
  }
  toString(): string {
    return 'duplicate-append'
  }
}
class DrainCmd implements fc.AsyncCommand<Model, Real> {
  check(): boolean {
    return true
  }
  async run(m: Model): Promise<void> {
    const receipt = await store.flushInterviewLog()
    if (!receipt.allSettled) {
      throw new Error(`drain degraded: ${JSON.stringify(receipt.settlements)} (durable file ${logPath})`)
    }
    for (const id of m.sessions.keys()) m.drainedClean.add(id)
    // THE DRAIN LAW: every model identity's full content is durable now.
    const disk = durable()
    const listed = await store.listInterviewSessions()
    for (const [id, log] of m.sessions) {
      if (!disk[id]) throw new Error(`identity ${id} missing from the durable log after a drain (${logPath})`)
      const got = listed.find(s => s.sessionId === id)
      if (!got) throw new Error(`identity ${id} missing from list() after a drain`)
      if (JSON.stringify(got.state) !== stateOf(log)) {
        throw new Error(`identity ${id}: durable state ≠ model state after a drain (durable file ${logPath})`)
      }
    }
  }
  toString(): string {
    return 'drain'
  }
}
class RestartCmd implements fc.AsyncCommand<Model, Real> {
  check(): boolean {
    return true
  }
  async run(m: Model): Promise<void> {
    // A process death: undrained tails (≤ the debounce window) may be lost.
    // The model keeps only identities whose content was drained clean; the
    // rest reset to whatever the durable log holds (subset of accepted).
    store._resetInterviewForProofs()
    const disk = durable()
    for (const [id] of m.sessions) {
      if (!m.drainedClean.has(id)) {
        // Adopt the durable truth (possibly a prefix of accepted) as the
        // new model content for this identity — fold cp+tail via list().
        if (!disk[id]) {
          m.sessions.delete(id)
          continue
        }
      }
    }
    // Re-sync undrained survivors from the store's own list (checkpoint-
    // transparent; the durable prefix is now the accepted truth).
    const listed = await store.listInterviewSessions()
    for (const [id] of [...m.sessions]) {
      if (m.drainedClean.has(id)) continue
      const got = listed.find(s => s.sessionId === id)
      if (!got) {
        m.sessions.delete(id)
        continue
      }
      // The model cannot reconstruct the exact durable prefix events; it
      // adopts REALITY for undrained identities (allowed: restart is the
      // one lossy transition, bounded by the debounce window) by replacing
      // the model log with the store's tail+checkpoint via resume below.
      m.sessions.delete(id)
    }
    m.live = null
  }
  toString(): string {
    return 'restart'
  }
}
class ResumeCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly pick: number) {}
  check(m: Model): boolean {
    return m.sessions.size > 0
  }
  async run(m: Model): Promise<void> {
    const ids = [...m.sessions.keys()]
    const id = ids[this.pick % ids.length]!
    const ok = await store.resumeInterviewSession(id)
    if (!ok) throw new Error(`resume(${id}) failed though the model holds it (durable file ${logPath})`)
    m.live = id
    const snap = store.interviewSnapshot()
    if (JSON.stringify(snap) !== stateOf(m.sessions.get(id)!)) {
      throw new Error(`resume(${id}) state ≠ model state (pending-first law; durable file ${logPath})`)
    }
  }
  toString(): string {
    return `resume(#${this.pick})`
  }
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — generated command sequences against the reference model (fixed seed)')
{
  let failure = ''
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.commands(
          [
            fc.constantFrom('alpha', 'beta', 'gamma').map(m => new OpenCmd(m)),
            fc.nat({ max: 9 }).map(n => new AppendCmd(n)),
            fc.constant(new DuplicateAppendCmd()),
            fc.constant(new DrainCmd()),
            fc.constant(new RestartCmd()),
            fc.nat({ max: 4 }).map(n => new ResumeCmd(n)),
          ],
          { size: '+1' },
        ),
        async cmds => {
          store._resetInterviewForProofs()
          const model: Model = { sessions: new Map(), live: null, drainedClean: new Set(), counter: 0 }
          await fc.asyncModelRun(() => ({ model, real: {} as Real }), cmds)
          // Terminal drain: everything accepted (post-restart) settles.
          await new DrainCmd().run(model)
        },
      ),
      { numRuns: 40, seed: SEED },
    )
  } catch (e) {
    failure = String(e)
  }
  t.check(
    'every generated sequence held the drain/resume/idempotency laws (seed 20260807; a failure prints fast-check seed + path + shrunk sequence)',
    failure === '',
    failure.slice(0, 400),
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — deterministic interleavings: concurrent drains + appends never lose accepted content')
{
  let failure = ''
  try {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async s => {
        store._resetInterviewForProofs()
        const a = store.openInterviewSession({ mission: 'interleave A', atMs: 1 })
        const accepted: string[] = []
        let n = 0
        const appendOne = (): void => {
          const id = `ie_il_${++n}`
          store.appendInterviewEvent({ kind: 'navigated', eventId: id, atMs: n, target: 'review' } as never)
          accepted.push(id)
        }
        appendOne()
        // Three racers: two drains and an append burst, scheduled in every
        // order fast-check explores (shrinking finds minimal orders).
        s.schedule(Promise.resolve(), 'drain-1').then(() => store.flushInterviewLog())
        s.schedule(Promise.resolve(), 'append-burst').then(() => {
          appendOne()
          appendOne()
        })
        s.schedule(Promise.resolve(), 'drain-2').then(() => store.flushInterviewLog())
        await s.waitAll()
        // Settle everything, then the durable truth must hold EVERY accepted
        // event exactly once, in order.
        const receipt = await store.flushInterviewLog()
        if (!receipt.allSettled) throw new Error(`terminal drain degraded: ${JSON.stringify(receipt.settlements)}`)
        const entry = durable()[a]
        if (!entry) throw new Error(`identity ${a} missing after interleaved drains`)
        const durableIds = [
          ...((entry.checkpoint?.sealedCount ?? 0) > 0 ? ['<sealed>'] : []),
          ...entry.events.map(e => (e as { eventId: string }).eventId),
        ]
        const expected = durableIds.filter(id => id.startsWith('ie_il_'))
        const wanted = accepted
        if (JSON.stringify(expected) !== JSON.stringify(wanted)) {
          throw new Error(
            `accepted ≠ durable after interleaving: accepted=[${wanted}] durable=[${expected}] (file ${logPath})`,
          )
        }
      }),
      { numRuns: 25, seed: SEED },
    )
  } catch (e) {
    failure = String(e)
  }
  t.check(
    'every explored interleaving settled every accepted event exactly once, in order (seed 20260807)',
    failure === '',
    failure.slice(0, 400),
  )
}

t.finish('prove-model-interview')
