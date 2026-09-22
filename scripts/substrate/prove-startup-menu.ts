#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const MK = 'MACRO' as const
const setStamp = (on: boolean) => {
  if (on) (globalThis as Record<string, unknown>)[MK] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MK]
}

setStamp(true)
const scratch = mkdtempSync(join(tmpdir(), 'startup-menu-'))
process.chdir(scratch)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
for (const k of ['MERCURY_ENTER_MENU', 'MERCURY_CAP_FAILOVER', 'MERCURY_MNEME']) {
  delete process.env[k]
}

const { STARTUP_MENU, allSettingRows, menuRowChoices, menuRowValueLabel, applyBootMenuEnv, BOOT_ENV_VERSION, resolveComputerAccess, computerAccessDefaultLabel, resolveEffectiveSettingsSnapshot } = await import('../../src/substrate/startupMenu.js')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')

console.log('============================================================')
console.log(' startup menu — registry + boot-env applier proof')
console.log('============================================================')

section('registry floor — rows ⊆ FLAG_REGISTRY, sane choices')
{
  const unregistered = STARTUP_MENU.filter(r => getFlagSpec(r.env) === undefined).map(r => r.env)
  check('every menu row is a registered flag', unregistered.length === 0, unregistered.join(','))
  check('rows are unique by env', new Set(STARTUP_MENU.map(r => r.env)).size === STARTUP_MENU.length)
  check('every row resolves ≥2 choices with leave-unset FIRST',
    STARTUP_MENU.every(r => {
      const c = menuRowChoices(r)
      return c.length >= 2 && c[0]!.value === null && c.slice(1).every(x => typeof x.value === 'string')
    }))
  check('toggle rows carry exactly one non-default value', STARTUP_MENU.filter(r => r.kind === 'toggle').every(r => r.options.length === 1))
  check('the memory knob is present', STARTUP_MENU.some(r => r.env === 'MERCURY_MNEME'))
  check('the trust combo is the wards, the debugger, the C/C++ lane, Sovereign mode and Autopilot — no other row stands between a tool call and its run',
    STARTUP_MENU.filter(r => r.group === 'trust combo').map(r => r.env).join(',') === 'MERCURY_WARDS,MERCURY_DAP,MERCURY_LSP_CPP,MERCURY_SKIP_PERMISSIONS,MERCURY_AUTOPILOT', STARTUP_MENU.filter(r => r.group === 'trust combo').map(r => r.env).join(','))
  const missions = STARTUP_MENU.filter(r => r.group === 'memory & missions')
  check('the memory & missions group is the one MNEME row and nothing else', missions.length === 1 && missions[0]!.env === 'MERCURY_MNEME', missions.map(r => r.env).join(','))
  check('no row offers a whole-repository build or a standing planner or builder model pick (label, summary and detail)',
    !STARTUP_MENU.some(r => /repo(sitory)?[ -]?gen/i.test(r.label + r.summary + (r.detail?.controls ?? '') + (r.detail?.on ?? []).join(' ') + (r.detail?.off ?? []).join(' '))))
  check('the IDE lane rows are present (clangd visible-ON · godot arm-OFF)',
    STARTUP_MENU.some(r => r.env === 'MERCURY_LSP_CPP' && r.defaultLabel === 'on') &&
    STARTUP_MENU.some(r => r.env === 'MERCURY_GODOT' && r.defaultLabel === 'off'))
  const computerAt = STARTUP_MENU.findIndex(r => r.env === 'MERCURY_COMPUTER_USE')
  check('the computer-use row is a toggle, on by default, off its one value',
    computerAt >= 0 && STARTUP_MENU[computerAt]!.kind === 'toggle' && STARTUP_MENU[computerAt]!.defaultLabel === 'on' && STARTUP_MENU[computerAt]!.options.join(',') === '0')
  const accessAt = STARTUP_MENU.findIndex(r => r.env === 'MERCURY_COMPUTER_ACCESS')
  const access = STARTUP_MENU[accessAt]
  check('the access-type row sits directly under it in the same group: an enum of asks, permissive, full — asks by default',
    accessAt === computerAt + 1 && access !== undefined && access.group === STARTUP_MENU[computerAt]!.group && access.label === 'Access type' && access.kind === 'enum' && access.defaultLabel === 'asks' && access.options.join(',') === 'asks,permissive,full')
  check('both computer rows reach new sessions (no live class)', STARTUP_MENU[computerAt]!.applicationClass === undefined && access?.applicationClass === undefined)
  check('the access-type foot line says what each value does',
    access?.summary === 'asks: the first act in each application asks · permissive: the application in front when the turn began never asks, any other asks once · full: nothing asks', access?.summary)
  check('its detail says the same in full and that the default follows Sovereign mode, a saved value winning',
    /asks \(the default\)/.test(access?.detail?.controls ?? '') && /permissive:/.test(access?.detail?.controls ?? '') && /full: nothing asks/.test(access?.detail?.controls ?? '') && (access?.detail?.controls ?? '').includes('With Sovereign mode on the default is full; a saved value here wins'))
  check("its unset default follows the Sovereign mode row's on value, with the resolver's own label",
    access?.defaultFollows?.env === 'MERCURY_SKIP_PERMISSIONS' && access?.defaultFollows?.value === '1' && access?.defaultFollows?.label === 'default (full · sovereign mode)', JSON.stringify(access?.defaultFollows))
  check('the resolver: unset follows the posture — asks with Sovereign mode off, full with it on',
    JSON.stringify(resolveComputerAccess(null, false)) === JSON.stringify({ value: 'asks', source: 'default' }) && JSON.stringify(resolveComputerAccess(undefined, true)) === JSON.stringify({ value: 'full', source: 'sovereign mode' }))
  check('the resolver: a saved value wins in both postures',
    ['asks', 'permissive', 'full'].every(v => [false, true].every(on => JSON.stringify(resolveComputerAccess(v, on)) === JSON.stringify({ value: v, source: 'saved' }))))
  check("the resolver: the earlier value 'sovereign' is foreign and the default applies in each posture",
    JSON.stringify(resolveComputerAccess('sovereign', false)) === JSON.stringify({ value: 'asks', source: 'default' }) && JSON.stringify(resolveComputerAccess('sovereign', true)) === JSON.stringify({ value: 'full', source: 'sovereign mode' }))
  check('the default labels come from the resolver: default (asks) with the posture off, default (full · sovereign mode) with it on',
    computerAccessDefaultLabel(false) === 'default (asks)' && menuRowChoices(access!)[0]!.label === 'default (asks)' && computerAccessDefaultLabel(true) === 'default (full · sovereign mode)')
  const accessLabel = (saved: string | null, sovereign: string | null): string => menuRowValueLabel(access!, saved, env => (env === 'MERCURY_SKIP_PERMISSIONS' ? sovereign : null))
  check('the value column: unset reads the derived default of its posture; a saved value reads itself in either posture',
    accessLabel(null, null) === 'default (asks)' && accessLabel(null, '1') === 'default (full · sovereign mode)' && accessLabel('asks', '1') === 'asks' && accessLabel('permissive', null) === 'permissive' && accessLabel('full', '1') === 'full' && accessLabel('full', null) === 'full')
  check('every other row reads its plain default through the same helper', STARTUP_MENU.filter(r => r.env !== 'MERCURY_COMPUTER_ACCESS').every(r => menuRowValueLabel(r, null, () => '1') === menuRowChoices(r)[0]!.label))
  const sovereign = STARTUP_MENU.find(r => r.env === 'MERCURY_SKIP_PERMISSIONS')
  check('the Sovereign mode row is the trust combo\'s bypass toggle, off by default, on its one value',
    sovereign !== undefined && sovereign.label === 'Sovereign mode' && sovereign.group === 'trust combo' && sovereign.kind === 'toggle' && sovereign.defaultLabel === 'off' && sovereign.options.join(',') === '1')
  check('its foot line says no permission question is asked — files, commands, computer use',
    sovereign?.summary === 'no permission question is asked — not for files, commands, or computer use; you take the wheel', sovereign?.summary)
  check('its detail names computer use among what stops asking', /computer use/.test(sovereign?.detail?.controls ?? '') && (sovereign?.detail?.on ?? []).some(l => /computer use included/.test(l)))
  check('no other row carries the sovereign name', STARTUP_MENU.filter(r => /sovereign/i.test(r.label)).length === 1)
  const samplesAt = STARTUP_MENU.findIndex(r => r.env === 'MERCURY_SAMPLES')
  check('the samples row is a toggle, off by default, 1 its one value, in its own group directly after the access-type row',
    samplesAt === accessAt + 1 && STARTUP_MENU[samplesAt]!.kind === 'toggle' && STARTUP_MENU[samplesAt]!.defaultLabel === 'off' && STARTUP_MENU[samplesAt]!.options.join(',') === '1' && STARTUP_MENU[samplesAt]!.group === 'samples' && STARTUP_MENU[samplesAt]!.label === 'Samples' && STARTUP_MENU[samplesAt]!.applicationClass === undefined)
  check('the samples row\'s foot line says what a sample is', /a page the model draws when you ask to see something/.test(STARTUP_MENU[samplesAt]?.summary ?? '') && /your marks/.test(STARTUP_MENU[samplesAt]?.summary ?? ''))
  const enterMenu = getFlagSpec('MERCURY_ENTER_MENU')
  check('MERCURY_ENTER_MENU registered default-on / infra, consumed by the applier',
    enterMenu?.kind === 'default-on' && enterMenu?.tier === 'infra' && enterMenu?.consumer === 'src/substrate/startupMenu.ts')
}

section('command-owned setting rows — the /caching dial law')
{
  const { COMMAND_SETTINGS_ROWS, allSettingRows, writeBootEnvChoice, readBootEnvChoices } =
    await import('../../src/substrate/startupMenu.js')
  check('every command row is a registered flag',
    COMMAND_SETTINGS_ROWS.every(r => getFlagSpec(r.env) !== undefined))
  check('command rows are disjoint from the menu',
    COMMAND_SETTINGS_ROWS.every(r => !STARTUP_MENU.some(m => m.env === r.env)))
  check('every command row resolves ≥2 choices with leave-unset FIRST',
    COMMAND_SETTINGS_ROWS.every(r => {
      const c = menuRowChoices(r)
      return c.length >= 2 && c[0]!.value === null
    }))
  check('MERCURY_CACHE_TTL is a command-owned row, not a boot-menu row',
    !STARTUP_MENU.some(r => r.env === 'MERCURY_CACHE_TTL'))
  const ttl = COMMAND_SETTINGS_ROWS.find(r => r.env === 'MERCURY_CACHE_TTL')
  check('MERCURY_CACHE_TTL survives as a command-owned row (enum 5m/1h, default adaptive)',
    ttl !== undefined && ttl.kind === 'enum' && ttl.options.join(',') === '5m,1h' && ttl.defaultLabel === 'adaptive')
  check("the row names its writer (/caching)", `${ttl?.summary ?? ''} ${ttl?.group ?? ''}`.includes('/caching'))
  check('the union resolver answers menu + command rows exactly once each',
    allSettingRows().length === STARTUP_MENU.length + COMMAND_SETTINGS_ROWS.length &&
    new Set(allSettingRows().map(r => r.env)).size === allSettingRows().length)
  const cmdFile = join(scratch, 'boot-env-cmd.json')
  writeFileSync(cmdFile, JSON.stringify({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_CACHE_TTL: '1h' } }))
  const cmdEnv: NodeJS.ProcessEnv = {}
  const cmdApplied = applyBootMenuEnv(cmdFile, cmdEnv)
  check('a saved dial choice APPLIES at boot (union law)',
    cmdApplied !== null && cmdApplied.applied.some(a => a.env === 'MERCURY_CACHE_TTL') && cmdEnv.MERCURY_CACHE_TTL === '1h')
  writeFileSync(cmdFile, JSON.stringify({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_CACHE_TTL: 'forever' } }))
  const badEnv: NodeJS.ProcessEnv = {}
  const badApplied = applyBootMenuEnv(cmdFile, badEnv)
  check('a foreign dial value still refuses (value validation holds)',
    badApplied !== null && badApplied.refused.length === 1 && Object.keys(badEnv).length === 0)
  const wFile = join(scratch, 'boot-env-writer.json')
  const w1 = writeBootEnvChoice('MERCURY_CACHE_TTL', '1h', wFile)
  check('the dial write commits through the profile writer', w1.ok === true)
  const w2 = writeBootEnvChoice('MERCURY_CAP_FAILOVER', 'auto', wFile)
  const savedAfter = readBootEnvChoices(wFile) ?? {}
  check('a later menu-row write PRESERVES the saved dial choice',
    w2.ok === true && savedAfter.MERCURY_CACHE_TTL === '1h' && savedAfter.MERCURY_CAP_FAILOVER === 'auto')
  const wBad = writeBootEnvChoice('MERCURY_CACHE_TTL', 'forever', wFile)
  check('the writer refuses a foreign dial value', wBad.ok === false)
  const staleFile = join(scratch, 'boot-env-stale-writer.json')
  writeFileSync(staleFile, JSON.stringify({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_COMPUTER_ACCESS: 'sovereign', MERCURY_CAP_FAILOVER: 'auto' } }))
  const wStale = writeBootEnvChoice('MERCURY_MNEME', '1', staleFile)
  const afterStale = readBootEnvChoices(staleFile) ?? {}
  check("a stale foreign value already in the file (an earlier build's 'sovereign') never refuses a later save: it is pruned and every other saved row is kept",
    wStale.ok === true && afterStale.MERCURY_COMPUTER_ACCESS === undefined && afterStale.MERCURY_CAP_FAILOVER === 'auto' && afterStale.MERCURY_MNEME === '1', JSON.stringify({ wStale, afterStale }))
  const splashCore = readFileSync(join(import.meta.dir, '..', '..', 'assets', 'splash', 'splash-core.mjs'), 'utf-8')
  const menuStart = splashCore.indexOf('const MENU = [')
  const menuBlock = menuStart === -1 ? '' : splashCore.slice(menuStart, splashCore.indexOf('\n]', menuStart))
  check('the baked splash menu carries the menu rows (the wards row is present)', menuBlock.includes('"env":"MERCURY_WARDS"'))
  check('the baked splash menu excludes the command row', menuBlock.length > 0 && !menuBlock.includes('MERCURY_CACHE_TTL'))
}

section('applyBootMenuEnv — apply, refuse, yield, no-op')
{
  const file = join(scratch, 'boot-env.json')
  const write = (o: unknown) => writeFileSync(file, JSON.stringify(o))

  const noFile = applyBootMenuEnv(join(scratch, 'absent.json'), {})
  check('no file ⇒ null (byte-identical boot)', noFile === null)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_CAP_FAILOVER: 'auto', MERCURY_MNEME: '1' } })
  const env1: NodeJS.ProcessEnv = {}
  const r1 = applyBootMenuEnv(file, env1)
  check('valid file applies both keys', r1 !== null && r1.applied.length === 2 && env1.MERCURY_CAP_FAILOVER === 'auto' && env1.MERCURY_MNEME === '1')
  check('nothing refused, nothing env-won', r1 !== null && r1.refused.length === 0 && r1.envWins.length === 0)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_COMPUTER_USE: '0', MERCURY_SKIP_PERMISSIONS: '1', MERCURY_COMPUTER_ACCESS: 'permissive' } })
  const envComputer: NodeJS.ProcessEnv = {}
  const rComputer = applyBootMenuEnv(file, envComputer)
  check('the saved computer-use, Sovereign mode and access-type rows apply at boot (off, on, permissive)', rComputer !== null && rComputer.applied.length === 3 && envComputer.MERCURY_COMPUTER_USE === '0' && envComputer.MERCURY_SKIP_PERMISSIONS === '1' && envComputer.MERCURY_COMPUTER_ACCESS === 'permissive')
  for (const value of ['asks', 'full']) {
    write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_COMPUTER_ACCESS: value } })
    const envValue: NodeJS.ProcessEnv = {}
    const rValue = applyBootMenuEnv(file, envValue)
    check(`a saved access type ${value} applies at boot`, rValue !== null && rValue.applied.length === 1 && envValue.MERCURY_COMPUTER_ACCESS === value)
  }
  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_COMPUTER_USE: '1', MERCURY_SKIP_PERMISSIONS: '0' } })
  const envForeign: NodeJS.ProcessEnv = {}
  const rForeign = applyBootMenuEnv(file, envForeign)
  check('values outside the two rows\' choices are refused (on is the default, off is the default)', rForeign !== null && rForeign.refused.length === 2 && Object.keys(envForeign).length === 0)
  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_COMPUTER_ACCESS: 'sovereign', MERCURY_COMPUTER_USE: '0' } })
  const envStale: NodeJS.ProcessEnv = {}
  const rStale = applyBootMenuEnv(file, envStale)
  check("a saved access type 'sovereign' from an earlier build is a foreign value: refused as a diagnostic, never applied, never migrated, the switch beside it still applied", rStale !== null && rStale.refused.length === 1 && rStale.refused[0]!.key === 'MERCURY_COMPUTER_ACCESS' && rStale.retired.length === 0 && envStale.MERCURY_COMPUTER_ACCESS === undefined && envStale.MERCURY_COMPUTER_USE === '0', JSON.stringify(rStale))
  const staleSnapshot = resolveEffectiveSettingsSnapshot({ sessionId: 'stale', path: file, env: {} })
  check('the effective snapshot reads that stale value as the default, not as the profile\'s', staleSnapshot.rows.find(r => r.env === 'MERCURY_COMPUTER_ACCESS')?.source === 'default' && staleSnapshot.rows.find(r => r.env === 'MERCURY_COMPUTER_USE')?.source === 'profile')

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_TABULA_MINERVA: '1', MERCURY_SAMPLES: '1' } })
  const envCurator: NodeJS.ProcessEnv = {}
  const rCurator = applyBootMenuEnv(file, envCurator)
  check('a saved choice for the retired notepad-curator row is dropped as retired (never applied, never refused), the row beside it still applied', rCurator !== null && rCurator.retired.length === 1 && rCurator.retired[0] === 'MERCURY_TABULA_MINERVA' && rCurator.refused.length === 0 && envCurator.MERCURY_TABULA_MINERVA === undefined && envCurator.MERCURY_SAMPLES === '1')
  check('no menu row is the retired curator row', STARTUP_MENU.every(r => r.env !== 'MERCURY_TABULA_MINERVA'))
  const menuSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'substrate', 'startupMenu.ts'), 'utf-8')
  const retiredRows = (menuSource.match(/const RETIRED_MENU_ENV[^']*'([^']+)'/) ?? [])[1]?.split(' ') ?? []
  check('the retired list names the curator row', retiredRows.includes('MERCURY_TABULA_MINERVA') && retiredRows.length >= 8 && retiredRows.every(e => /^MERCURY_[A-Z_]+$/.test(e)), retiredRows.join(','))
  check('the memory & missions group keeps MNEME alone', STARTUP_MENU.filter(r => r.group === 'memory & missions').length === 1)
  for (const retired of retiredRows) {
    write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { [retired]: '1', MERCURY_SAMPLES: '1' } })
    const envRetired: NodeJS.ProcessEnv = {}
    const rRetired = applyBootMenuEnv(file, envRetired)
    check(`a saved choice for the retired row ${retired} is dropped as retired (never applied, never refused, no boot note), the row beside it still applied`, rRetired !== null && rRetired.retired.length === 1 && rRetired.retired[0] === retired && rRetired.refused.length === 0 && envRetired[retired] === undefined && envRetired.MERCURY_SAMPLES === '1', JSON.stringify(rRetired))
    check(`the retired row ${retired} is no menu row and no command row`, !allSettingRows().some(r => r.env === retired))
  }

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_SAMPLES: '1' } })
  const envSamples: NodeJS.ProcessEnv = {}
  const rSamples = applyBootMenuEnv(file, envSamples)
  check('the saved samples row applies at boot (on)', rSamples !== null && rSamples.applied.length === 1 && envSamples.MERCURY_SAMPLES === '1')
  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_SAMPLES: '0' } })
  const envSamplesOff: NodeJS.ProcessEnv = {}
  const rSamplesOff = applyBootMenuEnv(file, envSamplesOff)
  check('a saved 0 for the samples row is refused (off is the default, unset)', rSamplesOff !== null && rSamplesOff.refused.length === 1 && Object.keys(envSamplesOff).length === 0)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { PATH: '/evil', NODE_OPTIONS: '--require /evil.js', MERCURY_CAP_FAILOVER: 'auto' } })
  const env2: NodeJS.ProcessEnv = {}
  const r2 = applyBootMenuEnv(file, env2)
  check('PATH/NODE_OPTIONS smuggling refused (anti-smuggling allowlist)',
    r2 !== null && r2.refused.length === 2 && env2.PATH === undefined && env2.NODE_OPTIONS === undefined)
  check('the legal key beside the smuggle still applies', env2.MERCURY_CAP_FAILOVER === 'auto')

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_CONCOURSE: 'root', MERCURY_CAP_FAILOVER: 'banana' } })
  const env3: NodeJS.ProcessEnv = {}
  const r3 = applyBootMenuEnv(file, env3)
  check('values outside the row choices refused', r3 !== null && r3.refused.length === 2 && Object.keys(env3).length === 0)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_CAP_FAILOVER: 'auto' } })
  const env4: NodeJS.ProcessEnv = { MERCURY_CAP_FAILOVER: 'off' }
  const r4 = applyBootMenuEnv(file, env4)
  check('explicit real env ALWAYS wins (never overwritten)',
    r4 !== null && r4.envWins.join(',') === 'MERCURY_CAP_FAILOVER' && env4.MERCURY_CAP_FAILOVER === 'off' && r4.applied.length === 0)

  writeFileSync(file, '{not json')
  const r5 = applyBootMenuEnv(file, {})
  check('malformed JSON surfaced as a refusal, never a crash', r5 !== null && r5.refused.length === 1)
  write({ version: 999, env: { MERCURY_CAP_FAILOVER: 'auto' } })
  const env6: NodeJS.ProcessEnv = {}
  const r6 = applyBootMenuEnv(file, env6)
  check('wrong version refused wholesale', r6 !== null && r6.refused.length === 1 && Object.keys(env6).length === 0)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_CAP_FAILOVER: 'auto' } })
  process.env.MERCURY_ENTER_MENU = '0'
  const env7: NodeJS.ProcessEnv = {}
  check("MERCURY_ENTER_MENU='0' ⇒ file ignored entirely (kill honest)", applyBootMenuEnv(file, env7) === null && Object.keys(env7).length === 0)
  delete process.env.MERCURY_ENTER_MENU

  setStamp(false)
  const bareStampApplied: NodeJS.ProcessEnv = {}
  check('bare stamp ⇒ file STILL applies (stamp-independence)', applyBootMenuEnv(file, bareStampApplied) !== null && bareStampApplied.MERCURY_CAP_FAILOVER === 'auto')
  setStamp(true)
}

setStamp(false)
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log(' ALL STARTUP-MENU PROOFS PASS')
