#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'
import type { StreamJsonChildSpec } from '../../src/daemon/headlessRun.ts'

const t = checker()
const root = scratchRoot('boot-profiles')
writeFileSync(
  join(root, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
process.env.MERCURY_DAEMON_DIR = join(root, 'daemon')
process.env.MERCURY_DAEMON_DIR = join(root, 'daemon')
const menu = await import('../../src/substrate/startupMenu.js')
const profilePath = join(root, 'boot-env.json')

t.section('§1 — the frozen surface (repro, verbatim)')
for (const fn of ['saveBootDefaultsProfile', 'readBootDefaultsProfile', 'resolveEffectiveSettingsSnapshot'] as const) {
  t.check(`startupMenu exports ${fn}()`, typeof (menu as Record<string, unknown>)[fn] === 'function', fn)
}

t.section('§2 — atomic monotonic digested receipted saves')
{
  const first = menu.saveBootDefaultsProfile({ MERCURY_MNEME: '1' }, profilePath)
  t.check('the first save commits revision 1', first.ok === true && first.revision === 1, JSON.stringify(first))
  const second = menu.saveBootDefaultsProfile({ MERCURY_DAP: '0' }, profilePath)
  t.check(
    'a second save commits the NEXT monotonic revision with a fresh digest',
    second.ok === true && first.ok === true && second.revision === 2 && second.digest !== first.digest,
    JSON.stringify(second),
  )
  t.check(
    'the receipt states future-only application (copy-correct)',
    second.ok === true && /sessions created after revision 2/.test(second.receipt) && /existing sessions unchanged/.test(second.receipt),
    second.ok === true ? second.receipt : 'refused',
  )
  const read = menu.readBootDefaultsProfile(profilePath)
  t.check('the read answers the committed profile', read !== null && read.revision === 2 && read.digest === (second.ok ? second.digest : ''), JSON.stringify({ rev: read?.revision }))
  const smuggle = menu.saveBootDefaultsProfile({ PATH: '/evil' }, profilePath)
  t.check('an unregistered key refuses the WHOLE save (anti-smuggling)', smuggle.ok === false && menu.readBootDefaultsProfile(profilePath)?.revision === 2, JSON.stringify(smuggle))
  const foreign = menu.saveBootDefaultsProfile({ MERCURY_MNEME: 'banana' }, profilePath)
  t.check('a foreign value refuses the WHOLE save', foreign.ok === false && menu.readBootDefaultsProfile(profilePath)?.revision === 2, JSON.stringify(foreign))
}

t.section('§3 — resolution provenance (explicit env ALWAYS wins)')
{
  menu.saveBootDefaultsProfile({ MERCURY_MNEME: '1', MERCURY_DAP: '0' }, profilePath)
  const env: NodeJS.ProcessEnv = { MERCURY_DAP: '0' }
  const snap = menu.resolveEffectiveSettingsSnapshot({ sessionId: 'sess-prov', path: profilePath, env })
  const profileRow = snap.rows.find(r => r.env === 'MERCURY_MNEME')
  const envRow = snap.rows.find(r => r.env === 'MERCURY_DAP')
  const other = snap.rows.find(r => r.env !== 'MERCURY_MNEME' && r.env !== 'MERCURY_DAP')
  t.check('a profile row resolves source=profile', profileRow?.source === 'profile' && profileRow.value === '1', JSON.stringify(profileRow))
  t.check('an explicit env row wins with source=process-env', envRow?.source === 'process-env' && envRow.value === '0', JSON.stringify(envRow))
  t.check('an untouched row is honestly source=default (value null)', other?.source === 'default' && other.value === null, JSON.stringify(other))
  t.check('the snapshot pins the profile revision + digest', snap.profileRevision === 3 && /^snap-r3-/.test(snap.snapshotId), snap.snapshotId)
}

t.section('§4 — at the supervisor seam: immutable + resume-retained')
{
  const dir = join(root, 'daemon')
  const { makeConcourseAdmitHandler, readSessionWorkers, settleConcourseWorker } = await import(
    '../../src/daemon/concourseSupervisor.js'
  )
  const liveShorts = new Set<string>()
  let nextPid = 51000
  const roster = {
    has: (short: string) => ({ present: liveShorts.has(short) }),
    list: () => [...liveShorts].map(short => ({ short })),
    registerLongLived: (short: string, _spec: StreamJsonChildSpec) => {
      liveShorts.add(short)
      return { ok: true, pid: nextPid++ }
    },
  }
  const admit = makeConcourseAdmitHandler({ roster: () => roster, dir })
  const ws = join(root, 'ws-snap')
  mkdirSync(ws, { recursive: true })
  const admitted = await admit({ workspaceDir: ws })
  t.check('admission succeeded', admitted.ok === true, JSON.stringify(admitted))
  if (!admitted.ok) t.finish('prove-boot-profiles')
  const rec = () => readSessionWorkers(dir)[admitted.ok ? admitted.runnerId : '']!
  const captured = rec().settingsSnapshot
  t.check('the record stores the WHOLE snapshot (durable provenance)', captured !== undefined && captured.rows.length > 0 && /^snap-r/.test(captured.snapshotId), captured?.snapshotId ?? 'absent')
  menu.saveBootDefaultsProfile({ MERCURY_WARDS: '0' }, profilePath)
  t.check(
    'a LATER profile save changes NOTHING on the established record',
    JSON.stringify(rec().settingsSnapshot) === JSON.stringify(captured),
    'frozen',
  )
  settleConcourseWorker(admitted.runnerId, dir)
  liveShorts.delete(admitted.runnerId)
  const readmitted = await admit({ workspaceDir: ws, resumeSessionId: admitted.sessionId })
  t.check('re-admission of the same durable session succeeded', readmitted.ok === true && readmitted.sessionId === admitted.sessionId, JSON.stringify(readmitted))
  const retained = readmitted.ok ? readSessionWorkers(dir)[readmitted.runnerId]?.settingsSnapshot : undefined
  t.check(
    'resume RETAINS the ORIGINAL captured snapshot (not a fresh resolve)',
    retained !== undefined && captured !== undefined && retained.snapshotId === captured.snapshotId && retained.profileRevision === captured.profileRevision,
    JSON.stringify({ was: captured?.snapshotId, now: retained?.snapshotId }),
  )
}

t.section('§5 — riders: receipt count · monotonic single-row writes · explicit apply')
{
  const counted = menu.saveBootDefaultsProfile({ MERCURY_MNEME: '1' }, profilePath, { existingSessionsUnchanged: 3 })
  t.check(
    "the receipt carries the caller's count (\"3 existing sessions unchanged\")",
    counted.ok === true && /3 existing sessions unchanged/.test(counted.receipt) && /existing sessions unchanged/.test(counted.receipt),
    counted.ok ? counted.receipt : 'refused',
  )
  const one = menu.saveBootDefaultsProfile({ MERCURY_MNEME: '1' }, profilePath, { existingSessionsUnchanged: 1 })
  t.check('the singular count reads correctly', one.ok === true && /1 existing session unchanged/.test(one.receipt), one.ok ? one.receipt : 'refused')

  const revBefore = menu.readBootDefaultsProfile(profilePath)?.revision ?? 0
  const wrote = menu.writeBootEnvChoice('MERCURY_WARDS', '0', profilePath)
  const afterWrite = menu.readBootDefaultsProfile(profilePath)
  t.check(
    'writeBootEnvChoice commits the NEXT monotonic revision (never a legacy rewind)',
    wrote.ok === true && afterWrite !== null && afterWrite.revision === revBefore + 1 && afterWrite.digest.length > 0 && afterWrite.receipt.length > 0,
    JSON.stringify({ revBefore, after: afterWrite?.revision }),
  )
  t.check(
    'the single-row write preserved the OTHER saved rows',
    afterWrite !== null && Object.keys(afterWrite.env).some(k => k === 'MERCURY_MNEME') && afterWrite.env['MERCURY_WARDS'] === '0',
    JSON.stringify(Object.keys(afterWrite?.env ?? {})),
  )
  const cleared = menu.writeBootEnvChoice('MERCURY_WARDS', null, profilePath)
  const afterClear = menu.readBootDefaultsProfile(profilePath)
  t.check(
    'clearing a row is also a monotonic commit and removes only that row',
    cleared.ok === true && afterClear !== null && afterClear.revision === revBefore + 2 && afterClear.env['MERCURY_WARDS'] === undefined && afterClear.env['MERCURY_MNEME'] === '1',
    JSON.stringify({ rev: afterClear?.revision, keys: Object.keys(afterClear?.env ?? {}) }),
  )
  const refusedWrite = menu.writeBootEnvChoice('MERCURY_MNEME', 'banana', profilePath)
  t.check(
    'a foreign value still refuses the single-row write whole',
    refusedWrite.ok === false && menu.readBootDefaultsProfile(profilePath)?.revision === revBefore + 2,
    JSON.stringify(refusedWrite),
  )

  const env: NodeJS.ProcessEnv = { MERCURY_CONCOURSE: '0' }
  const snap = menu.resolveEffectiveSettingsSnapshot({ sessionId: 'sess-apply', path: profilePath, env })
  menu.saveBootDefaultsProfile({ MERCURY_MNEME: '1', MERCURY_DAP: '0' }, profilePath)
  const receipts = menu.evaluateExplicitApply(snap, menu.readBootDefaultsProfile(profilePath))
  const byEnv = new Map(receipts.map(r => [r.env, r]))
  t.check('every menu row answers a target-specific receipt', receipts.length === snap.rows.length, String(receipts.length))
  t.check(
    'the vocabulary is closed (applied | queued | refused | no-change)',
    receipts.every(r => ['applied', 'queued', 'refused', 'no-change'].includes(r.outcome)),
    JSON.stringify([...new Set(receipts.map(r => r.outcome))]),
  )
  const pinned = byEnv.get('MERCURY_CONCOURSE')
  t.check(
    'an env-pinned row refuses on the EXPLICIT-ENV-ALWAYS-WINS law',
    pinned?.outcome === 'refused' && /env always wins/.test(pinned.reason),
    JSON.stringify(pinned),
  )
  const moved = byEnv.get('MERCURY_DAP')
  t.check(
    'a row the profile moved refuses with the application class named (new-session truth)',
    moved?.outcome === 'refused' && moved.target === '0' && /application class: new-session/.test(moved.reason),
    JSON.stringify(moved),
  )
  const same = byEnv.get('MERCURY_MNEME')
  t.check(
    'a row already at the profile value answers no-change',
    same?.outcome === 'no-change' && same.target === '1',
    JSON.stringify(same),
  )
}

t.finish('prove-boot-profiles')
