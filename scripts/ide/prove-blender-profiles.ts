#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-blender-profiles.ts
//  PROOF: the blender headless launch-profile source (MERCURY_BLENDER
//  opt-in) + the shared operator-run refusal.
//
//   §1  opt-in polarity: off ⇒ zero blender profiles.
//   §2  render shapes with THE ORDER LAW pinned by index: -b first, and
//       -o (output) STRICTLY BEFORE -f / -a — the manual's own example
//       shows the reversed spelling rendering to the wrong place.
//   §3  the hermetic python row: --factory-startup + the placeholder
//       script + --python-exit-code 1, note teaching the doc semantics.
//   §4  the refusal contract: blender rows refuse operator-run WITH the
//       command + note and WITHOUT any license sentence (Blender needs
//       none); the unity compat spelling stays the same door.
//   §5  the profile cap: files beyond it counted in a source note.
//
//  cpu-pure: scratch trees only.
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-blender-profiles.ts
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
console.log(' blender headless launch profiles (MERCURY_BLENDER) — proof')
console.log('============================================================')

const { discoverLaunchProfiles } = await import('../../src/services/ide/launchProfiles.js')
const { operatorRunRefusal, unityHeadlessRefusal } = await import(
  '../../src/tools/LaunchTool/LaunchTool.js'
)

const savedEnv = { ...process.env }
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
}

const scratch = mkdtempSync(path.join(tmpdir(), 'blender-profiles-'))
const work = path.join(scratch, 'work')
mkdirSync(work, { recursive: true })
writeFileSync(path.join(work, 'scene-a.blend'), '')
writeFileSync(path.join(work, 'scene-b.blend'), '')

section('§1 · opt-in polarity')
{
  restore()
  delete process.env.MERCURY_BLENDER
  const off = await discoverLaunchProfiles(work)
  check('off: zero blender profiles beside .blend files', off.profiles.every(p => p.source !== 'blender'))
}

section('§2 · render shapes (THE ORDER LAW by index)')
{
  restore()
  process.env.MERCURY_BLENDER = '1'
  // Pin location to a scratch shim so the census is deterministic per box.
  const shimBin = path.join(scratch, 'shim-blender')
  writeFileSync(shimBin, '#!/bin/sh\necho "Blender 5.2.1"\nexit 0\n')
  process.env.MERCURY_BLENDER_BIN = shimBin
  const d = await discoverLaunchProfiles(work)
  const blender = d.profiles.filter(p => p.source === 'blender')
  check(
    '2 files ⇒ 2 render-frame + 2 render-anim + 1 hermetic + 1 debug recipe = 6 rows',
    blender.length === 6,
    `${blender.length}`,
  )
  const renders = blender.filter(p => (p.blenderHeadless?.args ?? []).includes('-b'))
  check('four render rows carry -b <file> first', renders.length === 4 && renders.every(p => p.blenderHeadless?.args[0] === '-b'))
  for (const p of renders) {
    const args = p.blenderHeadless?.args ?? []
    const o = args.indexOf('-o')
    const frame = args.indexOf('-f')
    const anim = args.indexOf('-a')
    check(
      `ORDER LAW: output before ${frame !== -1 ? '-f' : '-a'} (${p.label})`,
      o !== -1 && (frame === -1 || o < frame) && (anim === -1 || o < anim),
    )
    check(
      `note teaches the order law + runs-are-yours (${p.label})`,
      (p.blenderHeadless?.note ?? '').includes('IN ORDER') &&
        (p.blenderHeadless?.note ?? '').includes('never launches Blender'),
    )
  }
  check(
    'the located binary spells the commandLine',
    blender.every(p => p.blenderHeadless?.commandLine.startsWith(shimBin)),
  )
}

section('§3 · the hermetic python row')
{
  restore()
  process.env.MERCURY_BLENDER = '1'
  const d = await discoverLaunchProfiles(work)
  const hermetic = d.profiles.find(
    p => p.source === 'blender' && (p.blenderHeadless?.args ?? []).includes('--factory-startup'),
  )
  const args = hermetic?.blenderHeadless?.args ?? []
  check(
    'shape: --background --factory-startup --python <placeholder> --python-exit-code 1',
    args[0] === '--background' &&
      args.includes('--factory-startup') &&
      args[args.indexOf('--python') + 1] === '<your-script.py>' &&
      args[args.indexOf('--python-exit-code') + 1] === '1',
  )
  check(
    'note teaches the exit-code semantics (zero disables)',
    (hermetic?.blenderHeadless?.note ?? '').includes('zero disables'),
  )
}

section('§4 · the shared operator-run refusal')
{
  restore()
  process.env.MERCURY_BLENDER = '1'
  const d = await discoverLaunchProfiles(work)
  const row = d.profiles.find(p => p.source === 'blender')
  const refusal = row ? operatorRunRefusal(row) : null
  check(
    'blender refusal: operator-run + command + note, no-change',
    refusal !== null &&
      refusal.outcome === 'no-change' &&
      refusal.result.includes('blender headless profiles are operator-run') &&
      refusal.result.includes(row?.blenderHeadless?.commandLine ?? '∅'),
  )
  check(
    'no license sentence on blender rows (Blender needs none)',
    refusal !== null && !refusal.result.toLowerCase().includes('licens'),
  )
  check('the unity compat spelling is the same door', unityHeadlessRefusal === operatorRunRefusal)
}

section('§5 · the profile cap honesty')
{
  restore()
  process.env.MERCURY_BLENDER = '1'
  const many = path.join(scratch, 'many')
  mkdirSync(many, { recursive: true })
  for (let i = 0; i < 13; i++) {
    writeFileSync(path.join(many, `f${String(i).padStart(2, '0')}.blend`), '')
  }
  const d = await discoverLaunchProfiles(many)
  const blender = d.profiles.filter(p => p.source === 'blender')
  check('capped: 10 files × 2 + hermetic + debug recipe = 22 rows', blender.length === 22, `${blender.length}`)
  check(
    'the overflow is a counted source note, not silence',
    d.sourceErrors.some(e => e.source === 'blender' && e.error.includes('3 more .blend')),
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
