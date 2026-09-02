#!/usr/bin/env bun
// ============================================================================
//  scripts/integrity/prove-user-skill-sync.ts
//  DRIFT LOCK: user-home skill copies must match their bundled sources.
//
//  Some bundled skills (src/skills/bundled/<name>/SKILL.md) are ALSO installed
//  in a user skills directory named on the command line, so sessions that
//  never load Mercury's bundled registry still get them. There is no sync
//  step, so the user copies rot silently — the substrate-livewire
//  recon found the user terminal-ui-design still teaching the RETIRED palette
//  (#E07A50/#8A4E35), `/deck` (renamed /cockpit), and a React-Compiler
//  constant-JSX rule that is false in the hand-written form — actively
//  harmful guidance. This proof makes that drift a gate failure on the
//  operator's machine: for every bundled skill that has a user-home twin,
//  SKILL.md must be byte-identical (resync: cp the bundled file over the user
//  copy — bundled is the source of truth, it is repo-reviewed and gate-checked).
//
//  A user copy that is ABSENT passes (not every bundled skill is installed);
//  a missing user skills dir (fresh machine, CI) passes with a note.
//
//  Run:  ~/.bun/bin/bun run scripts/integrity/prove-user-skill-sync.ts --user-skills <dir>
// ============================================================================

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BUNDLED = join(REPO, 'src', 'skills', 'bundled')
// The user skills dir is an EXPLICIT argument with no default: the twins this
// lock compares live in a user home of the operator's choosing (another
// harness's skills dir, the product's own) — a proof never reaches into another
// program's directory on its own. Absent ⇒ nothing installed to drift.
const userSkillsArg = process.argv.indexOf('--user-skills')
const USER_SKILLS = userSkillsArg >= 0 ? process.argv[userSkillsArg + 1]?.normalize('NFC') : undefined

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('============================================================')
console.log(' user-home skill copies ↔ bundled sources — drift lock')
console.log('============================================================')

if (!USER_SKILLS || !existsSync(USER_SKILLS)) {
  console.log(
    USER_SKILLS
      ? `  [PASS] no user skills dir at ${USER_SKILLS} (fresh machine) — nothing to drift`
      : '  [PASS] no user skills dir given (--user-skills <dir>) — nothing to drift',
  )
} else {
  const bundledDirs = readdirSync(BUNDLED, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(BUNDLED, d.name, 'SKILL.md')))
    .map(d => d.name)
  let twins = 0
  for (const name of bundledDirs) {
    const userMd = join(USER_SKILLS, name, 'SKILL.md')
    if (!existsSync(userMd)) continue // not installed user-side — fine
    twins++
    const same = readFileSync(userMd, 'utf8') === readFileSync(join(BUNDLED, name, 'SKILL.md'), 'utf8')
    check(
      `${userMd} matches bundled`,
      same,
      same ? '' : `resync: cp src/skills/bundled/${name}/SKILL.md ${userMd}`,
    )
  }
  console.log(`  (${twins} user-installed twin(s) of ${bundledDirs.length} bundled skill(s) checked)`)
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ USER SKILL COPIES IN SYNC')
} else {
  console.log(` ❌ ${failures} user skill cop(ies) drifted from bundled`)
  process.exit(1)
}
