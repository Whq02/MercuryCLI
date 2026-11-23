#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'interview-bounds-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')

const { checker } = await import('../engine-durability/harness.ts')
const { commitAnswer, draftAnswer, presentToolCall, setNote } = await import(
  '../../src/tools/engines/interview/controller.ts'
)
const {
  adoptDurableSessionSync,
  flushInterviewLog,
  interviewSnapshot,
  _resetInterviewForProofs,
} = await import('../../src/tools/engines/interview/store.ts')
const { rebuildInterview } = await import('../../src/tools/engines/interview/contracts.ts')
const { readFileSync } = await import('node:fs')

const baseChecker = checker()
const t = {
  ...baseChecker,
  check: (label: string, cond: boolean, detail = '', hint = ''): void =>
    baseChecker.check(label, cond, cond ? detail : [detail, hint].filter(Boolean).join(' — ')),
}

const INPUT = {
  questions: [
    {
      question: 'Which storage engine should the cache use?',
      header: 'Cache',
      options: [
        { label: 'Redis', description: 'Shared.' },
        { label: 'In-memory', description: 'Local.' },
      ],
    },
  ],
}

async function seedSession(toolUseId: string, n: number): Promise<{ qid: string; optA: string; optB: string }> {
  _resetInterviewForProofs()
  const { questions } = presentToolCall({ input: INPUT, toolUseId })
  const q = questions[0]!
  for (let i = 0; i < n; i++) {
    draftAnswer(q.id, { optionIds: [q.options[i % 2]!.id] })
  }
  setNote(q.id, `seeded ${n}`)
  await flushInterviewLog()
  return { qid: q.id, optA: q.options[0]!.id, optB: q.options[1]!.id }
}

for (let s = 0; s < 10; s++) await seedSession(`toolu_hist_${s}`, 400)

const logPath = join(
  process.env.MERCURY_CONFIG_DIR!,
  'interview',
  `${(await import('node:crypto')).createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}.json`,
)
const file = JSON.parse(readFileSync(logPath, 'utf8')) as {
  sessions: Record<string, { events: unknown[] }>
}

t.section('§1 — rebuild cost: a LINEAR slope envelope by operation count')
{
  const { emptyInterviewState, foldInterviewShared } = await import(
    '../../src/tools/engines/interview/contracts.ts'
  )
  class CountingSet extends Set<string> {
    ops = 0
    override has(v: string): boolean {
      this.ops++
      return super.has(v)
    }
    override add(v: string): this {
      this.ops++
      return super.add(v) as this
    }
  }
  const synth = (n: number): Parameters<typeof rebuildInterview>[0] => {
    const events: unknown[] = [
      { kind: 'session-opened', eventId: 'ie_open', atMs: 1, sessionId: 'is_slope', mission: 'slope' },
    ]
    for (let i = 1; i < n; i++) events.push({ kind: 'navigated', eventId: `ie_${i}`, atMs: 1 + i, target: 'review' })
    return events as Parameters<typeof rebuildInterview>[0]
  }
  const opsFor = (n: number): number => {
    const seen = new CountingSet()
    let s = { ...emptyInterviewState(), seenEventIds: seen }
    for (const e of synth(n)) s = foldInterviewShared(s, e, seen)
    return seen.ops
  }
  const o1 = opsFor(100)
  const o2 = opsFor(200)
  const o3 = opsFor(400)
  const SLOPE_MAX = 3
  t.check(
    `dedupe ops slope 100→200 is linear (${(o2 / o1).toFixed(2)}× ≤ ${SLOPE_MAX})`,
    o2 / Math.max(1, o1) <= SLOPE_MAX,
    `ops: ${o1} → ${o2}`,
    'foldInterviewShared in src/tools/engines/interview/contracts.ts must dedupe event ids in constant time per event (the shared seen set), not by rescanning earlier events',
  )
  t.check(
    `dedupe ops slope 200→400 is linear (${(o3 / o2).toFixed(2)}× ≤ ${SLOPE_MAX})`,
    o3 / Math.max(1, o2) <= SLOPE_MAX,
    `ops: ${o2} → ${o3}`,
    'foldInterviewShared in src/tools/engines/interview/contracts.ts must dedupe event ids in constant time per event (the shared seen set), not by rescanning earlier events',
  )
  const quadOps = (n: number): number => (n * (n - 1)) / 2
  t.check(
    'the envelope REJECTS the seeded quadratic (slope ≈ 4 > the bound)',
    quadOps(200) / quadOps(100) > SLOPE_MAX && quadOps(400) / quadOps(200) > SLOPE_MAX,
    `quad slopes: ${(quadOps(200) / quadOps(100)).toFixed(2)}×, ${(quadOps(400) / quadOps(200)).toFixed(2)}×`,
  )
}

t.section('§1b — the absolute keystroke budget (separate from the complexity class)')
{
  const sessions = Object.values(file.sessions)
  const big = sessions[0]!.events as Parameters<typeof rebuildInterview>[0]
  const t2 = performance.now()
  for (let i = 0; i < 5; i++) rebuildInterview(big)
  const bigMs = (performance.now() - t2) / 5
  t.check(`a full-session rebuild stays under 250 ms (${bigMs.toFixed(1)} ms)`, bigMs < 250, '', 'rebuildInterview in src/tools/engines/interview/contracts.ts folds a 400-event session too slowly: remove the per-event work that grows with the log')
}

t.section('§2 — worst-case adoption stays bounded by the capped file')
{
  _resetInterviewForProofs()
  const t0 = performance.now()
  const adopted = adoptDurableSessionSync({ toolUseId: 'toolu_hist_0' })
  const ms = performance.now() - t0
  t.check('the oldest session in a full file still adopts', adopted, '', 'adoptDurableSessionSync in src/tools/engines/interview/store.ts did not find toolu_hist_0 in the durable file: check the cap that drops sessions and the key lookup')
  t.check(`adoption stays under 300 ms (${ms.toFixed(1)} ms)`, ms < 300, '', 'adoptDurableSessionSync in src/tools/engines/interview/store.ts is too slow on a full file: look at what it reads and rebuilds')
  t.check('the adopted state is complete', interviewSnapshot().questionOrder.length === 1, '', 'adoptDurableSessionSync in src/tools/engines/interview/store.ts must rebuild the adopted session into the live state')
}

t.section('§3 — the session cap holds under churn')
{
  t.check(
    'the durable file holds at most 10 sessions after 10 opens',
    Object.keys(file.sessions).length <= 10,
    `${Object.keys(file.sessions).length}`,
    'the trim to MAX_SESSIONS in src/tools/engines/interview/store.ts must drop the oldest sessions when the log is written',
  )
  await seedSession('toolu_hist_extra_a', 10)
  await seedSession('toolu_hist_extra_b', 10)
  const after = JSON.parse(readFileSync(logPath, 'utf8')) as { sessions: Record<string, unknown> }
  t.check('…and after 12', Object.keys(after.sessions).length <= 10, `${Object.keys(after.sessions).length}`, 'the trim to MAX_SESSIONS in src/tools/engines/interview/store.ts must drop the oldest sessions when the log is written')
}

t.section('§4 — a reconnect can never roll back a newer decision')
{
  const { qid, optB } = await seedSession('toolu_rollback', 6)
  commitAnswer(qid, { optionIds: [optB] })
  await flushInterviewLog()
  _resetInterviewForProofs()
  t.check('the durable session re-adopts', adoptDurableSessionSync({ toolUseId: 'toolu_rollback' }), '', 'adoptDurableSessionSync in src/tools/engines/interview/store.ts could not re-adopt the flushed session: check that flushInterviewLog writes it under its toolUseId')
  const s = interviewSnapshot()
  t.check('the NEWEST committed decision is present — no rollback', s.questions[qid]?.committed?.optionIds[0] === optB, '', 'the adopted session lost the last commitAnswer: flushInterviewLog or adoptDurableSessionSync in src/tools/engines/interview/store.ts must keep the newest events')
  t.check('the churned note is present too', s.questions[qid]?.note === 'seeded 6', '', 'the adopted session lost the note set by setNote: flushInterviewLog or adoptDurableSessionSync in src/tools/engines/interview/store.ts must keep the newest events')
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-resume-bounds')
