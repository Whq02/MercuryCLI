#!/usr/bin/env bun
// ============================================================================
//  scripts/vulcan/prove-portability-doctor.ts
//  PROOF: — the project-skill portability
//  doctor: machine-absolute paths REPORTED with file:line (never
//  rewritten); the declared control table compared against the LIVE
//  project.godot [input] section (exact discrepancies, both directions);
//  the executable resolution carries a receipt; and two machines with
//  different roots yield the SAME semantic launch (spaces + Unicode paths).
// ============================================================================

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { godotPortabilityReport, semanticLaunchOf, liveInputActions, declaredControls } = await import(
  join(ROOT, 'src/services/vulcan/portabilityDoctor.ts')
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Godot portability doctor (seamark SM-G / SM-12) — proof')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'portab-'))
try {
  // The field skill: machine-B absolute path (with a space + Unicode) and a
  // control table drifted from the live [input] section.
  const proj = join(scratch, 'Deadnight Próject') // spaces + Unicode in the ROOT
  const skillDir = join(proj, '.mercury', 'skills', 'launch-game')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(proj, 'project.godot'),
    '[application]\n\nconfig/name="Deadnight"\n\n[input]\n\nmove_left={deadzone:0.5}\nmove_right={deadzone:0.5}\ninteract={deadzone:0.5}\n',
  )
  const SKILL = [
    '# Launch the game',
    '',
    'Run: /Users/machine-b/Godot Projects/deadnight/godot --path "/Users/machine-b/Godot Projects/deadnight" res://scenes/main.tscn',
    '',
    '## Controls',
    '',
    '| action | key |',
    '| ------ | --- |',
    '| move_left | A |',
    '| jump | Space |',
  ].join('\n')
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL)
  const before = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')

  const report = godotPortabilityReport(proj)

  // ── absolute machine paths: reported file:line, NEVER rewritten ──────────
  check('machine-absolute path reported with file + line', report.absolutePaths.length >= 1 && report.absolutePaths[0]!.line === 3 && /machine-b/.test(report.absolutePaths[0]!.text), JSON.stringify(report.absolutePaths[0] ?? null)?.slice(0, 110))
  check('the skill file is NEVER rewritten (byte-identical after diagnosis)', readFileSync(join(skillDir, 'SKILL.md'), 'utf8') === before)

  // ── control drift: exact discrepancies, both directions ──────────────────
  const drift = report.controlDiscrepancies[0]
  check('declared-but-not-live action named exactly (jump)', !!drift && JSON.stringify(drift.declaredNotLive) === JSON.stringify(['jump']), JSON.stringify(drift)?.slice(0, 120))
  check('live-but-undeclared actions named exactly (move_right, interact)', !!drift && JSON.stringify(drift.liveNotDeclared) === JSON.stringify(['move_right', 'interact']))

  // ── executable receipt: typed, never a silent guess ──────────────────────
  check('executable resolution carries a typed receipt', ['PATH', 'well-known-location', 'not-found'].includes(report.executable.source) && report.executable.note.length > 0, `${report.executable.source}: ${report.executable.note.slice(0, 60)}`)

  // ── semantic launch: identical across two machines' roots ────────────────
  const machineA = SKILL.replace(/\/Users\/machine-b\/Godot Projects\/deadnight/g, 'C:\\Users\\Machine A\\Gödot\\deadnight')
  check('two machines, different roots ⇒ the SAME semantic launch', semanticLaunchOf(SKILL) === 'res://scenes/main.tscn' && semanticLaunchOf(machineA) === 'res://scenes/main.tscn', `${semanticLaunchOf(SKILL)} vs ${semanticLaunchOf(machineA)}`)

  // ── parser unit rows ─────────────────────────────────────────────────────
  check('liveInputActions parses the [input] section only', JSON.stringify(liveInputActions(readFileSync(join(proj, 'project.godot'), 'utf8'))) === JSON.stringify(['move_left', 'move_right', 'interact']))
  check('declaredControls skips the header + separator rows', JSON.stringify(declaredControls(SKILL)) === JSON.stringify(['move_left', 'jump']))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL PORTABILITY-DOCTOR PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
