#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..')
process.chdir(repoRoot)
process.env.MERCURY_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), 'census-reasons-')), 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  const fixHint = 'fix: censusGapLines and CENSUS_NO_REASON in src/permissions/capability-census/census.ts build each reason line; declare a missing gate or condition in the tool capability contract (declaredCapability in src/permissions/capability/contract.ts)'
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} | ` : ''}${fixHint}` : ''}`)
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { buildToolCensus, censusGapLines, CENSUS_NO_REASON } = await import('../../src/permissions/capability-census/census.ts')
type Census = ReturnType<typeof buildToolCensus>

console.log('── census reasons ──')
const census = buildToolCensus()

console.log('[1] every gated row declares its reason')
{
  const conditionalWithout = census.rows.filter(r => r.support === 'conditional' && !(r.declared?.conditions?.length)).map(r => r.name)
  check('every conditional tool declares the condition it waits on', conditionalWithout.length === 0, conditionalWithout.join(', '))
  const unavailableWithout = census.rows.filter(r => r.support === 'unavailable' && r.declared?.gate === undefined && !(r.declared?.conditions?.length)).map(r => r.name)
  check('every gated-out tool declares a gate or a condition', unavailableWithout.length === 0, unavailableWithout.join(', '))
  const lines = censusGapLines(census)
  check('no line reads "no reason declared"', !lines.some(l => l.reason === CENSUS_NO_REASON), lines.filter(l => l.reason === CENSUS_NO_REASON).map(l => l.tools.join(',')).join(' | '))
  const named = new Set(lines.flatMap(l => l.tools.map(tool => tool.replace(' (off right now)', ''))))
  const gated = census.rows.filter(r => r.support !== 'available').map(r => r.name)
  check('every non-available tool is named on exactly one line', gated.every(name => named.has(name)) && lines.reduce((n, l) => n + l.tools.length, 0) === gated.length, `${gated.length} gated, ${named.size} named`)
}

console.log('[2] the grouped lines (pure)')
{
  const row = (name: string, support: 'conditional' | 'unavailable', declared: Record<string, unknown> | null, enabledNow = true): Census['rows'][number] =>
    ({ name, support, enabledNow, inCatalogNow: support === 'conditional', declared }) as never
  const synthetic = {
    rows: [
      row('Glob', 'conditional', { conditions: ['a search binary'] }),
      row('Grep', 'conditional', { conditions: ['a search binary'] }),
      row('LSP', 'conditional', { conditions: ['a connected language server'] }, false),
      row('Retain', 'unavailable', { gate: 'FLAG_OPT' }),
      row('Recall', 'unavailable', { gate: 'FLAG_OPT' }),
      row('Godot', 'unavailable', { gate: 'FLAG_OPT', conditions: ['a project.godot root'] }),
      row('Debug', 'unavailable', { gate: 'FLAG_ON' }),
      row('Eval', 'unavailable', { gate: 'FLAG_LEFT_ON', conditions: ['a resolvable interpreter'] }),
      row('Bare', 'unavailable', { gate: 'FLAG_LEFT_ON' }),
      row('Mystery', 'unavailable', null),
      row('Aseprite', 'unavailable', { gate: 'FLAG_OPT_ON', conditions: ['the binary located'] }),
    ],
  } as unknown as Census
  const kinds: Record<string, string> = { FLAG_OPT: 'opt-in', FLAG_OPT_ON: 'opt-in', FLAG_ON: 'default-on', FLAG_LEFT_ON: 'default-on' }
  const lines = censusGapLines(synthetic, env => kinds[env], env => env === 'FLAG_LEFT_ON' || env === 'FLAG_OPT_ON')
  const byTools = (tools: string): string | undefined => lines.find(l => l.tools.join(',') === tools)?.reason
  check('tools sharing one condition ride one line', byTools('Glob,Grep') === 'needs a search binary', JSON.stringify(lines))
  check('an isEnabled()=false conditional tool wears "(off right now)"', byTools('LSP (off right now)') === 'needs a connected language server')
  check('an opt-in gate that does not read on says unset (an opt-in flag)', byTools('Retain,Recall') === 'FLAG_OPT unset (an opt-in flag)')
  check('a gate plus a condition carries both', byTools('Godot') === 'FLAG_OPT unset (an opt-in flag) · needs a project.godot root')
  check('an opt-in gate that reads on, with the tool still out, says turned on and the reason, and not that the flag is unset', byTools('Aseprite') === 'FLAG_OPT_ON turned on · needs the binary located', JSON.stringify(lines))
  check('a default-on gate that was turned off says turned off', byTools('Debug') === 'FLAG_ON turned off')
  check('a default-on gate left on, with the tool out for another reason, says that reason and not that the flag was turned off', byTools('Eval') === 'needs a resolvable interpreter', JSON.stringify(lines))
  check('a tool out behind a default-on flag nobody turned off, with no condition declared, is named as the gap beside a row with no declaration: nothing says the flag was turned off', byTools('Bare,Mystery') === CENSUS_NO_REASON, JSON.stringify(lines))
  check('conditional lines carry the conditional support word, gated lines the unavailable one', lines.every(l => (l.tools[0]!.startsWith('G') && l.tools[0] !== 'Godot') || l.tools[0] === 'LSP (off right now)' ? l.support === 'conditional' : l.support === 'unavailable'))
  const dapBefore = process.env.MERCURY_DAP
  delete process.env.MERCURY_DAP
  const gated = { rows: [row('Debug', 'unavailable', { gate: 'MERCURY_DAP', conditions: ['a resolvable debug adapter'] })] } as unknown as Census
  const unset = censusGapLines(gated)[0]?.reason
  process.env.MERCURY_DAP = '0'
  const turnedOff = censusGapLines(gated)[0]?.reason
  const live = censusGapLines(buildToolCensus()).find(l => l.tools.includes('Debug'))?.reason
  if (dapBefore === undefined) delete process.env.MERCURY_DAP
  else process.env.MERCURY_DAP = dapBefore
  check('MERCURY_DAP unset and the gate false: the line gives the reason the census holds and does not say the flag was turned off', unset === 'needs a resolvable debug adapter', String(unset))
  check('MERCURY_DAP=0: the line says the flag was turned off, on the same row and on the live census', turnedOff === 'MERCURY_DAP turned off · needs a resolvable debug adapter' && live !== undefined && live.startsWith('MERCURY_DAP turned off'), `${turnedOff} | ${live}`)
  const asepriteBefore = process.env.MERCURY_ASEPRITE
  delete process.env.MERCURY_ASEPRITE
  const optIn = { rows: [row('Aseprite', 'unavailable', { gate: 'MERCURY_ASEPRITE', conditions: ['the aseprite binary located'] })] } as unknown as Census
  const optUnset = censusGapLines(optIn)[0]?.reason
  process.env.MERCURY_ASEPRITE = '1'
  const optOn = censusGapLines(optIn)[0]?.reason
  if (asepriteBefore === undefined) delete process.env.MERCURY_ASEPRITE
  else process.env.MERCURY_ASEPRITE = asepriteBefore
  check('MERCURY_ASEPRITE unset: the line says unset (an opt-in flag); MERCURY_ASEPRITE=1 with the tool still out: it says turned on; the reason follows either way', optUnset === 'MERCURY_ASEPRITE unset (an opt-in flag) · needs the aseprite binary located' && optOn === 'MERCURY_ASEPRITE turned on · needs the aseprite binary located', `${optUnset} | ${optOn}`)
}

console.log('[3] the truths driven on this box')
{
  const lines = censusGapLines(census)
  const lineOf = (tool: string) => lines.find(l => l.tools.some(name => name === tool || name === `${tool} (off right now)`))
  for (const tool of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']) {
    const line = lineOf(tool)
    const interactive = census.rows.find(r => r.name === tool)?.inCatalogNow === true
    check(`${tool} ${interactive ? 'is conditional here and' : 'is out of this headless catalog and'} names the interactive session + MERCURY_TASKS`, line !== undefined && line.reason.includes('interactive session') && line.reason.includes('MERCURY_TASKS'), line?.reason)
  }
  const glob = lineOf('Glob')
  check('Glob names the search binary', glob !== undefined && glob.reason.includes('search binary'), glob?.reason)
}

console.log('[4] /health prints the lines (the row, run here)')
{
  const { toolCapabilityFastChecks } = await import('../../src/platform/health/sections/tool-capability-fast.ts')
  const row = await toolCapabilityFastChecks().find(entry => entry.id === 'capability-census')?.run()
  const lines = censusGapLines(buildToolCensus())
  const printed = (row?.detail ?? '').split('\n')
  check('the census check reads censusGapLines', row !== undefined && lines.length > 0 && printed.length === lines.length, `${printed.length} lines printed, ${lines.length} gap lines`)
  const unlike = lines.findIndex((g, i) => printed[i] !== `${g.support === 'conditional' ? 'conditional' : 'off'} · ${g.tools.join(', ')} — ${g.reason}`)
  check('…and prints every line as the row’s detail', unlike === -1, printed[unlike] ?? '')
  const reasonless = lines.filter(g => g.reason === CENSUS_NO_REASON).flatMap(g => g.tools)
  check('…and a reasonless row warns the check', reasonless.length > 0 ? row?.status === 'warn' && row.evidence.includes(`NO REASON DECLARED: ${reasonless.join(', ')}`) : row?.status === 'ok' && !row.evidence.includes('NO REASON DECLARED'), row?.evidence)
  const { FileReadTool } = await import('../../src/tools/read/ReadTool.ts')
  const enabled = Object.getOwnPropertyDescriptor(FileReadTool, 'isEnabled')
  Object.defineProperty(FileReadTool, 'isEnabled', { configurable: true, writable: true, enumerable: true, value: () => false })
  const gap = await toolCapabilityFastChecks().find(entry => entry.id === 'capability-census')?.run()
  if (enabled) Object.defineProperty(FileReadTool, 'isEnabled', enabled)
  check(
    'a tool of the roster that is off and declares no reason (Read, switched off here) turns the row to warn: it is named in the evidence and the detail, with the fix',
    gap?.status === 'warn' && gap.evidence.endsWith(` · NO REASON DECLARED: ${FileReadTool.name} (off right now)`) && (gap.detail ?? '').split('\n').includes(`conditional · ${FileReadTool.name} (off right now) — ${CENSUS_NO_REASON}`) && gap.fix?.startsWith('Declare the tool’s capability contract') === true,
    `${gap?.status}: ${gap?.evidence} | ${gap?.fix}`,
  )
}

console.log('[5] a tool out with its flag left on says why, and "turned off" only of a flag that reads off (the live census, each state set here)')
{
  const desktop = await import('../../src/integrations/desktop/resolveDriver.ts')
  const said: string[] = []
  const lineOf = (tool: string, vars: Record<string, string>): string => {
    const before = Object.keys(vars).map(name => [name, process.env[name]] as const)
    Object.assign(process.env, vars)
    desktop.resetDesktopDriverForTest()
    const live = buildToolCensus()
    const lines = censusGapLines(live)
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    desktop.resetDesktopDriverForTest()
    for (const line of lines) if (line.reason === CENSUS_NO_REASON) said.push(`${JSON.stringify(vars)}: ${line.tools.join(', ')}`)
    const line = lines.find(l => l.tools.some(name => name === tool || name === `${tool} (off right now)`))
    if (line !== undefined) return `${line.support === 'conditional' ? 'conditional' : 'off'} · ${line.reason}`
    return live.rows.some(r => r.name === tool) ? 'available' : 'no row'
  }
  const DRIVER = 'needs a desktop driver that resolves (the native driver pack; MERCURY_DESKTOP_DRIVER=none switches it off)'
  const here = lineOf('Computer', {})
  check('Computer, flags as they are: in the roster where a driver resolves and out where none does, the driver named either way and no flag said to be turned off', here === `conditional · ${DRIVER}` || here === `off · ${DRIVER}`, here)
  const driverless = lineOf('Computer', { MERCURY_DESKTOP_DRIVER: 'none' })
  check('Computer on a host with no desktop driver (MERCURY_DESKTOP_DRIVER=none stands in for one): out, and the line gives the driver as the reason, not the flag', driverless === `off · ${DRIVER}`, driverless)
  const computerOff = lineOf('Computer', { MERCURY_COMPUTER_USE: '0' })
  check('Computer with MERCURY_COMPUTER_USE=0: the line says the flag was turned off', computerOff === `off · MERCURY_COMPUTER_USE turned off · ${DRIVER}`, computerOff)
  const changeSet = [lineOf('ChangeSet', {}), lineOf('ChangeSet', { MERCURY_CHANGE_RECEIPTS: '0' }), lineOf('ChangeSet', { MERCURY_EDIT_HUNKS: '0' }), lineOf('ChangeSet', { MERCURY_CHANGESET: '0' })]
  check('ChangeSet: available in the roster; out by change receipts, edit hunks or its own flag it is no census row, so no line can say a flag of its was turned off', changeSet.join(' | ') === 'available | no row | no row | no row', changeSet.join(' | '))
  const transaction = [lineOf('Transaction', {}), lineOf('Transaction', { MERCURY_CHANGE_RECEIPTS: '0' }), lineOf('Transaction', { MERCURY_TX_AUTOCAPTURE: '0' }), lineOf('Transaction', { MERCURY_IDE_LOOP: '0' })]
  check('Transaction: available in the roster; out by change receipts, automatic capture or its own flag it is no census row', transaction.join(' | ') === 'available | no row | no row | no row', transaction.join(' | '))
  for (const [tool, flag] of [['Browser', 'MERCURY_BROWSER'], ['Journey', 'MERCURY_JOURNEYS'], ['Launch', 'MERCURY_LAUNCH'], ['Inspect', 'MERCURY_REFS'], ['Service', 'MERCURY_SERVICES']] as const) {
    const on = lineOf(tool, {})
    const off = lineOf(tool, { [flag]: '0' })
    check(`${tool}: available with ${flag} left on, and no census row with ${flag}=0: its own flag is the one thing that takes it out, and no line is printed of it`, on === 'available' && off === 'no row', `${on} | ${off}`)
  }
  check('in none of those states does a tool read "no reason declared"', said.length === 0, said.join(' | '))
}

console.log(failures === 0 ? '\n ✅ CENSUS REASONS — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
