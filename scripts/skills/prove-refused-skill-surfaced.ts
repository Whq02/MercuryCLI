#!/usr/bin/env bun
// ============================================================================
//  prove-refused-skill-surfaced — a skill refused for a frontmatter parse
//  error is named, with its reason, on a surface the operator meets
//  (release-hardening audit rank 63).
//
//  The gap: the loader fails closed on a SKILL.md whose YAML frontmatter
//  does not parse and records the reason on a typed channel
//  (getSkillLoadRefusals) — whose only readers were two provers. The skill
//  was absent from /skills and the model's listing, /name said unknown, and
//  a typo on line 3 was indistinguishable from a skill that was never
//  created; the only record was a debug line while the loader's own
//  comment promised "the human paint rides the health estate".
//
//    L1 a project with a broken skill: the health row warns, names the file
//       (cwd-relative) and its parse error, and says what to fix
//    L2 a clean project: the row is ok
//    L3 the row is in the certificate (source pin)
//
//  Hermetic scratch home and projects.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'refused-skill-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SIMPLE
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import(join(SRC, 'utils/config/globalConfig.ts'))
enableConfigs()
const health = await import(join(SRC, 'utils/healthReport.ts'))
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
  const skills = await import(join(SRC, 'skills/loadSkillsDir.ts'))
  skills.clearSkillCaches()
  const row = await evidence?.(cwd)
  check('the row is ok', row?.status === 'ok', JSON.stringify(row))
}

console.log('L3 the row is in the certificate (source pin)')
{
  const src = readFileSync(join(SRC, 'utils/healthReport.ts'), 'utf8')
  const section = src.slice(src.indexOf("title: 'TOOL CAPABILITY'"), src.indexOf("title: 'TOOL CAPABILITY'") + 400)
  check('TOOL CAPABILITY lists the skill-files row', section.includes('skillsRefusedCheck()'))
  check("the row's id is skills-refused", src.includes("id: 'skills-refused'"))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-refused-skill-surfaced: ALL PASS' : `\nprove-refused-skill-surfaced: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
