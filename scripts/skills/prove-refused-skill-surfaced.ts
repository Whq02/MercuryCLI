#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'refused-skill-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { setSessionTrustAccepted } = await import(join(SRC, 'boot/process-state/processState.ts'))
setSessionTrustAccepted(true)
const { enableConfigs } = await import(join(SRC, 'platform/config/globalConfig.ts'))
enableConfigs()
const health = await import(join(SRC, 'platform/health/healthReport.ts'))
const evidence = health.skillsRefusedEvidence as ((cwd: string) => Promise<{ status: string; evidence: string; fix?: string }>) | undefined
check('the refused-skills evidence is exported', typeof evidence === 'function')

const BROKEN = '---\nname: probe\ndescription: Author forbids model invocation.\ndisable-model-invocation: true\n  stray: indent\n---\n\nBody.\n'
const CLEAN = '---\nname: fine\ndescription: A well-formed skill.\n---\n\nBody.\n'
let seq = 0
function project(skills: Array<[string, string]>): string {
  const cwd = join(scratch, `proj-${++seq}`)
  for (const [name, body] of skills) {
    mkdirSync(join(cwd, '.mercury', 'skills', name), { recursive: true })
    writeFileSync(join(cwd, '.mercury', 'skills', name, 'SKILL.md'), body)
  }
  mkdirSync(cwd, { recursive: true })
  return cwd
}

console.log('L1 a broken skill is named with its reason')
{
  const cwd = project([['probe', BROKEN], ['fine', CLEAN]])
  const row = await evidence?.(cwd)
  check('the row warns', row?.status === 'warn', JSON.stringify(row))
  check('it names the file, cwd-relative', row?.evidence.includes(join('.mercury', 'skills', 'probe', 'SKILL.md')) === true, row?.evidence)
  check('it names the parse failure', /frontmatter did not parse/i.test(row?.evidence ?? ''), row?.evidence)
  check('it names the source', /\(project\)/.test(row?.evidence ?? ''), row?.evidence)
  check('the well-formed sibling is not listed', !(row?.evidence ?? '').includes('fine'), row?.evidence)
  check('it says what to fix', /frontmatter/i.test(row?.fix ?? ''), row?.fix)
}

console.log('L2 a clean project is ok')
{
  const cwd = project([['fine', CLEAN]])
  const skills = await import(join(SRC, 'integrations/skills/loadSkillsDir.ts'))
  skills.clearSkillCaches()
  const row = await evidence?.(cwd)
  check('the row is ok', row?.status === 'ok', JSON.stringify(row))
}

console.log('L3 the row is in the certificate (the list, read here)')
{
  const { HEALTH_SECTIONS } = await import(join(SRC, 'platform/health/sections.ts'))
  const { toolCapabilityFastChecks } = await import(join(SRC, 'platform/health/sections/tool-capability-fast.ts'))
  const { getCwd } = await import(join(SRC, 'platform/files/cwd.ts'))
  const entry = (HEALTH_SECTIONS as Array<{ id: string; title: string; checks: unknown }>).find(listed => listed.id === 'tool-capability-fast')
  const rows = toolCapabilityFastChecks() as Array<{ id: string; label: string; run: () => Promise<unknown> }>
  check('TOOL CAPABILITY lists the skill-files row', entry?.title === 'TOOL CAPABILITY' && entry.checks === toolCapabilityFastChecks && rows[0]?.label === 'Skill files')
  check("the row's id is skills-refused", rows[0]?.id === 'skills-refused' && JSON.stringify(await rows[0].run()) === JSON.stringify(await evidence?.(getCwd())))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-refused-skill-surfaced: ALL PASS' : `\nprove-refused-skill-surfaced: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
