#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'src', 'skills', 'loadSkillsDir.ts'), 'utf-8')

console.log('============================================================')
console.log(' HB-0117: MERCURY_SKILL_SELF_AUTH stamp-gated opt-out')
console.log('============================================================')

check(
  'gate reads the skill-self-auth flag through the registry alias',
  /flagEnv\('MERCURY_SKILL_SELF_AUTH'\)/.test(src),
)

check(
  'opt-out is any falsy spelling through isEnvDefinedFalsy (default ON when unset)',
  /!isEnvDefinedFalsy\(flagEnv\('MERCURY_SKILL_SELF_AUTH'\)\)/.test(src),
)
check(
  'the deleted seam stays out of the gate ',
  !/isHermesForkBuild/.test(src),
)

check(
  'command:allowedTools merge is conditional via spread (the falsy opt-out the only off-switch)',
  src.includes("return !isEnvDefinedFalsy(flagEnv('MERCURY_SKILL_SELF_AUTH'))") && src.includes('isSkillSelfAuthEnabled() ? { command: allowedTools } : {}'),
)

check(
  'MCP skills still excluded from inline shell execution',
  /loadedFrom !== 'mcp'/.test(src),
)

check(
  'the deleted fork seam stays out of loadSkillsDir',
  !/isHermesForkBuild/.test(src),
)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0117 — MERCURY_SKILL_SELF_AUTH gate proven (default-ON, =0 drops)')
  process.exit(0)
} else {
  console.log(` ❌ HB-0117 — ${failures} check(s) failed`)
  process.exit(1)
}
