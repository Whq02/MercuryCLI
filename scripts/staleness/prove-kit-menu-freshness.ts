#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-kitmenu-home-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

const repoRoot = process.cwd()
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

{
  const screen = readFileSync(join(repoRoot, 'src/components/KitMenuScreen.tsx'), 'utf8')
  check('the screen enumerates through the FRESH door', screen.includes('enumerateKitCatalogueFresh(process.cwd())'))
  check('…on every mount AND on every skill-change signal', screen.includes('skillChangeDetector.subscribe(enumerate)'))
  check('…and lets the signal go on unmount (no leaked subscription)', screen.includes('unsubscribe()'))
  check('the watcher re-arms its roots on the CURRENT ground at open', screen.includes('skillChangeDetector.rearmWatchRoots()'))
  const catalogue = readFileSync(join(repoRoot, 'src/services/kitMenu/kitCatalogue.ts'), 'utf8')
  check('the fresh door drops the memos for REAL doors only', catalogue.includes('if (doors === REAL_KIT_DOORS) refreshKitCatalogueDoors()'))
  const detector = readFileSync(join(repoRoot, 'src/utils/skills/skillChangeDetector.ts'), 'utf8')
  check('rearmWatchRoots is the detector’s exported re-arm door', detector.includes('export { initialize, dispose, subscribe, rearmWatchRoots, resetForTesting }'))
}

{
  const globalConfig = await import('../../src/utils/config/globalConfig.js')
  globalConfig.enableConfigs()
  const loader = await import('../../src/skills/loadSkillsDir.js')

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
