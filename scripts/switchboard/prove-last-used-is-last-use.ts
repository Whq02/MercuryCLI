#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'last-used-is-last-use-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
const FAIL_HINT = 'use last activity (lastDeliveryAt, lastTurnSettledAt, activity.lastTurnAt, else transcript mtime, never spawnedAt) for ageLabel in recordRowOf in src/screen/concourse-model/concourseSnapshot.ts'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : [detail, FAIL_HINT].filter(Boolean).join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { workerTranscriptPath } = await import('../../src/screen/concourse-model/workerTranscript.ts')
const { buildConcourseSnapshot } = await import('../../src/screen/concourse-model/concourseSnapshot.ts')
const { projectIdentity } = await import('../../src/screen/boot-face/bootCardFacts.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const NOW = Date.now()
const MIN = 60_000
const recordsDir = join(SCRATCH, 'daemon')
const crewDir = join(SCRATCH, 'crew')
const draftDir = join(SCRATCH, 'draft')
const PROJECT = join(SCRATCH, 'proj')
for (const d of [recordsDir, crewDir, draftDir, PROJECT]) mkdirSync(d, { recursive: true })

const sid = (tail: string): string => `00000000-aaaa-4000-8000-${tail.padStart(12, '0')}`

function seedWorkers(records: ConcourseWorkerRecordV1[]): void {
  const workers = Object.fromEntries(records.map(r => [r.runnerId, r]))
  writeFileSync(join(recordsDir, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers }, null, 1)}\n`)
}

function seedTranscript(sessionId: string, prompt: string, ageMs: number): void {
  const file = workerTranscriptPath({ sessionId, workspaceId: PROJECT })
  mkdirSync(dirname(file), { recursive: true })
  const rows = [
    {
      isSidechain: false,
      entrypoint: 'cli',
      cwd: PROJECT,
      sessionId,
      version: '1.0.0-beta.1',
      gitBranch: 'main',
      parentUuid: null,
      uuid: `00000000-0000-4000-8000-${sessionId.slice(-12)}`,
      timestamp: new Date(NOW - ageMs).toISOString(),
      type: 'user',
      message: { role: 'user', content: prompt },
    },
  ]
  writeFileSync(file, encodeSeedTranscript(rows as never, sessionId))
  const at = new Date(NOW - ageMs)
  utimesSync(file, at, at)
}

function baseRecord(runnerId: string, sessionId: string, extra: Partial<ConcourseWorkerRecordV1> = {}): ConcourseWorkerRecordV1 {
  return {
    schema: 1,
    runnerId,
    sessionId,
    workspaceId: PROJECT,
    isolation: 'exclusive',
    modelKey: 'fable',
    spawnedAt: NOW - 30 * MIN,
    lastLiveAt: NOW,
    pid: process.pid,
    ...extra,
  }
}

const S_SETTLED = sid('01')
const S_DELIVERED = sid('02')
const S_ACTIVITY = sid('03')
const S_PARKED_HOSTED = sid('04')
const S_FALLBACK = sid('05')
const S_BLANK = sid('06')
const S_UNHOSTED = sid('07')

seedTranscript(S_SETTLED, 'settled prompt', 20 * MIN)
seedTranscript(S_FALLBACK, 'fallback prompt', 4 * MIN)
seedTranscript(S_UNHOSTED, 'unhosted prompt', 7 * MIN)

seedWorkers([
  baseRecord('concourse-w1', S_SETTLED, {
    title: 'settled session',
    lastDeliveryAt: NOW - 2 * MIN,
    lastTurnSettledAt: NOW - 1 * MIN,
  }),
  baseRecord('concourse-w2', S_DELIVERED, {
    title: 'in-flight session',
    lastDeliveryAt: NOW - 1 * MIN,
    lastTurnSettledAt: NOW - 12 * MIN,
  }),
  baseRecord('concourse-w3', S_ACTIVITY, {
    title: 'active seat session',
    lastDeliveryAt: NOW - 15 * MIN,
    activity: { state: 'working', subagents: 0, description: 'working', lastTurnAt: NOW - 2 * MIN },
  }),
  baseRecord('concourse-w4', S_PARKED_HOSTED, {
    title: 'parked hosted session',
    pid: 999_999_999,
    lastDeliveryAt: NOW - 6 * MIN,
    lastTurnSettledAt: NOW - 5 * MIN,
    parkedAt: NOW - 3 * MIN,
    parkedBy: 'operator:test',
  }),
  baseRecord('concourse-w5', S_FALLBACK, {
    title: 'resumed at rest session',
    resumedAtRestAt: NOW - 30 * MIN,
  }),
  baseRecord('concourse-w6', S_BLANK, {
    title: 'blank newborn session',
    bornBlankAt: NOW - 30 * MIN,
  }),
])

const snap = await buildConcourseSnapshot({
  recordsDir,
  crewDir,
  draftDir,
  nowMs: NOW,
  project: projectIdentity(PROJECT),
})
const byId = new Map(snap.groups.flatMap(g => g.rows).map(r => [r.sessionId, r] as const))

check('hosted session started 30m ago and settled 1m ago reads 01m', byId.get(S_SETTLED)?.ageLabel === '01m', `got ${String(byId.get(S_SETTLED)?.ageLabel)}`)
check('hosted session with delivery 1m ago and older settle reads 01m', byId.get(S_DELIVERED)?.ageLabel === '01m', `got ${String(byId.get(S_DELIVERED)?.ageLabel)}`)
check('hosted session with activity.lastTurnAt 2m ago reads 02m', byId.get(S_ACTIVITY)?.ageLabel === '02m', `got ${String(byId.get(S_ACTIVITY)?.ageLabel)}`)
check('parked hosted session started 30m ago and settled 5m ago reads 05m', byId.get(S_PARKED_HOSTED)?.ageLabel === '05m', `got ${String(byId.get(S_PARKED_HOSTED)?.ageLabel)}`)
check('hosted session with no record activity falls back to transcript mtime (04m)', byId.get(S_FALLBACK)?.ageLabel === '04m', `got ${String(byId.get(S_FALLBACK)?.ageLabel)}`)
check('hosted session with neither record activity nor transcript has null ageLabel (never start time)', byId.get(S_BLANK)?.ageLabel === null, `got ${String(byId.get(S_BLANK)?.ageLabel)}`)
check('unhosted parked session from transcript still reads its transcript age (07m)', byId.get(S_UNHOSTED)?.ageLabel === '07m', `got ${String(byId.get(S_UNHOSTED)?.ageLabel)}`)

removeScratch(SCRATCH)
console.log(failures === 0 ? '\nprove-last-used-is-last-use: ALL LAWS HOLD' : `\nprove-last-used-is-last-use: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
