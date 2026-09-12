#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const k of [
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_DEFAULT_HAIKU_MODEL',
  'MERCURY_MODEL',
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

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const blockRange = (text, block) => {
  const m = new RegExp(`^${escapeRe(block.head)}\\n[\\s\\S]*?^${escapeRe(block.close)}$`, 'm').exec(text)
  return m === null ? null : { start: m.index, end: m.index + m[0].length }
}

function menuBlock() {
  const head = 'const MENU = ['
  const close = ']'
  const rows = STARTUP_MENU.map(row =>
    '  ' +
    JSON.stringify({
      env: row.env,
      legacy: getFlagSpec(row.env)?.legacy ?? null,
      label: row.label,
      group: row.group,
      summary: row.summary,
      detail: row.detail ?? null,
      defaultFollows: row.defaultFollows ?? null,
      choices: menuRowChoices(row).map(c => ({ v: c.value, l: c.label })),
    }) +
    ',',
  )
  return { head, close, text: `${head}\n${rows.join('\n')}\n${close}` }
}

function modelNamesBlock() {
  const head = 'const MODEL_NAMES = {'
  const close = '}'
  const names = {}
  for (const cfg of Object.values(ALL_MODEL_CONFIGS)) {
    const name = getMarketingNameForModel(cfg.firstParty)
    if (name) names[cfg.firstParty.toLowerCase()] = name
  }
  for (const alias of MODEL_ALIASES) {
    const bare = alias.replace(/\[1m\]$/i, '')
    if (names[bare]) continue
    names[bare] =
      bare === 'opusplan'
        ? renderModelSetting(bare)
        : (getMarketingNameForModel(parseUserSpecifiedModel(bare)) ?? bare)
  }
  const rows = Object.entries(names).map(([id, l]) => `  ${JSON.stringify(id)}: ${JSON.stringify(l)},`)
  return { head, close, text: `${head}\n${rows.join('\n')}\n${close}` }
}

let src = readFileSync(SPLASH, 'utf8')
let drift = false
let changed = false

for (const block of [menuBlock(), modelNamesBlock()]) {
  const range = blockRange(src, block)
  if (range === null) {
    console.error(`bake-menu: declaration not found in ${SPLASH} — the splash must carry ${block.head} … ${block.close}`)
    process.exit(2)
  }
  const current = src.slice(range.start, range.end)
  if (current === block.text) continue
  drift = true
  if (!process.argv.includes('--check')) {
    src = src.slice(0, range.start) + block.text + src.slice(range.end)
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
