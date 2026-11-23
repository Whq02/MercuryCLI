#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function t(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')



console.log('— BOOT ORDER (the day-one bug): module init precedes the latch —')
{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'critter-bootorder-'))
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({ defaultCritter: 'jellyfish' }))
  const prevHome = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = home
  try {
    const accent = await import('../../src/screen/widgets/sessionAccent.ts')
    const early = accent.getSessionCritterKey()
    const cfg = await import('../../src/platform/settings/config.ts')
    cfg.enableConfigs()
    const late = accent.getSessionCritterKey()
    const { DEFAULT_CRITTER_KEY } = await import('../../src/screen/cockpit/critterData.ts')
    t('pre-latch read serves the default (never throws)', early === DEFAULT_CRITTER_KEY, early, 'change currentKey in src/screen/widgets/sessionAccent.ts so a read before enableConfigs() in src/platform/settings/config.ts returns DEFAULT_CRITTER_KEY (src/screen/cockpit/critterData.ts) without throwing')
    t('post-latch read locks the persisted critter', late === 'jellyfish', late, 'change currentKey in src/screen/widgets/sessionAccent.ts to read getGlobalConfig().defaultCritter once enableConfigs() has run, and not to keep the default from the earlier read in activeKey')
  } finally {
    if (prevHome === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = prevHome
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('— a SAVED defaultCritter the pool does not know resolves to the DEFAULT at read (never rewritten) —')
{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  for (const legacy of ['dragon', 'hermit crab']) {
    const home = mkdtempSync(join(tmpdir(), 'critter-unknown-'))
    try {
      const cfgPath = join(home, '.mercury.json')
      const before = JSON.stringify({ defaultCritter: legacy })
      writeFileSync(cfgPath, before)
      const probe = join(home, 'probe.ts')
      writeFileSync(
        probe,
        [
          `import { getSessionCritterKey } from ${JSON.stringify(join(ROOT, 'src/screen/widgets/sessionAccent.ts'))}`,
          `import { enableConfigs } from ${JSON.stringify(join(ROOT, 'src/platform/settings/config.ts'))}`,
          `import { critterDefForKey } from ${JSON.stringify(join(ROOT, 'src/screen/cockpit/critterData.ts'))}`,
          'enableConfigs()',
          'const key = getSessionCritterKey()',
          'console.log(JSON.stringify({ key, shape: critterDefForKey(key).name }))',
        ].join('\n'),
      )
      const env = { ...process.env, MERCURY_CONFIG_DIR: home }
      delete env.MERCURY_CRITTER
      const r = spawnSync(process.execPath, ['run', probe], { env, encoding: 'utf8' })
      let key = ''
      let shape = ''
      try {
        const parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { key?: string; shape?: string }
        key = parsed.key ?? ''
        shape = parsed.shape ?? ''
      } catch {
      }
      t(`saved '${legacy}' resolves the TINT key to the pool default at read`, key === 'crab', key || r.stderr.slice(0, 200), 'change poolKeyOr in src/screen/widgets/sessionAccent.ts so a saved defaultCritter outside the pool resolves to DEFAULT_CRITTER_KEY; an empty value means the probe script failed, so read the stderr shown')
      t(`saved '${legacy}' resolves the SHAPE to the pool default def`, shape === 'crab', shape, 'change resolvePoolKey or critterDefForKey in src/screen/cockpit/critterData.ts so an unknown key returns the DEFAULT_CRITTER_KEY def')
      t(
        `the stored value still says '${legacy}' — read-side only, never rewritten`,
        readFileSync(cfgPath, 'utf8') === before,
        readFileSync(cfgPath, 'utf8'),
        'the read path (currentKey in src/screen/widgets/sessionAccent.ts) must not write defaultCritter back; look for a saveGlobalConfig call on the read path')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

console.log('— the default critter is the crab —')
{
  const { DEFAULT_CRITTER_KEY } = await import('../../src/screen/cockpit/critterData.ts')
  const { ALL_CRITTERS } = await import('../../src/screen/widgets/sessionAccent.ts')
  t('DEFAULT_CRITTER_KEY is crab', DEFAULT_CRITTER_KEY === 'crab', DEFAULT_CRITTER_KEY, 'set DEFAULT_CRITTER_KEY back to crab in src/screen/cockpit/critterData.ts')
  t('the crab is a real creature in the pool', ALL_CRITTERS.some(c => c.key === 'crab'), '', 'add a crab entry to ALL_CRITTERS in src/screen/widgets/sessionAccent.ts (listed from the CRITTERS table in the same file)')
}


console.log()
if (failures > 0) {
  console.log(`❌ CRITTER-PERSIST RED (${failures})`)
  process.exit(1)
}
console.log('✅ CRITTER-PERSIST GREEN')
