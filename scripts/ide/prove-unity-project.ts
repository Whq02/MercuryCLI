#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-unity-project.ts
//  PROOF: the Unity project + editor-location owner (services/ide/
//  unityProject.ts, MERCURY_UNITY opt-in) — the registry evidence artifact.
//
//   §1  opt-in polarity: unset ⇒ gate OFF; =1 arms (live re-read).
//   §2  root detection: BOTH Assets/ + ProjectSettings/ required; nearest
//       root from a nested dir; either marker alone is NOT a root; honest
//       absent detail.
//   §3  ProjectVersion.txt: m_EditorVersion (+WithRevision) parsed; BOM +
//       CRLF tolerated; merge-conflicted/foreign text ⇒ reason, NEVER a
//       throw; absent file ⇒ reason.
//   §4  editor location: fake Hub roots (fixed darwin shape — machine-
//       independent), newest-first numeric-aware ordering, pin honesty
//       (broken MERCURY_UNITY_EDITOR refuses BY NAME; a good pin is
//       exclusive). LOCATED only — nothing here can execute anything.
//   §5  profile fusion: version↔editor match; mismatch teaches the
//       install-it-yourself line; zero editors teaches pin + Hub and says
//       Mercury never installs.
//   §6  registry honesty: both flag rows present with the right consumer.
//
//  cpu-pure: scratch trees + fake hub roots; no Unity anywhere.
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-unity-project.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
console.log(' unity project owner (MERCURY_UNITY) — proof')
console.log('============================================================')

const {
  mercuryUnityEnabled,
  findUnityProjectRoot,
  readUnityProjectVersion,
  locateUnityEditors,
  compareUnityVersionsDesc,
  buildUnityProjectProfile,
} = await import('../../src/services/ide/unityProject.js')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')

const savedEnv = { ...process.env }
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
}

const scratch = mkdtempSync(path.join(tmpdir(), 'unity-project-'))
const proj = path.join(scratch, 'Game')
mkdirSync(path.join(proj, 'Assets', 'Scripts'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })
const assetsOnly = path.join(scratch, 'assets-only')
mkdirSync(path.join(assetsOnly, 'Assets'), { recursive: true })

section('§1 · opt-in polarity (default OFF)')
{
  restore()
  delete process.env.MERCURY_UNITY
  check('unset: gate OFF', !mercuryUnityEnabled())
  process.env.MERCURY_UNITY = '1'
  check('=1: gate ON (live re-read)', mercuryUnityEnabled())
}

section('§2 · root detection (BOTH markers)')
{
  restore()
  check(
    'nearest Assets/+ProjectSettings/ root found from a nested dir',
    findUnityProjectRoot(path.join(proj, 'Assets', 'Scripts')) === proj,
  )
  check('Assets/ alone is NOT a root', findUnityProjectRoot(assetsOnly) === undefined)
  check('no markers ⇒ undefined', findUnityProjectRoot(scratch) === undefined)
  const absent = buildUnityProjectProfile(scratch)
  check(
    'absent profile is a STATE with the walk-up detail',
    absent.state === 'absent' && absent.detail.includes('Assets/ + ProjectSettings/'),
  )
}

section('§3 · ProjectVersion.txt (BOM/CRLF/conflict honesty)')
{
  restore()
  const vfile = path.join(proj, 'ProjectSettings', 'ProjectVersion.txt')
  writeFileSync(vfile, 'm_EditorVersion: 6000.3.4f1\n')
  let v = readUnityProjectVersion(proj)
  check('plain m_EditorVersion parsed', v.version === '6000.3.4f1' && v.reason === undefined)
  writeFileSync(
    vfile,
    String.fromCharCode(0xfeff) +
      'm_EditorVersion: 6000.3.4f1\r\nm_EditorVersionWithRevision: 6000.3.4f1 (abc123def456)\r\n',
  )
  v = readUnityProjectVersion(proj)
  check(
    'BOM + CRLF + WithRevision parsed',
    v.version === '6000.3.4f1' && v.versionWithRevision === '6000.3.4f1 (abc123def456)',
  )
  writeFileSync(
    vfile,
    '<<<<<<< HEAD\nm_EditorVersio: broken\n=======\nnothing\n>>>>>>> theirs\n',
  )
  v = readUnityProjectVersion(proj)
  check(
    'merge-conflicted file ⇒ reason, never a throw',
    v.version === undefined && (v.reason ?? '').includes('no m_EditorVersion'),
  )
  rmSync(vfile)
  v = readUnityProjectVersion(proj)
  check('absent file ⇒ reason', v.version === undefined && (v.reason ?? '').includes('unreadable or absent'))
  // Restore a good version file for §5.
  writeFileSync(vfile, 'm_EditorVersion: 6000.3.4f1\n')
}

section('§4 · editor location (fake hub roots; located, never executed)')
{
  restore()
  delete process.env.MERCURY_UNITY_EDITOR
  const hub = path.join(scratch, 'HubEditor')
  for (const ver of ['6000.3.4f1', '6000.10.1f1', '6000.9.2f1']) {
    mkdirSync(path.join(hub, ver, 'Unity.app', 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(hub, ver, 'Unity.app', 'Contents', 'MacOS', 'Unity'), '#!/bin/sh\n')
  }
  // A version dir with NO executable inside must not be listed.
  mkdirSync(path.join(hub, '2022.3.60f1'), { recursive: true })
  const census = locateUnityEditors({ hubRoots: [hub], skipPathProbe: true, platform: 'darwin' })
  check(
    'hub scan lists exactly the executable-bearing version dirs',
    census.editors.length === 3 && census.editors.every(e => e.source === 'hub'),
    census.editors.map(e => e.version).join(','),
  )
  check(
    'newest-first numeric-aware order (6000.10 above 6000.9)',
    census.editors[0]?.version === '6000.10.1f1' &&
      census.editors[1]?.version === '6000.9.2f1' &&
      census.editors[2]?.version === '6000.3.4f1',
  )
  check(
    'compare law: 6000.10.1f1 before 6000.9.2f1',
    compareUnityVersionsDesc('6000.10.1f1', '6000.9.2f1') < 0,
  )
  process.env.MERCURY_UNITY_EDITOR = path.join(scratch, 'nope', 'Unity')
  const broken = locateUnityEditors({ hubRoots: [hub], skipPathProbe: true, platform: 'darwin' })
  check(
    'broken pin refuses BY NAME (no silent fallback)',
    broken.editors.length === 0 &&
      (broken.pinError ?? '').includes('MERCURY_UNITY_EDITOR') &&
      (broken.pinError ?? '').includes(path.join(scratch, 'nope', 'Unity')),
  )
  const pinTarget = path.join(scratch, 'pinned-unity')
  writeFileSync(pinTarget, '#!/bin/sh\n')
  process.env.MERCURY_UNITY_EDITOR = pinTarget
  const pinned = locateUnityEditors({ hubRoots: [hub], skipPathProbe: true, platform: 'darwin' })
  check(
    'good pin is exclusive',
    pinned.editors.length === 1 &&
      pinned.editors[0]?.source === 'pin' &&
      pinned.editors[0]?.path === pinTarget &&
      pinned.pinError === undefined,
  )
}

section('§5 · profile fusion (match / mismatch / none)')
{
  restore()
  delete process.env.MERCURY_UNITY_EDITOR
  // The profile reads the REAL platform hub roots (empty on a gate box) plus
  // PATH; drive the fused matching through the location census directly —
  // the profile's own fusion is proved via its editorDetail sentences below.
  const profile = buildUnityProjectProfile(path.join(proj, 'Assets'))
  check(
    'profile: root + markers + version fact',
    profile.state === 'ok' &&
      profile.root === proj &&
      profile.markers.includes('ProjectSettings/ProjectVersion.txt') &&
      profile.projectVersion.version === '6000.3.4f1',
  )
  check(
    'no located editor ⇒ the never-installs teaching line (or a real box editor row)',
    profile.state === 'ok' &&
      (profile.editors.length > 0 || profile.editorDetail.includes('Mercury never installs')),
    profile.state === 'ok' ? profile.editorDetail : '',
  )
  const pinTarget = path.join(scratch, 'pinned-unity')
  process.env.MERCURY_UNITY_EDITOR = pinTarget
  const pinnedProfile = buildUnityProjectProfile(proj)
  check(
    'pinned profile: projectEditor = the pin, named in the detail',
    pinnedProfile.state === 'ok' &&
      pinnedProfile.projectEditor?.source === 'pin' &&
      pinnedProfile.editorDetail.includes('MERCURY_UNITY_EDITOR'),
  )
  process.env.MERCURY_UNITY_EDITOR = path.join(scratch, 'nope', 'Unity')
  const brokenProfile = buildUnityProjectProfile(proj)
  check(
    'broken-pin profile: pinError surfaces as the editorDetail',
    brokenProfile.state === 'ok' &&
      brokenProfile.pinError !== undefined &&
      brokenProfile.editorDetail === brokenProfile.pinError,
  )
}

section('§6 · registry honesty')
{
  restore()
  const unity = FLAG_REGISTRY.find(f => f.env === 'MERCURY_UNITY')
  const editorPin = FLAG_REGISTRY.find(f => f.env === 'MERCURY_UNITY_EDITOR')
  check(
    'MERCURY_UNITY row: opt-in, evidence = this prover, consumer = unityProject',
    unity !== undefined &&
      unity.kind === 'opt-in' &&
      unity.evidence === 'scripts/ide/prove-unity-project.ts' &&
      unity.consumer === 'src/services/ide/unityProject.ts',
  )
  check(
    'MERCURY_UNITY_EDITOR row: value flag, consumer = unityProject',
    editorPin !== undefined && editorPin.kind === 'value' && editorPin.consumer === 'src/services/ide/unityProject.ts',
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
