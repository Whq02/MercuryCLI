#!/usr/bin/env bun
// ============================================================================
//  scripts/model-registry/prove-no-speculative-catalog.ts
//
//  THE RATCHET: no speculative-model table may return — the CLASS, not just
//  the one retired file. A speculative table is a static registry of
//  first-party model entries carrying a futurity/availability vocabulary
//  ('coming-soon' rows, forced-live env flips, a frontier-succession rank
//  seam). Models are hand rows in the ratified owners (configs/display/
//  costs/effort/windows/cutoff) or live provider-catalogue rows; the
//  built-in foreground default changes when the OPERATOR names it, never
//  through an anticipatory registration.
//
//  Run: ~/.bun/bin/bun run scripts/model-registry/prove-no-speculative-catalog.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

/** Tracked-source grep (git grep — tracked files only, deterministic). */
function trackedHits(pattern: string, pathspec: string): string[] {
  try {
    const outBuf = execFileSync('git', ['grep', '-l', '-E', pattern, '--', pathspec], {
      cwd: repoRoot,
    })
    return outBuf.toString().trim().split('\n').filter(Boolean)
  } catch {
    return [] // git grep exits 1 on zero matches
  }
}

console.log('§1 the retired table and its vocabulary stay out of src/')
{
  check(
    'src/utils/model/futureModelCatalog.ts does not exist',
    !existsSync(join(repoRoot, 'src/utils/model/futureModelCatalog.ts')),
  )
  const idHits = trackedHits('futureModel|FutureModel|FUTURE_MODEL_CATALOG|findLiveFutureModel|comingSoonFutureModels|liveFutureModels', 'src/')
  check('no future-model identifier survives in src/', idHits.length === 0, idHits.join(' '))
  const comingSoon = trackedHits('coming-soon', 'src/')
  check("the 'coming-soon' vocabulary is absent from src/", comingSoon.length === 0, comingSoon.join(' '))
  const rankSeam = trackedHits('frontierForeground', 'src/')
  check('no frontier-succession registration seam in src/', rankSeam.length === 0, rankSeam.join(' '))
}

console.log('§2 the retired flags are gone — registry and consumers')
{
  const registry = readFileSync(join(repoRoot, 'src/substrate/flagRegistry.ts'), 'utf8')
  for (const flag of ['MERCURY_FUTURE_MODEL', 'MERCURY_FUTURE_MODEL_DISABLE', 'MERCURY_SHOW_COMING_SOON']) {
    check(`${flag} absent from the flag registry`, !registry.includes(`'${flag}'`))
  }
  const envReads = trackedHits('MERCURY_FUTURE_MODEL|MERCURY_SHOW_COMING_SOON', 'src/')
  check('no src consumer reads the retired flags', envReads.length === 0, envReads.join(' '))
}

console.log('§3 the promoted rows live in the ratified owners (the removal orphaned nothing)')
{
  const { ALL_MODEL_CONFIGS } = await import('../../src/utils/model/configs.js')
  check(
    "configs carries sonnet5/opus5 hand rows ('claude-sonnet-5' / 'claude-opus-5')",
    ALL_MODEL_CONFIGS.sonnet5?.firstParty === 'claude-sonnet-5' &&
      ALL_MODEL_CONFIGS.opus5?.firstParty === 'claude-opus-5',
  )
  const { getDefaultOpusModel, getDefaultSonnetModel, getCanonicalName, getMarketingNameForModel } =
    await import('../../src/utils/model/model.js')
  for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL']) delete process.env[k]
  check("getDefaultOpusModel() = 'claude-opus-5'", getDefaultOpusModel() === 'claude-opus-5', getDefaultOpusModel())
  check("getDefaultSonnetModel() = 'claude-sonnet-5'", getDefaultSonnetModel() === 'claude-sonnet-5', getDefaultSonnetModel())
  check(
    'the promoted ids are their own canonicals with owner display names',
    getCanonicalName('claude-sonnet-5') === 'claude-sonnet-5' &&
      getCanonicalName('claude-opus-5') === 'claude-opus-5' &&
      getMarketingNameForModel('claude-sonnet-5') === 'Sonnet 5' &&
      getMarketingNameForModel('claude-opus-5') === 'Opus 5',
  )
}

console.log('§4 the built artifact carries none of the retired vocabulary')
{
  const dist = join(repoRoot, 'dist', 'mercury.mjs')
  if (existsSync(dist)) {
    const bundle = readFileSync(dist, 'utf8')
    check('dist/mercury.mjs: no FUTURE_MODEL_CATALOG', !bundle.includes('FUTURE_MODEL_CATALOG'))
    check("dist/mercury.mjs: no 'coming-soon' vocabulary", !bundle.includes('coming-soon'))
    check('dist/mercury.mjs: no MERCURY_FUTURE_MODEL flag read', !bundle.includes('MERCURY_FUTURE_MODEL'))
  } else {
    console.log('  [....] dist/mercury.mjs not built in this checkout — source legs above still hold')
  }
}

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ no-speculative-catalog ratchet: all checks pass')
