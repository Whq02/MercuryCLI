#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-kitmenu-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const freshnessHint = ' | fix: getSkillDirCommands memoises the skill listing per directory and clearSkillCaches must drop that memo, both in src/integrations/skills/loadSkillsDir.ts'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : freshnessHint}`)
}


{
  const globalConfig = await import('../../src/platform/config/globalConfig.js')
  globalConfig.enableConfigs()
  ;(await import('../../src/boot/process-state/processState.ts')).setSessionTrustAccepted(true)
  const loader = await import('../../src/integrations/skills/loadSkillsDir.js')

  const ground = mkdtempSync(join(tmpdir(), 'stale-kitmenu-ground-'))
  const skillsDir = join(ground, '.mercury', 'skills')
  mkdirSync(join(skillsDir, 'alpha'), { recursive: true })
  writeFileSync(join(skillsDir, 'alpha', 'SKILL.md'), '---\ndescription: the first skill\n---\nalpha body\n')
  process.chdir(ground)

  const names = async (): Promise<string[]> =>
    (await loader.getSkillDirCommands(ground)).map(c => c.name ?? '').sort()

  const first = await names()
  check('the primed enumerate sees the pre-existing skill', first.some(n => n.includes('alpha')), first.join(' · '))
  check('…and not the unwritten one', !first.some(n => n.includes('beta')))

  mkdirSync(join(skillsDir, 'beta'), { recursive: true })
  writeFileSync(join(skillsDir, 'beta', 'SKILL.md'), '---\ndescription: forged mid-session\n---\nbeta body\n')
  const stale = await names()
  check('the memo alone would paint the OLD list (the disease R7 guards)', !stale.some(n => n.includes('beta')), stale.join(' · '))

  loader.clearSkillCaches()
  const fresh = await names()
  check('clearSkillCaches → the very next enumerate shows the forged skill', fresh.some(n => n.includes('beta')) && fresh.some(n => n.includes('alpha')), fresh.join(' · '))
}

console.log(failures === 0 ? 'prove-kit-menu-freshness: GREEN' : `prove-kit-menu-freshness: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
