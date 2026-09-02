#!/usr/bin/env bun
// ============================================================================
//  scripts/projectdirs/prove-dual-config.ts
//  PROOF: the project-config home contract (`.mercury/` is the one home;
//  external dirs are never homes) holds at its ONE seam and its consumers:
//    1. adoptiveProjectPath — the canonical-write law: a Mercury store
//       ALWAYS homes under `.mercury/`; a `.claude/` dir belongs to an
//       external harness and is never read.
//    2. resolveProjectConfigPath — read resolution + honest null.
//    3. projectConfigCandidates — the existing home, or nothing.
//    4. The loader walk (getProjectDirsUpToHome) surfaces the home per level.
//    5. The wards reader rides the home resolver.
//  Hermetic: everything under a scratch root; no daemon, no API.
//  Run: ~/.bun/bin/bun run scripts/projectdirs/prove-dual-config.ts
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  projectConfigCandidates,
  projectConfigDirs,
  resolveProjectConfigPath,
} from '../../src/utils/projectConfig.js'
import { adoptiveProjectPath } from '../../src/utils/projectStoreAdoption.js'
import { getProjectDirsUpToHome } from '../../src/utils/markdownConfigLoader.js'
import { loadProjectWards } from '../../src/utils/hooks/wardsHook.js'

let failures = 0
const check = (cond: boolean, msg: string): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dualdir-'))

// ── 1. the canonical-write law ───────────────────────────────────────────────
{
  const fresh = join(root, 'fresh')
  mkdirSync(fresh, { recursive: true })
  check(
    adoptiveProjectPath(fresh, 'router') === join(fresh, '.mercury', 'router'),
    'FRESH project: a Mercury store homes under .mercury/ (nothing ever writes .claude/)',
  )
  check(!existsSync(join(fresh, '.mercury')), '…and resolving is pure: no directory is created')
  const external = join(root, 'external')
  mkdirSync(join(external, '.claude', 'party'), { recursive: true })
  check(
    adoptiveProjectPath(external, 'party') === join(external, '.mercury', 'party'),
    'EXTERNAL-DIR project: a .claude/ store is NOT a home — canonical .mercury returned, nothing adopted',
  )
  check(
    existsSync(join(external, '.claude', 'party')) && !existsSync(join(external, '.mercury', 'party')),
    '…the external dir is untouched AND uncopied (never read)',
  )
  const both = join(root, 'both')
  mkdirSync(join(both, '.claude', 'evolution'), { recursive: true })
  mkdirSync(join(both, '.mercury', 'evolution'), { recursive: true })
  check(
    adoptiveProjectPath(both, 'evolution') === join(both, '.mercury', 'evolution'),
    'BOTH present: .mercury/ is the answer (the external dir is ignored)',
  )
}

// ── 2+3. read resolution + candidates ────────────────────────────────────────
{
  const p = join(root, 'reads')
  mkdirSync(join(p, '.claude'), { recursive: true })
  writeFileSync(join(p, '.claude', 'wards.json'), '{"rules":[]}')
  check(
    resolveProjectConfigPath(p, 'wards.json') === null,
    'a file only in an external .claude/ dir resolves to an honest null (not a home)',
  )
  check(projectConfigCandidates(p, 'wards.json').length === 0, 'candidates: none while no Mercury home holds the file')
  mkdirSync(join(p, '.mercury'), { recursive: true })
  writeFileSync(join(p, '.mercury', 'wards.json'), '{"rules":[]}')
  check(
    resolveProjectConfigPath(p, 'wards.json') === join(p, '.mercury', 'wards.json'),
    'read resolution: .mercury/ answers once present',
  )
  check(resolveProjectConfigPath(p, 'absent.json') === null, 'an absent file resolves to an honest null')
  const cands = projectConfigCandidates(p, 'wards.json')
  check(
    cands.length === 1 && cands[0]!.includes('.mercury'),
    'candidates: exactly the Mercury home — the external dir never listed',
  )
  const dirs = projectConfigDirs(p)
  check(dirs.length === 1 && dirs[0]!.endsWith('.mercury'), 'projectConfigDirs names the one home')
}

// ── 4. the loader walk surfaces the home per level ───────────────────────────
{
  const proj = join(root, 'walk', 'repo')
  const nested = join(proj, 'pkg')
  mkdirSync(join(nested, '.mercury', 'commands'), { recursive: true })
  mkdirSync(join(nested, '.claude', 'commands'), { recursive: true })
  const dirs = getProjectDirsUpToHome('commands', nested)
  const mercuryIdx = dirs.findIndex(d => d === join(nested, '.mercury', 'commands'))
  const claudeIdx = dirs.findIndex(d => d === join(nested, '.claude', 'commands'))
  check(
    mercuryIdx !== -1 && claudeIdx === -1,
    `the commands/agents/skills walk lists the Mercury home, external dirs never (got [${dirs.join(', ')}])`,
  )
}

// ── 5. the wards reader rides the home resolver ──────────────────────────────
{
  const wm = join(root, 'wards-mercury')
  mkdirSync(join(wm, '.mercury'), { recursive: true })
  writeFileSync(
    join(wm, '.mercury', 'wards.json'),
    JSON.stringify([{ name: 'no-bar', teach: 'test rule', scope: 'bash', patterns: ['bar'] }]),
  )
  const mRules = loadProjectWards(wm)
  check(
    Array.isArray(mRules) && mRules.length === 1 && mRules[0]!.name === 'no-bar',
    'a .mercury/wards.json loads through the home resolver',
  )
  const we = join(root, 'wards-external')
  mkdirSync(join(we, '.claude'), { recursive: true })
  writeFileSync(join(we, '.claude', 'wards.json'), JSON.stringify([{ name: 'no-foo', teach: 'x', scope: 'bash', patterns: ['foo'] }]))
  const eRules = loadProjectWards(we)
  check(Array.isArray(eRules) && eRules.length === 0, 'an external .claude/wards.json is never read')
  const none = loadProjectWards(join(root, 'fresh'))
  check(Array.isArray(none) && none.length === 0, 'a project with no wards file loads an honest empty set')
}

// FN-014 row 7: the boot-time markdown config loader reads its files
// CONCURRENTLY (the sibling dedupeByIdentity's own shape) — N sequential
// seek+read latencies collapsed to the slowest single read, order preserved
// by Promise.all over the sorted paths.
{
  const { readFileSync } = await import('node:fs')
  const loaderSrc = readFileSync(new URL('../../src/utils/markdownConfigLoader.ts', import.meta.url), 'utf8')
  const fn = loaderSrc.slice(loaderSrc.indexOf('async function loadDirectory('), loaderSrc.indexOf('\n}\n', loaderSrc.indexOf('async function loadDirectory(')))
  check(fn.includes('await Promise.all(') && fn.includes('paths.map(async filePath =>') && !/for\s*\(const filePath of paths\)/.test(fn), 'loadDirectory reads per-file concurrently (no serial await loop)')
}

console.log('════════════════════════════════════════════════════════════════════════════')
rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.error(`❌ ${failures} project-config invariant(s) violated`)
  process.exit(1)
}
console.log('✅ PROJECT-CONFIG HOME CONTRACT HOLDS (.mercury is the home · external dirs never homes)')
