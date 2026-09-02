#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const scratch = mkdtempSync(join(tmpdir(), 'interview-store-'))
process.env.MERCURY_CONFIG_DIR = scratch

const t = checker()
const store = await import('../../src/services/interview/store.ts')
const { rebuildInterview } = await import('../../src/services/interview/contracts.ts')

try {
  t.section('§1 — stable reference + duplicate no-op')
  {
    store._resetInterviewForProofs()
    let notifications = 0
    const unsub = store.subscribeInterview(() => {
      notifications++
    })
    store.openInterviewSession({ mission: 'design the cache layer', sessionId: 'is_prove1' })
    const s1 = store.interviewSnapshot()
    t.check('opening folded the session', s1.sessionId === 'is_prove1' && s1.phase === 'asking')
    const presented = {
      kind: 'questions-presented' as const,
      eventId: 'ie_p1',
      atMs: 1,
      round: 1,
      questions: [
        {
          id: 'iq_1',
          decisionId: 'id_1',
          text: 'Which engine?',
          header: 'Engine',
          options: [{ id: 'io_a', label: 'Redis', description: 'shared' }],
          multiSelect: false,
        },
      ],
    }
    store.appendInterviewEvent(presented)
    const s2 = store.interviewSnapshot()
    t.check('a real event swapped the snapshot reference', s2 !== s1)
    const notifiedBefore = notifications
    store.appendInterviewEvent(presented)
    t.check('a duplicate eventId keeps the SAME reference', store.interviewSnapshot() === s2)
    t.check('a duplicate fires no notification', notifications === notifiedBefore, String(notifications))
    t.check('real events notified subscribers', notifications >= 2, String(notifications))
    unsub()
  }

  t.section('§2 — durable write-through + resume rebuild')
  {
    store.appendInterviewEvent({
      kind: 'answer-committed',
      eventId: 'ie_c1',
      atMs: 2,
      questionId: 'iq_1',
      value: { optionIds: ['io_a'] },
    })
    const liveJson = JSON.stringify(store.interviewSnapshot())
    const liveLog = [...store.interviewEvents()]
    await store.flushInterviewLog()
    const dir = join(scratch, 'interview')
    t.check('the log landed under the SCRATCH config home', existsSync(dir), dir)
    const files = existsSync(dir) ? readdirSync(dir) : []
    t.check('exactly one per-project log file', files.length === 1, files.join(', '))
    store._resetInterviewForProofs()
    t.check('the live slot is cold', store.interviewSnapshot().sessionId === null)
    const resumed = await store.resumeInterviewSession('is_prove1')
    t.check('resume found the durable session', resumed)
    t.check('resume rebuilds deep-equal live state', JSON.stringify(store.interviewSnapshot()) === liveJson)
    t.check(
      'resume equals rebuild over the persisted log (live ≡ rebuild, cross-process shape)',
      JSON.stringify(rebuildInterview(liveLog)) === liveJson,
    )
  }

  t.section('§3 — the session cap holds')
  {
    for (let i = 0; i < 14; i++) {
      store.openInterviewSession({ mission: `m${i}`, sessionId: `is_cap_${i}`, atMs: 10 + i })
      await store.flushInterviewLog()
    }
    const sessions = await store.listInterviewSessions()
    t.check('the per-project log is capped', sessions.length <= 10, String(sessions.length))
    t.check(
      'the newest sessions survived the cap',
      sessions.some(s => s.sessionId === 'is_cap_13'),
    )
  }
} finally {
  store._resetInterviewForProofs()
  rmSync(scratch, { recursive: true, force: true })
}

t.finish('prove-session-store')
