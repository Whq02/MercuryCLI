#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchHome = mkdtempSync(join(tmpdir(), 'chat-effort-seed-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
const HINT_SEED = 'fix the effort seed in buildConcourseSnapshot (newSession.seeds) in src/screen/concourse-model/concourseSnapshot.ts'
const HINT_DISPATCH = 'fix dispatchSeedInputs in src/screen/concourse-model/concourseSnapshot.ts'

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/platform/settings/settings.js')
const { getInitialEffortSetting } = await import('../../src/models/effort/effort.js')
const { buildConcourseSnapshot, dispatchSeedInputs, writeConcourseSeedOverride } = await import('../../src/screen/concourse-model/concourseSnapshot.js')
const { getCwd } = await import('../../src/platform/files/cwd.js')

const recordsDir = join(scratchHome, 'daemon')
const crewDir = join(scratchHome, 'crew')
const draftDir = join(scratchHome, 'drafts')
for (const dir of [recordsDir, crewDir, draftDir]) mkdirSync(dir, { recursive: true })
const seeds = async () => (await buildConcourseSnapshot({ recordsDir, crewDir, draftDir })).newSession.seeds

console.log('S1 nothing saved: the strip seeds the daemon convention and calls it the default')
{
  check('no saved effort in the scratch home', getInitialEffortSetting() === undefined, '', 'the scratch home must hold no saved effort; getInitialEffortSetting is in src/models/effort/effort.ts')
  const s = await seeds()
  check("the seed reads 'high'", s.effortLevel === 'high', s.effortLevel, HINT_SEED)
  check('and it is the default', s.effortIsDefault === true, '', HINT_SEED)
  check('the dispatch carries no word (the daemon decides)', dispatchSeedInputs({}, getCwd(), 'claude-opus-5', getInitialEffortSetting()).effort === undefined, '', HINT_DISPATCH)
}

console.log('S2 the operator saved max: the strip seeds max, the dispatch carries it')
{
  const written = updateSettingsForSource('userSettings', { engine: { effort: 'max' } })
  check('the saved default lands on disk', written.error === null, String(written.error), 'updateSettingsForSource in src/platform/settings/settings.ts refused the engine.effort write to the scratch config home')
  check('getInitialEffortSetting reads max back', getInitialEffortSetting() === 'max', '', 'fix getInitialEffortSetting in src/models/effort/effort.ts so it reads the saved engine.effort')
  const s = await seeds()
  check("the seed reads the operator's saved default, 'max'", s.effortLevel === 'max', s.effortLevel, HINT_SEED)
  check('and max IS the default now (the chip has nothing to say)', s.effortIsDefault === true, '', HINT_SEED)
  const si = dispatchSeedInputs({}, getCwd(), 'claude-opus-5', getInitialEffortSetting())
  check("the birth op carries 'max' with the chip untouched", si.effort === 'max', String(si.effort), HINT_DISPATCH)
}

console.log('S3 the chip overrides the saved default for this birth alone')
{
  await writeConcourseSeedOverride({ effort: 'low' }, draftDir)
  const s = await seeds()
  check("the seed reads the chip's 'low'", s.effortLevel === 'low', s.effortLevel, HINT_SEED)
  check('and it is NOT the default (the chip paints)', s.effortIsDefault === false, '', HINT_SEED)
  check("the birth op carries the chip's word over the saved default", dispatchSeedInputs({ effort: 'low' }, getCwd(), 'claude-opus-5', 'max').effort === 'low', '', HINT_DISPATCH)
  await writeConcourseSeedOverride({ effort: 'max' }, draftDir)
  const back = await seeds()
  check("a chip set to the saved level reads as the default again", back.effortLevel === 'max' && back.effortIsDefault === true, '', HINT_SEED)
  await writeConcourseSeedOverride({ effort: null }, draftDir)
  const cleared = await seeds()
  check('a cleared chip falls back to the saved default', cleared.effortLevel === 'max' && cleared.effortIsDefault === true, '', HINT_SEED)
}


console.log(failures === 0 ? '\n✅ new chat effort seed GREEN' : `\n❌ new chat effort seed RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
