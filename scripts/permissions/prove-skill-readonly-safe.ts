#!/usr/bin/env bun
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }

const { skillHasOnlySafeProperties, READ_ONLY_SKILL_TOOLS } = await import(
  '../../src/tools/SkillTool/SkillTool.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' skill read-only allowed-tools ⇒ safe (no subagent-dead ask)')
console.log('============================================================')

const bare = { type: 'prompt', name: 'x', description: 'd' } as never

check('bare skill (no allowedTools) is safe', skillHasOnlySafeProperties(bare))
check(
  'FORK: pure read-only grant is SAFE (the fix)',
  skillHasOnlySafeProperties({
    ...(bare as object),
    allowedTools: ['Read', 'Grep', 'Glob'],
  } as never),
)
check(
  'a single Read grant is safe too',
  skillHasOnlySafeProperties({ ...(bare as object), allowedTools: ['Read'] } as never),
)
for (const power of [['Edit'], ['Bash'], ['WebFetch'], ['Read', 'Grep', 'WebFetch']]) {
  check(
    `grant with real power stays UNSAFE (${power.join(',')})`,
    !skillHasOnlySafeProperties({ ...(bare as object), allowedTools: power } as never),
  )
}
check(
  'mixed read+write stays UNSAFE',
  !skillHasOnlySafeProperties({
    ...(bare as object),
    allowedTools: ['Read', 'Edit'],
  } as never),
)
check(
  'a non-string entry stays UNSAFE (no type-confusion pass)',
  !skillHasOnlySafeProperties({
    ...(bare as object),
    allowedTools: [{ toString: () => 'Read' }],
  } as never),
)
check(
  'the read-only set is exactly Read/Grep/Glob (minimal by design)',
  READ_ONLY_SKILL_TOOLS.size === 3 &&
    ['Read', 'Grep', 'Glob'].every(t => READ_ONLY_SKILL_TOOLS.has(t)),
)

const src = readFileSync('src/tools/SkillTool/SkillTool.ts', 'utf8')
const caseBlock = src.slice(src.indexOf('READ_ONLY_SKILL_TOOLS.has'), src.indexOf('READ_ONLY_SKILL_TOOLS.has') + 400)
check(
  'the special case keys on allowedTools + array shape ',
  /key === 'allowedTools' &&\s*\n\s*Array\.isArray\(value\)/.test(src),
)
check('…and empty grants never reach it (length > 0 guard)', src.includes('value.length > 0 &&'))
void caseBlock

console.log('\n── repo-skill data ratchet (no pointless pure-read grants)')
const skillsRoots = ['mercury-skills', join('.mercury', 'skills')]
let offenders: string[] = []
for (const skillsRoot of skillsRoots) {
  if (!existsSync(skillsRoot)) continue
  for (const dir of readdirSync(skillsRoot)) {
    const f = join(skillsRoot, dir, 'SKILL.md')
    if (!existsSync(f)) continue
    const head = readFileSync(f, 'utf8').split('\n---')[0] ?? ''
    const m = head.match(/^allowed-tools:\s*(.+)$/m)
    if (!m) continue
    const tools = m[1]!.split(',').map(t => t.trim()).filter(Boolean)
    if (tools.length > 0 && tools.every(t => READ_ONLY_SKILL_TOOLS.has(t))) {
      offenders.push(`${skillsRoot}/${dir} (${tools.join(',')})`)
    }
  }
}
check(
  'no repo skill carries a pure-read allowed-tools grant',
  offenders.length === 0,
  offenders.join('; '),
)

console.log()
if (failures) {
  console.log(`❌ skill-readonly-safe: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ skill-readonly-safe green')
