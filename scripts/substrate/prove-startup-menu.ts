#!/usr/bin/env bun
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
for (const k of ['MERCURY_ENTER_MENU', 'MERCURY_THEMIS', 'MERCURY_MNEME', 'MERCURY_DAEDALUS', 'MERCURY_DAEDALUS_MODEL', 'MERCURY_DAEDALUS_EXECUTOR_MODEL']) {
  delete process.env[k]
}

const { STARTUP_MENU, menuRowChoices, applyBootMenuEnv, BOOT_ENV_VERSION } = await import('../../src/substrate/startupMenu.js')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')
const { getWorkflowToolPrompt } = await import('../../src/tools/WorkflowTool/workflowPrompt.js')

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
  check('the paper-triad knobs are all present',
    ['MERCURY_THEMIS', 'MERCURY_MNEME', 'MERCURY_DAEDALUS', 'MERCURY_DAEDALUS_MODEL', 'MERCURY_DAEDALUS_EXECUTOR_MODEL'].every(e => STARTUP_MENU.some(r => r.env === e)))
  check('the IDE lane rows are present (clangd visible-ON · godot arm-OFF)',
    STARTUP_MENU.some(r => r.env === 'MERCURY_LSP_CPP' && r.defaultLabel === 'on') &&
    STARTUP_MENU.some(r => r.env === 'MERCURY_GODOT' && r.defaultLabel === 'off'))
  const computerAt = STARTUP_MENU.findIndex(r => r.env === 'MERCURY_COMPUTER_USE')
  const accessAt = STARTUP_MENU.findIndex(r => r.env === 'MERCURY_COMPUTER_ACCESS')
  check('the computer-use row is a toggle, on by default, off its one value',
    computerAt >= 0 && STARTUP_MENU[computerAt]!.kind === 'toggle' && STARTUP_MENU[computerAt]!.defaultLabel === 'on' && STARTUP_MENU[computerAt]!.options.join(',') === '0')
  check('the access-type row sits directly under it in the same group: asks by default, sovereign its one value',
    accessAt === computerAt + 1 && STARTUP_MENU[accessAt]!.group === STARTUP_MENU[computerAt]!.group && STARTUP_MENU[accessAt]!.kind === 'enum' && STARTUP_MENU[accessAt]!.defaultLabel === 'asks' && STARTUP_MENU[accessAt]!.options.join(',') === 'sovereign')
  check('both computer rows reach new sessions (no live class)', STARTUP_MENU[computerAt]!.applicationClass === undefined && STARTUP_MENU[accessAt]!.applicationClass === undefined)
  const samplesAt = STARTUP_MENU.findIndex(r => r.env === 'MERCURY_SAMPLES')
  check('the samples row is a toggle, off by default, 1 its one value, in its own group directly after the computer-use group',
    samplesAt === accessAt + 1 && STARTUP_MENU[samplesAt]!.kind === 'toggle' && STARTUP_MENU[samplesAt]!.defaultLabel === 'off' && STARTUP_MENU[samplesAt]!.options.join(',') === '1' && STARTUP_MENU[samplesAt]!.group === 'samples' && STARTUP_MENU[samplesAt]!.label === 'Samples' && STARTUP_MENU[samplesAt]!.applicationClass === undefined)
  check('the samples row\'s foot line says what a sample is', /a page the model draws when you ask to see something/.test(STARTUP_MENU[samplesAt]?.summary ?? '') && /your marks/.test(STARTUP_MENU[samplesAt]?.summary ?? ''))
  const enterMenu = getFlagSpec('MERCURY_ENTER_MENU')
  check('MERCURY_ENTER_MENU registered default-on / infra, consumed by the applier',
    enterMenu?.kind === 'default-on' && enterMenu?.tier === 'infra' && enterMenu?.consumer === 'src/substrate/startupMenu.ts')
  const rosterA = getFlagSpec('MERCURY_DAEDALUS_MODEL')
  const rosterB = getFlagSpec('MERCURY_DAEDALUS_EXECUTOR_MODEL')
  check('roster flags registered as value knobs consumed by the Workflow prompt',
    rosterA?.kind === 'value' && rosterB?.kind === 'value' && rosterA?.consumer === 'src/tools/WorkflowTool/workflowPrompt.ts')
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
  const w2 = writeBootEnvChoice('MERCURY_THEMIS', 'warn', wFile)
  const savedAfter = readBootEnvChoices(wFile) ?? {}
  check('a later menu-row write PRESERVES the saved dial choice',
    w2.ok === true && savedAfter.MERCURY_CACHE_TTL === '1h' && savedAfter.MERCURY_THEMIS === 'warn')
  const wBad = writeBootEnvChoice('MERCURY_CACHE_TTL', 'forever', wFile)
  check('the writer refuses a foreign dial value', wBad.ok === false)
  const splashCore = readFileSync(join(import.meta.dir, '..', '..', 'assets', 'splash', 'splash-core.mjs'), 'utf-8')
  const menuStart = splashCore.indexOf('const MENU = [')
  const menuBlock = menuStart === -1 ? '' : splashCore.slice(menuStart, splashCore.indexOf('\n]', menuStart))
  check('the baked splash menu carries the menu rows (the THEMIS row is present)', menuBlock.includes('"env":"MERCURY_THEMIS"'))
  check('the baked splash menu excludes the command row', menuBlock.length > 0 && !menuBlock.includes('MERCURY_CACHE_TTL'))
}

section('applyBootMenuEnv — apply, refuse, yield, no-op')
{
  const file = join(scratch, 'boot-env.json')
  const write = (o: unknown) => writeFileSync(file, JSON.stringify(o))

  const noFile = applyBootMenuEnv(join(scratch, 'absent.json'), {})
  check('no file ⇒ null (byte-identical boot)', noFile === null)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_THEMIS: 'warn', MERCURY_MNEME: '1' } })
  const env1: NodeJS.ProcessEnv = {}
  const r1 = applyBootMenuEnv(file, env1)
  check('valid file applies both keys', r1 !== null && r1.applied.length === 2 && env1.MERCURY_THEMIS === 'warn' && env1.MERCURY_MNEME === '1')
  check('nothing refused, nothing env-won', r1 !== null && r1.refused.length === 0 && r1.envWins.length === 0)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_COMPUTER_USE: '0', MERCURY_COMPUTER_ACCESS: 'sovereign' } })
  const envComputer: NodeJS.ProcessEnv = {}
  const rComputer = applyBootMenuEnv(file, envComputer)
  check('the saved computer-use rows apply at boot (off, sovereign)', rComputer !== null && rComputer.applied.length === 2 && envComputer.MERCURY_COMPUTER_USE === '0' && envComputer.MERCURY_COMPUTER_ACCESS === 'sovereign')
  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_COMPUTER_USE: '1', MERCURY_COMPUTER_ACCESS: 'asks' } })
  const envForeign: NodeJS.ProcessEnv = {}
  const rForeign = applyBootMenuEnv(file, envForeign)
  check('values outside the two rows\' choices are refused (on is the default, asks is the default)', rForeign !== null && rForeign.refused.length === 2 && Object.keys(envForeign).length === 0)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_SAMPLES: '1' } })
  const envSamples: NodeJS.ProcessEnv = {}
  const rSamples = applyBootMenuEnv(file, envSamples)
  check('the saved samples row applies at boot (on)', rSamples !== null && rSamples.applied.length === 1 && envSamples.MERCURY_SAMPLES === '1')
  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_SAMPLES: '0' } })
  const envSamplesOff: NodeJS.ProcessEnv = {}
  const rSamplesOff = applyBootMenuEnv(file, envSamplesOff)
  check('a saved 0 for the samples row is refused (off is the default, unset)', rSamplesOff !== null && rSamplesOff.refused.length === 1 && Object.keys(envSamplesOff).length === 0)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { PATH: '/evil', NODE_OPTIONS: '--require /evil.js', MERCURY_THEMIS: 'warn' } })
  const env2: NodeJS.ProcessEnv = {}
  const r2 = applyBootMenuEnv(file, env2)
  check('PATH/NODE_OPTIONS smuggling refused (anti-smuggling allowlist)',
    r2 !== null && r2.refused.length === 2 && env2.PATH === undefined && env2.NODE_OPTIONS === undefined)
  check('the legal key beside the smuggle still applies', env2.MERCURY_THEMIS === 'warn')

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_THEMIS: 'root', MERCURY_DAEDALUS_MODEL: 'banana' } })
  const env3: NodeJS.ProcessEnv = {}
  const r3 = applyBootMenuEnv(file, env3)
  check('values outside the row choices refused', r3 !== null && r3.refused.length === 2 && Object.keys(env3).length === 0)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_THEMIS: 'warn' } })
  const env4: NodeJS.ProcessEnv = { MERCURY_THEMIS: 'enforce' }
  const r4 = applyBootMenuEnv(file, env4)
  check('explicit real env ALWAYS wins (never overwritten)',
    r4 !== null && r4.envWins.join(',') === 'MERCURY_THEMIS' && env4.MERCURY_THEMIS === 'enforce' && r4.applied.length === 0)

  writeFileSync(file, '{not json')
  const r5 = applyBootMenuEnv(file, {})
  check('malformed JSON surfaced as a refusal, never a crash', r5 !== null && r5.refused.length === 1)
  write({ version: 999, env: { MERCURY_THEMIS: 'warn' } })
  const env6: NodeJS.ProcessEnv = {}
  const r6 = applyBootMenuEnv(file, env6)
  check('wrong version refused wholesale', r6 !== null && r6.refused.length === 1 && Object.keys(env6).length === 0)

  write({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_THEMIS: 'warn' } })
  process.env.MERCURY_ENTER_MENU = '0'
  const env7: NodeJS.ProcessEnv = {}
  check("MERCURY_ENTER_MENU='0' ⇒ file ignored entirely (kill honest)", applyBootMenuEnv(file, env7) === null && Object.keys(env7).length === 0)
  delete process.env.MERCURY_ENTER_MENU

  setStamp(false)
  const bareStampApplied: NodeJS.ProcessEnv = {}
  check('bare stamp ⇒ file STILL applies (stamp-independence)', applyBootMenuEnv(file, bareStampApplied) !== null && bareStampApplied.MERCURY_THEMIS === 'warn')
  setStamp(true)
}

section('THEMIS audit — an applied boot-env writes a boot row when the plane is on')
{
  const file = join(scratch, 'boot-env-audit.json')
  writeFileSync(file, JSON.stringify({ version: BOOT_ENV_VERSION, savedAt: 'x', env: { MERCURY_MNEME: '1' } }))
  process.env.MERCURY_THEMIS = 'warn'
  const env: NodeJS.ProcessEnv = {}
  const r = applyBootMenuEnv(file, env)
  check('applied under an active plane', r !== null && r.applied.length === 1)
  await new Promise(res => setTimeout(res, 250))
  const { themisDirs } = await import('../../src/substrate/themis/auditChain.js')
  let chain = ''
  for (const auditDir of themisDirs(scratch)) {
    try {
      chain += readdirSync(auditDir).filter(f => f.startsWith('audit-')).map(f => readFileSync(join(auditDir, f), 'utf8')).join('\n')
    } catch {
    }
  }
  check("audit row 'boot-env-applied' recorded (actor boot)", chain.includes('boot-env-applied') && chain.includes('MERCURY_MNEME=1'))
  delete process.env.MERCURY_THEMIS
}

section('Workflow prompt — themis section + the DAEDALUS roster surfacing')
{
  process.env.MERCURY_THEMIS = 'off'
  delete process.env.MERCURY_DAEDALUS
  const base = getWorkflowToolPrompt()
  check('explicit THEMIS off + daedalus off ⇒ no themis section, no roster', !base.includes('The themis global') && !base.includes('DAEDALUS roster'))
  delete process.env.MERCURY_THEMIS
  check('unset (the default) ⇒ the themis global IS documented (default-on)', getWorkflowToolPrompt().includes('The themis global'))
  process.env.MERCURY_THEMIS = 'warn'
  check('THEMIS on ⇒ the themis global is documented (no dead VM surface)', getWorkflowToolPrompt().includes('The themis global'))
  delete process.env.MERCURY_THEMIS

  process.env.MERCURY_DAEDALUS = '1'
  check('daedalus on, no saved picks ⇒ no roster line', !getWorkflowToolPrompt().includes('DAEDALUS roster'))
  process.env.MERCURY_DAEDALUS_MODEL = 'opus'
  process.env.MERCURY_DAEDALUS_EXECUTOR_MODEL = 'sonnet'
  const withRoster = getWorkflowToolPrompt()
  check('saved picks surfaced for the dispatcher', withRoster.includes('DAEDALUS roster') && withRoster.includes("args.model='opus'") && withRoster.includes("args.executorModel='sonnet'"))
  process.env.MERCURY_DAEDALUS_MODEL = 'banana'
  check('a junk pick is never surfaced', !getWorkflowToolPrompt().includes("args.model='banana'"))
  delete process.env.MERCURY_DAEDALUS
  process.env.MERCURY_DAEDALUS_MODEL = 'opus'
  check('roster absent while the workflow itself is off', !getWorkflowToolPrompt().includes('DAEDALUS roster'))
  for (const k of ['MERCURY_DAEDALUS_MODEL', 'MERCURY_DAEDALUS_EXECUTOR_MODEL']) delete process.env[k]
}

setStamp(false)
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log(' ALL STARTUP-MENU PROOFS PASS')
