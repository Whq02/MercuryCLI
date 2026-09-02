#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-registry-migration.ts —.7: the
//  concurrentSessions migration (the handoff's retire-after-migration
//  disposition, adjudicated against first-hand consumer truth):
//
//  §1  the two DCE'd vestiges are ABSENT — envSessionKind's constant-false
//      isBgSession and updateSessionActivity's dead write do not exist on
//      the module surface (the two defects became REMOVAL proofs, not
//      fixes-in-place). The peer-enumeration surface (registerSession,
//      updateSessionName, updateSessionBridgeId, countConcurrentSessions)
//      REMAINS — ps/ListPeers/Remote-Control consume it (the no-regression
//      ruling protects them; recorded adjudication).
//  §2  the live-count axis re-pointed to SUPERVISOR TRUTH:
//      countLiveConcourseWorkers counts records ∩ positive pid liveness;
//      sessionOwnedByLiveWorker answers the owning worker for live sessions
//      only (dead/ended ⇒ null — honestly resumable).
//  §3  the NO-ADOPTION oracle behaviors the REPL resume guard consumes.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

const t = checker()
const root = scratchRoot('registry-migration')

const registry = (await import('../../src/utils/concurrentSessions.js')) as Record<string, unknown>
const sup = await import('../../src/daemon/concourseSupervisor.js')

t.section('§1 — the vestigial halves are gone; the peer-enumeration surface remains')
{
  t.check('isBgSession no longer exists (constant-false vestige removed)', !('isBgSession' in registry), 'removed')
  t.check(
    'updateSessionActivity no longer exists (dead-write vestige removed)',
    !('updateSessionActivity' in registry),
    'removed',
  )
  for (const kept of ['registerSession', 'updateSessionName', 'updateSessionBridgeId', 'countConcurrentSessions']) {
    t.check(`${kept} remains (ps/ListPeers/Remote-Control surface)`, typeof registry[kept] === 'function', kept)
  }
}

t.section('§2 — the live-count axis answers supervisor truth')
{
  const dir = join(root, 'daemon')
  mkdirSync(dir, { recursive: true })
  const alive = process.pid // positively alive — this process
  writeFileSync(
    join(dir, 'concourse-workers.json'),
    JSON.stringify({
      version: 1,
      workers: {
        'concourse-w1': { schema: 1, runnerId: 'concourse-w1', sessionId: 'sess-live-a', workspaceId: '/ws/a', isolation: 'exclusive', modelKey: 'fable', spawnedAt: 1, lastLiveAt: 1, pid: alive },
        'concourse-w2': { schema: 1, runnerId: 'concourse-w2', sessionId: 'sess-live-b', workspaceId: '/ws/b', isolation: 'exclusive', modelKey: 'fable', spawnedAt: 1, lastLiveAt: 1, pid: alive },
        'concourse-w3': { schema: 1, runnerId: 'concourse-w3', sessionId: 'sess-dead', workspaceId: '/ws/c', isolation: 'exclusive', modelKey: 'fable', spawnedAt: 1, lastLiveAt: 1, pid: 999999 },
        'concourse-w4': { schema: 1, runnerId: 'concourse-w4', sessionId: 'sess-ended', workspaceId: '/ws/d', isolation: 'exclusive', modelKey: 'fable', spawnedAt: 1, lastLiveAt: 1, endedAt: 2, pid: alive },
      },
    }),
  )
  t.check(
    'countLiveConcourseWorkers counts records ∩ positive pid liveness only',
    sup.countLiveConcourseWorkers(dir) === 2,
    String(sup.countLiveConcourseWorkers(dir)),
  )
}

t.section('§3 — the NO-ADOPTION oracle (the REPL resume guard consumes it)')
{
  const dir = join(root, 'daemon')
  t.check(
    "a LIVE worker's session answers its owning runnerId",
    sup.sessionOwnedByLiveWorker('sess-live-a', dir) === 'concourse-w1',
    String(sup.sessionOwnedByLiveWorker('sess-live-a', dir)),
  )
  t.check(
    "a DEAD worker's session is honestly resumable (null)",
    sup.sessionOwnedByLiveWorker('sess-dead', dir) === null,
    String(sup.sessionOwnedByLiveWorker('sess-dead', dir)),
  )
  t.check(
    "an ENDED worker's session is honestly resumable (null)",
    sup.sessionOwnedByLiveWorker('sess-ended', dir) === null,
    String(sup.sessionOwnedByLiveWorker('sess-ended', dir)),
  )
  t.check(
    'an unknown session is unowned (null; torn/absent records fail soft)',
    sup.sessionOwnedByLiveWorker('sess-unknown', dir) === null && sup.sessionOwnedByLiveWorker('x', join(root, 'nowhere')) === null,
    'fail-soft',
  )
}

t.finish('prove-registry-migration')
