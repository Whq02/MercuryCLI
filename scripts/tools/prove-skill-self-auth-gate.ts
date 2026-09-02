#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-skill-self-auth-gate.ts
//  PROOF for: a disk skill's frontmatter `allowed-tools` was
//  unconditionally merged into alwaysAllowRules.command for inline shell
//  execution → the skill self-authorizes its own !`cmd` blocks. Fix: stamp-gated
//  default-ON MERCURY_SKILL_SELF_AUTH opt-out (=0 drops the command merge).
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-skill-self-auth-gate.ts
// ============================================================================
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

// The gate reads the env var and checks stamped build
check(
  'gate reads the skill-self-auth flag through the registry alias',
  /flagEnv\('MERCURY_SKILL_SELF_AUTH'\)/.test(src),
)

// the stamp-gate prefix is folded away — the =0
// opt-out is the whole gate now.
check(
  'opt-out is =0 (default ON when unset)',
  /MERCURY_SKILL_SELF_AUTH'\) !== '0'/.test(src),
)
check(
  'the deleted seam stays out of the gate ',
  !/isHermesForkBuild/.test(src),
)

// The merge site grants command:allowedTools only through the ONE gate predicate
check(
  'command:allowedTools merge is conditional via spread (=0 the only off-switch)',
  src.includes("return flagEnv('MERCURY_SKILL_SELF_AUTH') !== '0'") && src.includes('isSkillSelfAuthEnabled() ? { command: allowedTools } : {}'),
)

// MCP skills still excluded (the existing security comment)
check(
  'MCP skills still excluded from inline shell execution',
  /loadedFrom !== 'mcp'/.test(src),
)

// the deleted seam stays out
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
