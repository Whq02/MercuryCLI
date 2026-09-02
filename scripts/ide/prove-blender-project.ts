#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-blender-project.ts
//  PROOF: the Blender context + app-location owner (services/ide/
//  blenderProject.ts, MERCURY_BLENDER opt-in) — the registry evidence
//  artifact.
//
//   §1  opt-in polarity: unset ⇒ gate OFF + zero readiness rows; =1 arms.
//   §2  .blend awareness: bounded deterministic walk, hidden/VCS dirs
//       skipped, cap honest (truncation counted).
//   §3  location rungs: pin honesty both ways · PATH · the darwin
//       app-bundle rung (fake bundles) · the win32 Program Files rung
//       (fake tree, newest version dir first).
//   §4  version probe through a PATH-shim fake blender (the gdb-probe
//       shape): parses "Blender 4.5.13"; a foreign binary answers a
//       reason, never a throw; 30s cache dropped via the test seam.
//   §5  readiness honesty: armed+located ⇒ configured naming path+version;
//       armed+absent ⇒ unavailable with the install remedy (the app-bundle
//       teaching + never-installs sentence); broken pin ⇒ unavailable
//       naming the pin.
//
//  cpu-pure + one shim spawn (the fake blender script — loopback-class).
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-blender-project.ts
// ============================================================================
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' blender context owner (MERCURY_BLENDER) — proof')
console.log('============================================================')

const {
  mercuryBlenderEnabled,
  discoverBlendFiles,
  locateBlender,
  probeBlenderVersion,
  blenderLaneReadinessRecords,
  _resetBlenderVersionProbeForTesting,
  BLENDER_INSTALL_REMEDY,
  BLEND_FILE_CAP,
} = await import('../../src/services/ide/blenderProject.js')

const savedEnv = { ...process.env }
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
  _resetBlenderVersionProbeForTesting()
}

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-project-'))

section('§1 · opt-in polarity (default OFF)')
{
  restore()
  delete process.env.MERCURY_BLENDER
  check('unset: gate OFF', !mercuryBlenderEnabled())
  check('unset: zero readiness rows', blenderLaneReadinessRecords().length === 0)
  process.env.MERCURY_BLENDER = '1'
  check('=1: gate ON (live re-read)', mercuryBlenderEnabled())
}

section('§2 · .blend awareness (bounded walk)')
{
  restore()
  const tree = path.join(scratch, 'work')
  mkdirSync(path.join(tree, 'scenes'), { recursive: true })
  mkdirSync(path.join(tree, '.git'), { recursive: true })
  writeFileSync(path.join(tree, 'b.blend'), '')
  writeFileSync(path.join(tree, 'a.blend'), '')
  writeFileSync(path.join(tree, 'scenes', 'c.blend'), '')
  writeFileSync(path.join(tree, '.git', 'hidden.blend'), '')
  writeFileSync(path.join(tree, 'not-a-blend.txt'), '')
  const d = discoverBlendFiles(tree)
  check(
    'deterministic order, VCS skipped',
    d.files.join(',') === 'a.blend,b.blend,scenes/c.blend' && d.total === 3 && d.truncated === 0,
    d.files.join(','),
  )
  const many = path.join(scratch, 'many')
  mkdirSync(many, { recursive: true })
  for (let i = 0; i < BLEND_FILE_CAP + 7; i++) {
    writeFileSync(path.join(many, `f${String(i).padStart(3, '0')}.blend`), '')
  }
  const capped = discoverBlendFiles(many)
  check(
    'cap honest: truncation counted',
    capped.files.length === BLEND_FILE_CAP && capped.total === BLEND_FILE_CAP + 7 && capped.truncated === 7,
  )
}

section('§3 · location rungs')
{
  restore()
  process.env.MERCURY_BLENDER_BIN = path.join(scratch, 'missing-blender')
  let census = locateBlender({ skipPathProbe: true, platform: 'darwin', appBundles: [] })
  check(
    'broken pin refuses BY NAME',
    census.blender === undefined && (census.pinError ?? '').includes('MERCURY_BLENDER_BIN'),
  )
  const pinTarget = path.join(scratch, 'pinned-blender')
  writeFileSync(pinTarget, '#!/bin/sh\n')
  process.env.MERCURY_BLENDER_BIN = pinTarget
  census = locateBlender({ skipPathProbe: true, platform: 'darwin', appBundles: [] })
  check('good pin is exclusive', census.blender?.source === 'pin' && census.blender.path === pinTarget)
  delete process.env.MERCURY_BLENDER_BIN
  const bundle = path.join(scratch, 'Blender.app', 'Contents', 'MacOS')
  mkdirSync(bundle, { recursive: true })
  const bundleBin = path.join(bundle, 'Blender')
  writeFileSync(bundleBin, '#!/bin/sh\n')
  census = locateBlender({ skipPathProbe: true, platform: 'darwin', appBundles: [bundleBin] })
  check(
    'darwin app-bundle rung (the normal Mac install)',
    census.blender?.source === 'app-bundle' && census.blender.path === bundleBin,
  )
  const pf = path.join(scratch, 'ProgramFiles', 'Blender Foundation')
  for (const ver of ['Blender 4.5', 'Blender 5.2', 'Blender 4.2']) {
    mkdirSync(path.join(pf, ver), { recursive: true })
  }
  writeFileSync(path.join(pf, 'Blender 5.2', 'blender.exe'), '')
  writeFileSync(path.join(pf, 'Blender 4.5', 'blender.exe'), '')
  census = locateBlender({ skipPathProbe: true, platform: 'win32', programFilesRoot: pf })
  check(
    'win32 Program Files rung: newest version dir first',
    census.blender?.source === 'program-files' && census.blender.path.includes('Blender 5.2'),
    census.blender?.path ?? '(none)',
  )
  census = locateBlender({ skipPathProbe: true, platform: 'linux', appBundles: [] })
  check('nothing anywhere ⇒ empty census (a STATE)', census.blender === undefined && census.pinError === undefined)
}

section('§4 · the version probe (PATH-shim fake)')
{
  restore()
  const shim = path.join(scratch, 'shim-blender')
  writeFileSync(shim, '#!/bin/sh\necho "Blender 4.5.13"\necho "\tbuild date: 2026-08-25"\nexit 0\n')
  chmodSync(shim, 0o755)
  let v = probeBlenderVersion(shim)
  check('parses "Blender 4.5.13"', v.version === '4.5.13' && v.reason === undefined)
  _resetBlenderVersionProbeForTesting()
  const foreign = path.join(scratch, 'foreign-blender')
  writeFileSync(foreign, '#!/bin/sh\necho "something else"\nexit 0\n')
  chmodSync(foreign, 0o755)
  v = probeBlenderVersion(foreign)
  check('foreign output ⇒ reason, never a throw', v.version === undefined && (v.reason ?? '').includes('unparseable'))
}

section('§5 · readiness honesty (armed states)')
{
  restore()
  process.env.MERCURY_BLENDER = '1'
  const shim = path.join(scratch, 'bin-blender')
  mkdirSync(shim, { recursive: true })
  const shimBin = path.join(shim, 'blender')
  writeFileSync(shimBin, '#!/bin/sh\necho "Blender 5.2.1"\nexit 0\n')
  chmodSync(shimBin, 0o755)
  process.env.PATH = shim
  let rows = blenderLaneReadinessRecords()
  check(
    'armed + located ⇒ configured naming path + version + the operator-act sentence',
    rows.length === 1 &&
      rows[0]?.state === 'configured' &&
      rows[0].detail.includes('Blender 5.2.1') &&
      rows[0].detail.includes(shimBin) &&
      rows[0].detail.includes("operator's act"),
    rows[0]?.detail ?? '',
  )
  _resetBlenderVersionProbeForTesting()
  process.env.PATH = path.join(scratch, 'empty-bin')
  // No PATH blender + the real /Applications may carry one on a dev Mac —
  // pin to a broken path to force the absent arm deterministically.
  process.env.MERCURY_BLENDER_BIN = path.join(scratch, 'nope-blender')
  rows = blenderLaneReadinessRecords()
  check(
    'broken pin ⇒ unavailable naming the pin, remedy = the install line',
    rows.length === 1 &&
      rows[0]?.state === 'unavailable' &&
      rows[0].detail.includes('MERCURY_BLENDER_BIN') &&
      (rows[0].remedy ?? '') === BLENDER_INSTALL_REMEDY,
  )
  check(
    'the remedy teaches the app-bundle install and never-installs',
    BLENDER_INSTALL_REMEDY.includes('/Applications/Blender.app') &&
      BLENDER_INSTALL_REMEDY.includes('never installs'),
  )
}

restore()
rmSync(scratch, { recursive: true, force: true })

console.log('\n============================================================')
if (failures > 0) {
  console.log(` RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
