#!/usr/bin/env bun
// prove-themis-mission — the optional tracked change mission.
// off ⇒ nothing; warn records ONE drift warning per path without blocking;
// enforce refuses ONLY under an active mission; expected paths stay quiet;
// completion demands implementing changes + FRESH evidence; contract
// persists across "resume" (fresh read); the receipt is exact.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  activeMission,
  addCriterion,
  addPathToMission,
  completeMission,
  missionDriftConsult,
  missionStatusLine,
  pathExpected,
  startMission,
} = await import('../../src/substrate/themis/mission.ts')
const { themisToolGate } = await import('../../src/substrate/themis/gate.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

function fixture(): string {
  // realpath: the macOS /var→/private/var symlink would make relative(cwd,fp)
  // cross '..' and the gate skip the consult — production paths live in one
  // cwd universe.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mission-fx-')))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'core.ts'), 'export const v = 1\n')
  const git = (...a: string[]): void => {
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' })
  }
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')
  return dir
}

section('§1 explicit off ⇒ no mission behavior, no files (unset = default-on)')
{
  process.env.MERCURY_THEMIS = 'off'
  const dir = fixture()
  const r = startMission({ title: 'x' }, dir)
  check('start refused at off with a truthful reason', !r.ok && /MERCURY_THEMIS/.test((r as { reason: string }).reason))
  check('no store dir created in ANY home', !['.mercury', '.claude'].some(h => existsSync(join(dir, h, 'themis', 'missions'))))
  check('activeMission null (zero fs)', activeMission(dir) === null)
  // The default (unset) is an ACTIVE plane: the same start is allowed.
  delete process.env.MERCURY_THEMIS
  const r2 = startMission({ title: 'x' }, dir)
  check('unset (the default) ⇒ start allowed', r2.ok === true)
}

section('§2 warn: track → expected quiet → ONE warning per unexpected path')
{
  process.env.MERCURY_THEMIS = 'warn'
  const dir = fixture()
  const r = startMission({ title: 'harden core', goalText: 'core hardening' }, dir)
  check('mission starts at warn', r.ok)
  const c = addCriterion({ text: 'core guards input', paths: ['src/core.ts'], checks: ['verify:fast'] }, dir)
  check('criterion amendable while active', c.ok)
  check('expected path quiet (no drift)', missionDriftConsult('Edit', 'src/core.ts', dir).drift === false)
  const d1 = missionDriftConsult('Edit', 'docs/other.md', dir)
  check('unexpected path drifts, first-seen, warn does NOT deny', d1.drift === true && d1.firstSeen && !d1.deny, JSON.stringify(d1))
  const d2 = missionDriftConsult('Edit', 'docs/other.md', dir)
  check('SAME path never re-warns (one clear warning, no noise)', d2.drift === true && !d2.firstSeen)
  const m = activeMission(dir)!
  check('exactly one warning recorded + durable', m.warnings.length === 1 && m.warnings[0]!.path === 'docs/other.md')
  check('status line surfaces the drift', /1 drift warning/.test(missionStatusLine(dir) ?? ''))
  const add = addPathToMission('docs/other.md', dir)
  check('add-to-contract resolves the warning + expands expectations', add.ok && pathExpected(activeMission(dir)!, 'docs/other.md') && activeMission(dir)!.warnings[0]!.resolution === 'added-to-contract')
}

section('§3 enforce: refuses ONLY with an active mission; no mission ⇒ untouched')
{
  process.env.MERCURY_THEMIS = 'enforce'
  const dir = fixture()
  const prevCwd = process.cwd()
  process.chdir(dir)
  try {
    const noMission = themisToolGate('Edit', { file_path: join(dir, 'src', 'anything.ts') })
    check('enforce WITHOUT a mission: file edits proceed (no new restriction)', noMission.action === 'proceed', noMission.action)
    startMission({ title: 'bounded change', expectedPaths: ['src'] }, dir)
    const inZone = themisToolGate('Edit', { file_path: join(dir, 'src', 'core.ts') })
    check('expected-zone edit proceeds under enforce', inZone.action === 'proceed', inZone.action)
    const outZone = themisToolGate('Write', { file_path: join(dir, 'random', 'new.ts') })
    check('unexpected-path write REFUSED with amendment directions', outZone.action === 'deny-mission' && /\/mission add random\/new\.ts/.test((outZone as { missionMessage: string }).missionMessage), JSON.stringify(outZone))
    addPathToMission('random', dir)
    const afterAdd = themisToolGate('Write', { file_path: join(dir, 'random', 'new.ts') })
    check('after add-to-contract the same write proceeds', afterAdd.action === 'proceed', afterAdd.action)
    const bash = themisToolGate('Bash', { command: 'ls' })
    check('non-file tools untouched by the mission', bash.action === 'proceed')
  } finally {
    process.chdir(prevCwd)
  }
}

section('§4 completion: evidence-gated, exact remains, receipt; resume-safe')
{
  process.env.MERCURY_THEMIS = 'warn'
  const dir = fixture()
  startMission({ title: 'ship the guard' }, dir)
  addCriterion({ text: 'guard core', paths: ['src/core.ts'], checks: ['verify:fast'] }, dir)
  const early = completeMission(dir)
  check('no change + no evidence ⇒ NOT complete, remains name both gaps', !early.ok && (early as { remains: string[] }).remains.length >= 2, JSON.stringify(early))
  // implementing change
  writeFileSync(join(dir, 'src', 'core.ts'), 'export const v = 2 // guarded\n')
  const midway = completeMission(dir)
  check('change without evidence still refuses (evidence gap named)', !midway.ok && (midway as { remains: string[] }).remains.some(r => /FRESH passing evidence/.test(r)), JSON.stringify(midway))
  // seed FRESH evidence at the CURRENT tree digest through the store's shape.
  // Reset FIRST: it clears the digest cache too — computing before it would
  // capture the stale cached PRE-edit digest (the earlier completeMission
  // calls populated the 10s TTL cache) and the verdict would recompute fresh.
  const { computeWorkingTreeDigest, _resetVerificationStateForTesting } = await import('../../src/utils/verification/verificationState.ts')
  _resetVerificationStateForTesting()
  const digest = computeWorkingTreeDigest(dir)
  const { adoptiveProjectPath } = await import('../../src/utils/projectStoreAdoption.js')
  const verifyDir = adoptiveProjectPath(dir, 'verify')
  mkdirSync(verifyDir, { recursive: true })
  writeFileSync(
    join(verifyDir, 'evidence.json'),
    JSON.stringify({ schema: 1, records: [{ command: 'bun run verify:fast', ok: true, scope: 'slice', coverage: 'declared', ranAt: new Date().toISOString(), treeDigest: digest, seq: 1 }] }),
  )
  // "resume": the reset above already models the fresh process (load-once
  // persistedLoaded cleared); completion now loads the seeded records.
  const v = completeMission(dir)
  check('with implementing change + fresh evidence ⇒ COMPLETE', v.ok, JSON.stringify(v))
  if (v.ok) {
    check('receipt binds criterion → change → evidence', v.receipt.criteria[0]!.implementedBy.includes('src/core.ts') && v.receipt.criteria[0]!.evidence.length === 1)
  }
  check('mission closed (no active)', activeMission(dir) === null)
}

section('§5 stale-evidence honesty: evidence at an OLD tree refuses')
{
  process.env.MERCURY_THEMIS = 'warn'
  const { _resetVerificationStateForTesting } = await import('../../src/utils/verification/verificationState.ts')
  _resetVerificationStateForTesting()
  const dir = fixture()
  startMission({ title: 'stale check' }, dir)
  addCriterion({ text: 'guard', paths: ['src/core.ts'], checks: ['verify:fast'] }, dir)
  const { adoptiveProjectPath: sticky5 } = await import('../../src/utils/projectStoreAdoption.js')
  const verifyDir5 = sticky5(dir, 'verify')
  mkdirSync(verifyDir5, { recursive: true })
  writeFileSync(
    join(verifyDir5, 'evidence.json'),
    JSON.stringify({ schema: 1, records: [{ command: 'bun run verify:fast', ok: true, scope: 'slice', coverage: 'declared', ranAt: new Date().toISOString(), treeDigest: 'deadbeef', seq: 1 }] }),
  )
  writeFileSync(join(dir, 'src', 'core.ts'), 'export const v = 3\n')
  const v = completeMission(dir)
  check('stale-tree evidence does NOT complete (fresh means CURRENT digest)', !v.ok && (v as { remains: string[] }).remains.some(r => /FRESH/.test(r)), JSON.stringify(v))
}

delete process.env.MERCURY_THEMIS
if (failures) {
  console.log(`\n❌ ${failures} mission check(s) failed`)
  process.exit(1)
}
console.log('\n✅ ALL THEMIS MISSION PROOFS PASS')
