#!/usr/bin/env bun
// ============================================================================
//  scripts/splash/bake-menu.mjs — bake the startup-menu registry AND the
//  model display-name table into the enter-screen splash (paper-triad
//  Slice D; model names — the stale 'Opus 4.8' strip).
//
//  The splash is a standalone child process with no src imports, so its
//  src-owned facts are serialized between markers in the shared compose
//  core assets/splash/splash-core.mjs (ruling 1's split: both hosts import
//  the ONE owner) — the grid-bake idiom:
//    · MERCURY-MENU-START/END        ← src/substrate/startupMenu.ts (rows with
//      RESOLVED choice lists — the splash carries zero flag-kind logic);
//    · MERCURY-MODEL-NAMES-START/END ← src/utils/model owners
//      (getMarketingNameForModel · parseUserSpecifiedModel · renderModelSetting),
//      lowercased bare id/alias → display name. A hand-written family regex
//      here is exactly the STALE-COPY class prove-model-truth.ts hunts — the
//      splash showed 'Opus 4.8' for the claude-opus-5 settings pin.
//
//    bun run scripts/splash/bake-menu.mjs           # rewrite the blocks
//    bun run scripts/splash/bake-menu.mjs --check   # drift gate (run-all.sh)
//
//  --check exits 1 when any baked block differs from its owner — the
//  regen-wrapper pattern, so owner edits can never silently trail the
//  deployed splash.
// ============================================================================
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Ambient-state hygiene (proof-hygiene rule + the F6 law): the model
//    owners read provider/model env and the config home lazily, and the baked
//    OUTPUT must be byte-identical on every machine or --check flakes in the
//    pool. Pin the seams to the clean firstParty default BEFORE the owners
//    load — imports below are dynamic for exactly this ordering. ────────────
for (const k of [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
]) {
  delete process.env[k]
}
const scratchHome = mkdtempSync(join(tmpdir(), 'bake-menu-home-'))
for (const spelling of ['MERCURY_HOME', 'MERCURY_CONFIG_DIR']) {
  process.env[spelling] = scratchHome
}

const { STARTUP_MENU, menuRowChoices } = await import('../../src/substrate/startupMenu.ts')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')
const { ALL_MODEL_CONFIGS } = await import('../../src/utils/model/configs.ts')
const { MODEL_ALIASES } = await import('../../src/utils/model/aliases.ts')
const { getMarketingNameForModel, parseUserSpecifiedModel, renderModelSetting } =
  await import('../../src/utils/model/model.ts')

const SPLASH = join(import.meta.dir, '..', '..', 'assets', 'splash', 'splash-core.mjs')

function menuBlock() {
  const START = '// MERCURY-MENU-START'
  const END = '// MERCURY-MENU-END'
  const rows = STARTUP_MENU.map(row =>
    '  ' +
    JSON.stringify({
      env: row.env,
      // the retired spelling: pre-migration saved files and
      // operator env pins keep resolving on the enter screen
      legacy: getFlagSpec(row.env)?.legacy ?? null,
      label: row.label,
      group: row.group,
      summary: row.summary,
      // SETTING DETAIL pane content — the
      // splash renders it verbatim; absent detail degrades to summary-only.
      detail: row.detail ?? null,
      choices: menuRowChoices(row).map(c => ({ v: c.value, l: c.label })),
    }) +
    ',',
  )
  return {
    START,
    END,
    text:
      `${START} (baked by scripts/splash/bake-menu.mjs — from src/substrate/startupMenu.ts; do NOT hand-edit)\n` +
      `const MENU = [\n${rows.join('\n')}\n]\n` +
      END,
  }
}

function modelNamesBlock() {
  const START = '// MERCURY-MODEL-NAMES-START'
  const END = '// MERCURY-MODEL-NAMES-END'
  const names = {}
  // Every shipped firstParty id (the hand-wired tables) → its
  // owner-derived display name. Keys are lowercased and
  // bare — the splash strips [1m] before the lookup and re-suffixes ' (1M)'.
  for (const cfg of Object.values(ALL_MODEL_CONFIGS)) {
    const name = getMarketingNameForModel(cfg.firstParty)
    if (name) names[cfg.firstParty.toLowerCase()] = name
  }
  // Aliases resolve to what a session actually BOOTS (parseUserSpecifiedModel
  // — post-D-02a 'opus' means the catalogue Opus 5, not a frozen family
  // guess). opusplan stays its own setting name: its live model is
  // plan-mode-dependent, so a single resolved family label would lie.
  for (const alias of MODEL_ALIASES) {
    const bare = alias.replace(/\[1m\]$/i, '')
    if (names[bare]) continue
    names[bare] =
      bare === 'opusplan'
        ? renderModelSetting(bare)
        : (getMarketingNameForModel(parseUserSpecifiedModel(bare)) ?? bare)
  }
  const rows = Object.entries(names).map(([id, l]) => `  ${JSON.stringify(id)}: ${JSON.stringify(l)},`)
  return {
    START,
    END,
    text:
      `${START} (baked by scripts/splash/bake-menu.mjs — from src/utils/model owners; do NOT hand-edit)\n` +
      `const MODEL_NAMES = {\n${rows.join('\n')}\n}\n` +
      END,
  }
}

let src = readFileSync(SPLASH, 'utf8')
let drift = false
let changed = false

for (const block of [menuBlock(), modelNamesBlock()]) {
  const startIdx = src.indexOf(block.START)
  const endIdx = src.indexOf(block.END)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.error(`bake-menu: markers not found in ${SPLASH} — the splash must carry ${block.START} … ${block.END}`)
    process.exit(2)
  }
  const current = src.slice(startIdx, endIdx + block.END.length)
  if (current === block.text) continue
  drift = true
  if (!process.argv.includes('--check')) {
    src = src.slice(0, startIdx) + block.text + src.slice(endIdx + block.END.length)
    changed = true
  }
}

if (process.argv.includes('--check')) {
  if (!drift) {
    console.log('bake-menu --check: splash menu + model-name blocks match their owners')
    process.exit(0)
  }
  console.error('bake-menu --check: DRIFT — a src owner changed but the splash was not rebaked. Run: bun run scripts/splash/bake-menu.mjs')
  process.exit(1)
}

if (changed) {
  writeFileSync(SPLASH, src)
  console.log(`bake-menu: baked ${STARTUP_MENU.length} menu row(s) + the model-name table into ${SPLASH}`)
} else {
  console.log('bake-menu: already current')
}
