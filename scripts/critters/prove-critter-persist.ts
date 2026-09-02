#!/usr/bin/env bun
// ============================================================================
//  scripts/critters/prove-critter-persist.ts — the critter theme STICKS
//
//
//  The old picker: ↵ was session-only, a separate `s` persisted — nobody
//  found `s`, so every boot reverted. The contract now:
//    · ↵ switches AND persists (GlobalConfig.defaultCritter);
//    · `t` is the explicit session-only trial;
//    · boot resolution: MERCURY_CRITTER env pin > persisted default > the
//      code default (behavioral, via resolveInitialKey's exported seam);
//    · the code default IS the jellyfish (operator ruling: keep
//      exactly so) — pinned below by value;
//    · the SPLASH status strip reads the persisted default too (it used to
//      read only the env pin and always said Crab).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function t(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')

console.log('— the ↵ pick persists (source lock) —')
{
  const picker = src('src/components/CritterSelect.tsx')
  const ret = picker.slice(picker.indexOf("key: 'return'"), picker.indexOf("key: 't'"))
  t('↵ action calls setSessionCritter (live switch)', ret.includes('setSessionCritter(picked.key)'))
  t('↵ action calls persistSessionCritter (sticks across boots)', ret.includes('persistSessionCritter(picked.key)'))
  const trial = picker.slice(picker.indexOf("key: 't'"))
  t('`t` trial stays session-only (no persist call)', !trial.slice(0, trial.indexOf('hint:')).includes('persistSessionCritter'))
}

console.log('— hero-click morphs persist too (every entry point sticks) —')
{
  // The mounts hand their pointer seams the ONE owner
  // (cycleSessionCritter), whose body BOTH morphs and persists — a mount
  // can no longer cycle without sticking.
  const home = src('src/components/MercuryHome.tsx')
  t('the berth activate rides the one owner', home.includes('onActivate={cycleSessionCritter}'))
  t('the hero click rides the one owner', home.includes('onClick={cycleSessionCritter}'))
  const accent = src('src/components/mercury-ui/sessionAccent.ts')
  const cycle = accent.slice(
    accent.indexOf('export function cycleSessionCritter'),
    accent.indexOf('}', accent.indexOf('export function cycleSessionCritter')),
  )
  t('the one owner morphs live', cycle.includes('setSessionCritter(next.key)'))
  t('the one owner persists the pick', cycle.includes('persistSessionCritter(next.key)'))
}

console.log('— boot resolution honors the persisted default —')
{
  const accent = src('src/components/mercury-ui/sessionAccent.ts')
  const resolve = accent.slice(accent.indexOf('function currentKey'), accent.indexOf('const listeners'))
  const envIdx = resolve.indexOf("flagEnv('MERCURY_CRITTER')")
  const savedIdx = resolve.indexOf('defaultCritter')
  t('currentKey reads the env pin FIRST', envIdx > 0 && savedIdx > envIdx)
  t('…then the persisted defaultCritter', savedIdx > 0)
  const persist = accent.slice(accent.indexOf('function persistSessionCritter'))
  t('persistSessionCritter writes GlobalConfig.defaultCritter', persist.includes('defaultCritter: k'))
}

console.log('— BOOT ORDER (the day-one bug): module init precedes the latch —')
{
  // sessionAccent initializes at IMPORT time, before main() opens the config
  // latch (enableConfigs) — the eager resolveInitialKey always threw and
  // folded to the code default, so the persisted default was dead-on-boot
  // while the splash (which reads the file directly) showed the truth: "it
  // says octopus on boot, but the session loads crab". The lazy lock-in
  // contract: a pre-latch read serves the code default WITHOUT locking; the
  // post-latch read locks the persisted value. (re-cut: the pre-latch
  // pin reads DEFAULT_CRITTER_KEY instead of a literal — the operator moved
  // the default to jellyfish, and this leg's contract is the LATCH ORDER,
  // not the default's identity.) The fixture
  // persists CRAB — a non-default key — so the lock is provably the config
  // read, not the fallback (and an explicit pick still beats the default).
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'critter-bootorder-'))
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({ defaultCritter: 'crab' }))
  const prevHome = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = home
  try {
    const accent = await import('../../src/components/mercury-ui/sessionAccent.ts')
    const early = accent.getSessionCritterKey() // pre-latch — must NOT lock
    const cfg = await import('../../src/utils/config.ts')
    cfg.enableConfigs()
    const late = accent.getSessionCritterKey()
    const { DEFAULT_CRITTER_KEY } = await import('../../src/utils/cockpit/critterData.ts')
    t('pre-latch read serves the default (never throws)', early === DEFAULT_CRITTER_KEY, early)
    t('post-latch read locks the persisted critter', late === 'crab', late)
  } finally {
    if (prevHome === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = prevHome
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('— a SAVED defaultCritter naming the retired key resolves to the CLAM at read (never rewritten) —')
{
  // The mantis shrimp is retired and the clam holds its slot + family. A
  // config file persisted before the swap still says 'mantis' (or the pool
  // name 'mantis shrimp'); the read-side resolution must land BOTH halves
  // (tint key + shape def) on the clam, and the stored bytes must stay
  // exactly what the operator's file said — config values are never
  // heal-repainted. Each spelling probes in a FRESH child process because
  // sessionAccent locks its key once per process (the lazy lock-in).
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  for (const legacy of ['mantis', 'mantis shrimp']) {
    const home = mkdtempSync(join(tmpdir(), 'critter-legacy-'))
    try {
      const cfgPath = join(home, '.mercury.json')
      const before = JSON.stringify({ defaultCritter: legacy })
      writeFileSync(cfgPath, before)
      const probe = join(home, 'probe.ts')
      writeFileSync(
        probe,
        [
          `import { getSessionCritterKey } from ${JSON.stringify(join(ROOT, 'src/components/mercury-ui/sessionAccent.ts'))}`,
          `import { enableConfigs } from ${JSON.stringify(join(ROOT, 'src/utils/config.ts'))}`,
          `import { critterDefForKey } from ${JSON.stringify(join(ROOT, 'src/utils/cockpit/critterData.ts'))}`,
          'enableConfigs()',
          'const key = getSessionCritterKey()',
          'console.log(JSON.stringify({ key, shape: critterDefForKey(key).name }))',
        ].join('\n'),
      )
      const env = { ...process.env, MERCURY_CONFIG_DIR: home }
      delete env.MERCURY_CRITTER // the env pin would outrank the saved default
      const r = spawnSync(process.execPath, ['run', probe], { env, encoding: 'utf8' })
      let key = ''
      let shape = ''
      try {
        const parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { key?: string; shape?: string }
        key = parsed.key ?? ''
        shape = parsed.shape ?? ''
      } catch {
        /* fall through to the failing checks below with the raw output */
      }
      t(`saved '${legacy}' resolves the TINT key to the clam at read`, key === 'clam', key || r.stderr.slice(0, 200))
      t(`saved '${legacy}' resolves the SHAPE to the clam def`, shape === 'clam', shape)
      t(
        `the stored value still says '${legacy}' — read-side only, never rewritten`,
        readFileSync(cfgPath, 'utf8') === before,
        readFileSync(cfgPath, 'utf8'),
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

console.log('— the default critter is the jellyfish —')
{
  const { DEFAULT_CRITTER_KEY } = await import('../../src/utils/cockpit/critterData.ts')
  const { ALL_CRITTERS } = await import('../../src/components/mercury-ui/sessionAccent.ts')
  t('DEFAULT_CRITTER_KEY is jellyfish', DEFAULT_CRITTER_KEY === 'jellyfish', DEFAULT_CRITTER_KEY)
  t('the jellyfish is a real creature in the pool', ALL_CRITTERS.some(c => c.key === 'jellyfish'))
  const accent = src('src/components/mercury-ui/sessionAccent.ts')
  t('the boot resolver falls back to DEFAULT_CRITTER_KEY, never a literal', accent.includes('DEFAULT_CRITTER_KEY') && !/\?\? 'octopus'|\?\? 'crab'/.test(accent))
}

console.log('— the splash strip reads the persisted default —')
{
  const splash = src('assets/splash/mercury-splash.mjs')
  const label = splash.slice(splash.indexOf('function computeCritterKey'), splash.indexOf('function accountLabel'))
  t('splash critterLabel checks the env pin', label.includes('MERCURY_CRITTER'))
  t('splash critterLabel falls back to the config-home defaultCritter', label.includes('defaultCritter'))
  t('splash config read is guarded (absent/malformed ⇒ crab)', label.includes('catch'))
}

console.log()
if (failures > 0) {
  console.log(`❌ CRITTER-PERSIST RED (${failures})`)
  process.exit(1)
}
console.log('✅ CRITTER-PERSIST GREEN')
