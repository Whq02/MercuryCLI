#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
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
  check('no saved effort in the scratch home', getInitialEffortSetting() === undefined)
  const s = await seeds()
  check("the seed reads 'high'", s.effortLevel === 'high', s.effortLevel)
  check('and it is the default', s.effortIsDefault === true)
  check('the dispatch carries no word (the daemon decides)', dispatchSeedInputs({}, getCwd(), 'claude-opus-5', getInitialEffortSetting()).effort === undefined)
}

console.log('S2 the operator saved max: the strip seeds max, the dispatch carries it')
{
  const written = updateSettingsForSource('userSettings', { effortLevel: 'max' })
  check('the saved default lands on disk', written.error === null, String(written.error))
  check('getInitialEffortSetting reads max back', getInitialEffortSetting() === 'max')
  const s = await seeds()
  check("the seed reads the operator's saved default, 'max'", s.effortLevel === 'max', s.effortLevel)
  check('and max IS the default now (the chip has nothing to say)', s.effortIsDefault === true)
  const si = dispatchSeedInputs({}, getCwd(), 'claude-opus-5', getInitialEffortSetting())
  check("the birth op carries 'max' with the chip untouched", si.effort === 'max', String(si.effort))
}

console.log('S3 the chip overrides the saved default for this birth alone')
{
  await writeConcourseSeedOverride({ effort: 'low' }, draftDir)
  const s = await seeds()
  check("the seed reads the chip's 'low'", s.effortLevel === 'low', s.effortLevel)
  check('and it is NOT the default (the chip paints)', s.effortIsDefault === false)
  check("the birth op carries the chip's word over the saved default", dispatchSeedInputs({ effort: 'low' }, getCwd(), 'claude-opus-5', 'max').effort === 'low')
  await writeConcourseSeedOverride({ effort: 'max' }, draftDir)
  const back = await seeds()
  check("a chip set to the saved level reads as the default again", back.effortLevel === 'max' && back.effortIsDefault === true)
  await writeConcourseSeedOverride({ effort: null }, draftDir)
  const cleared = await seeds()
  check('a cleared chip falls back to the saved default', cleared.effortLevel === 'max' && cleared.effortIsDefault === true)
}

console.log('S4 the two cockpit birth doors read the same rung')
{
  const route = readFileSync(join(import.meta.dir, '..', '..', 'src/components/concourse/ConcourseRoute.tsx'), 'utf8')
  check('the strip hands the saved default to dispatchSeedInputs beside the painted model', route.includes('dispatchSeedInputs(seeds, getCwd(), snapshotRef.current?.newSession.seeds.modelId, getInitialEffortSetting())'))
  const born = readFileSync(join(import.meta.dir, '..', '..', 'src/services/switchboard/bornSession.ts'), 'utf8')
  check("the boot face's birth door: the CLI word, else the saved default, else nothing (the daemon's convention)", born.includes('const effort = facts.effort ?? getInitialEffortSetting() ?? null') && born.includes('...(effort !== null ? { effort } : {})'))
  const supervisor = readFileSync(join(import.meta.dir, '..', '..', 'src/daemon/concourseSupervisor.ts'), 'utf8')
  check("the daemon's fallback stands as the last resort for an op that carries no word", supervisor.includes("effort: args.effort ?? 'high'"))
}

console.log(failures === 0 ? '\n✅ new chat effort seed GREEN' : `\n❌ new chat effort seed RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
