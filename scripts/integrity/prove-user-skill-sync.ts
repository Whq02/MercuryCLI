#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BUNDLED = join(REPO, 'src', 'skills', 'bundled')
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
    if (!existsSync(userMd)) continue
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
