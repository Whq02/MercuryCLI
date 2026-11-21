#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchHome = mkdtempSync(join(tmpdir(), 'chat-effort-seed-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function effortHintOnFail(ok: boolean, detail: string, hint: string): string {
  return ok ? detail : `${detail}${detail ? ' — ' : ''}${hint}`
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
const { getInitialEffortSetting } = await import('../../src/utils/effort.js')
const { buildConcourseSnapshot, dispatchSeedInputs, writeConcourseSeedOverride } = await import('../../src/services/concourse/concourseSnapshot.js')
const { getCwd } = await import('../../src/utils/cwd.js')

const recordsDir = join(scratchHome, 'daemon')
const crewDir = join(scratchHome, 'crew')
const draftDir = join(scratchHome, 'drafts')
for (const dir of [recordsDir, crewDir, draftDir]) mkdirSync(dir, { recursive: true })
const seeds = async () => (await buildConcourseSnapshot({ recordsDir, crewDir, draftDir })).newSession.seeds

console.log('S1 nothing saved: the strip seeds the daemon convention and calls it the default')
{
  check('no saved effort in the scratch home', getInitialEffortSetting() === undefined, effortHintOnFail(getInitialEffortSetting() === undefined, '', 'getInitialEffortSetting in src/utils/effort.ts must read undefined when the scratch home has no saved engine.effort'))
  const s = await seeds()
  check("the seed reads 'high'", s.effortLevel === 'high', effortHintOnFail(s.effortLevel === 'high', s.effortLevel, 'the new-session seeds in buildConcourseSnapshot (src/services/concourse/concourseSnapshot.ts) must seed high when no effort is saved'))
  check('and it is the default', s.effortIsDefault === true, effortHintOnFail(s.effortIsDefault === true, '', 'effortIsDefault in the new-session seeds of buildConcourseSnapshot (src/services/concourse/concourseSnapshot.ts) must be true when no chip override exists'))
  check('the dispatch carries no word (the daemon decides)', dispatchSeedInputs({}, getCwd(), 'claude-opus-5', getInitialEffortSetting()).effort === undefined, 'dispatchSeedInputs in src/services/concourse/concourseSnapshot.ts must leave effort unset when nothing is saved and the chip is untouched')
}

console.log('S2 the operator saved max: the strip seeds max, the dispatch carries it')
{
  const written = updateSettingsForSource('userSettings', { engine: { effort: 'max' } })
  check('the saved default lands on disk', written.error === null, effortHintOnFail(written.error === null, String(written.error), 'updateSettingsForSource (src/utils/settings/settings.ts) refused to write engine.effort to the scratch userSettings'))
  check('getInitialEffortSetting reads max back', getInitialEffortSetting() === 'max', effortHintOnFail(getInitialEffortSetting() === 'max', '', 'getInitialEffortSetting in src/utils/effort.ts must read back the saved engine.effort'))
  const s = await seeds()
  check("the seed reads the operator's saved default, 'max'", s.effortLevel === 'max', effortHintOnFail(s.effortLevel === 'max', s.effortLevel, 'the new-session seeds in buildConcourseSnapshot (src/services/concourse/concourseSnapshot.ts) must seed the saved default effort'))
  check('and max IS the default now (the chip has nothing to say)', s.effortIsDefault === true, effortHintOnFail(s.effortIsDefault === true, '', 'effortIsDefault in buildConcourseSnapshot (src/services/concourse/concourseSnapshot.ts) must be true when the seed equals the saved default'))
  const si = dispatchSeedInputs({}, getCwd(), 'claude-opus-5', getInitialEffortSetting())
  check("the birth op carries 'max' with the chip untouched", si.effort === 'max', effortHintOnFail(si.effort === 'max', String(si.effort), 'dispatchSeedInputs in src/services/concourse/concourseSnapshot.ts must carry the saved effort into the birth op'))
}

console.log('S3 the chip overrides the saved default for this birth alone')
{
  await writeConcourseSeedOverride({ effort: 'low' }, draftDir)
  const s = await seeds()
  check("the seed reads the chip's 'low'", s.effortLevel === 'low', effortHintOnFail(s.effortLevel === 'low', s.effortLevel, 'buildConcourseSnapshot (src/services/concourse/concourseSnapshot.ts) must read the override written by writeConcourseSeedOverride'))
  check('and it is NOT the default (the chip paints)', s.effortIsDefault === false, effortHintOnFail(s.effortIsDefault === false, '', 'effortIsDefault in buildConcourseSnapshot (src/services/concourse/concourseSnapshot.ts) must be false when the chip differs from the saved default'))
  check("the birth op carries the chip's word over the saved default", dispatchSeedInputs({ effort: 'low' }, getCwd(), 'claude-opus-5', 'max').effort === 'low', 'dispatchSeedInputs in src/services/concourse/concourseSnapshot.ts must prefer the chip effort over the saved default')
  await writeConcourseSeedOverride({ effort: 'max' }, draftDir)
  const back = await seeds()
  check("a chip set to the saved level reads as the default again", back.effortLevel === 'max' && back.effortIsDefault === true, effortHintOnFail(back.effortLevel === 'max' && back.effortIsDefault === true, '', 'buildConcourseSnapshot (src/services/concourse/concourseSnapshot.ts) must set effortIsDefault true when the chip equals the saved level'))
  await writeConcourseSeedOverride({ effort: null }, draftDir)
  const cleared = await seeds()
  check('a cleared chip falls back to the saved default', cleared.effortLevel === 'max' && cleared.effortIsDefault === true, effortHintOnFail(cleared.effortLevel === 'max' && cleared.effortIsDefault === true, '', 'writeConcourseSeedOverride with effort null (src/services/concourse/concourseSnapshot.ts) must clear the chip so the saved default shows'))
}


console.log(failures === 0 ? '\n✅ new chat effort seed GREEN' : `\n❌ new chat effort seed RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
