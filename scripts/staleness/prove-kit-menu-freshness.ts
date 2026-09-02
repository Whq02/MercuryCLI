#!/usr/bin/env bun
// ============================================================================
//  scripts/staleness/prove-kit-menu-freshness.ts — the verify pin over
//  the skills-menu freshness fix (this prover VERIFIES it with pins of its
//  own and never edits the seam).
//
//  The yardstick's seed instance: the boot-menu MCPs & Skills screen used to
//  enumerate ONCE at mount through the memoized skill loader and never
//  re-read; the change watcher served the chat session only — a skill
//  forged mid-session painted the OLD list. R7's landed law, pinned here:
//   · KitMenuScreen enumerates through the FRESH door on EVERY mount, and
//     re-enumerates on every skill-change signal (subscribe/unsubscribe);
//   · the fresh door (enumerateKitCatalogueFresh) drops the loader memos
//     for REAL doors only (injected proof doors never trigger the clears);
//   · the watcher re-arms its watch roots on the CURRENT ground at open
//     (rearmWatchRoots — exported, the ground-move re-arm door this lane
//     FILED as a finding and R7 landed);
//   · the driven half, over the loader's own exported doors: a skill
//     WRITTEN after the memo primed stays invisible (the disease the fix
//     guards), and clearSkillCaches() — the invalidator the fresh door and
//     the watcher both ride — makes the very next enumerate show it
//     (write, invalidate, read: the new truth).
// ============================================================================
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

// ── the landed seam, pinned by shape (never edited by this lane) ────────────
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

// ── the driven half: write → invalidate → read over the loader’s doors ──────
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
