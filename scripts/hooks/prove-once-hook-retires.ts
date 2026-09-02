#!/usr/bin/env bun
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'once-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'once-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const SETTINGS = join(HOME, 'settings.json')
const ONCE_MARK = join(PROJ, 'once-mark')
const KEEP_MARK = join(PROJ, 'keep-mark')
const lines = (p: string): number =>
  existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(l => l.length > 0).length : 0

const onceEntry = { type: 'command', command: `echo ran >> ${ONCE_MARK}`, once: true }
const twinEntry = { type: 'command', command: `echo ran >> ${ONCE_MARK}` }
const keeperEntry = { type: 'command', command: `echo ran >> ${KEEP_MARK}`, fieldNote: 'keep-me' }
const writeFixture = (entries: unknown[]): void =>
  writeFileSync(SETTINGS, JSON.stringify({ hooks: { SessionStart: [{ hooks: entries }] } }))

const { setIsInteractive, setSessionTrustAccepted, setProjectRoot, setOriginalCwd } = await import(
  '../../src/bootstrap/state.js'
)
const { setCwd } = await import('../../src/utils/Shell.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { captureHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.js')
const { executeSessionStartHooks } = await import('../../src/utils/hooks/events.js')
const settingsMod = (await import('../../src/utils/hooks/hooksSettings.js')) as unknown as {
  retireOnceHookFromSettings?: (event: string, fired: unknown) => string | null
}
const helperExported = typeof settingsMod.retireOnceHookFromSettings === 'function'
const retire = settingsMod.retireOnceHookFromSettings ?? ((): string | null => null)

setCwd(PROJ)
setOriginalCwd(PROJ)
setProjectRoot(PROJ)
setIsInteractive(false)
setSessionTrustAccepted(true)

const drive = async (signal?: AbortSignal): Promise<void> => {
  resetSettingsCache()
  captureHooksConfigSnapshot()
  for await (const _ of executeSessionStartHooks('startup', undefined, undefined, undefined, signal)) {
    void _
  }
}

section('§1 TWO RUNS: THE ONE-SHOT FIRES ONCE, THE ENTRY LEAVES THE FILE')
{
  writeFixture([onceEntry, keeperEntry])
  await drive()
  check('run 1 executed the once hook (1 marker line)', lines(ONCE_MARK) === 1, `${lines(ONCE_MARK)}`)
  check('run 1 executed the keeper (1 marker line)', lines(KEEP_MARK) === 1, `${lines(KEEP_MARK)}`)

  const rawAfter1 = readFileSync(SETTINGS, 'utf-8')
  check('after run 1 the once entry is REMOVED from the settings file', !rawAfter1.includes('"once"'), rawAfter1)
  check('the keeper entry survives the write', rawAfter1.includes('keep-mark'))
  check('the sibling keeps its unknown key (raw-fidelity write)', rawAfter1.includes('"fieldNote"'))

  await drive()
  check('run 2 does NOT fire the one-shot again (still 1 line)', lines(ONCE_MARK) === 1, `${lines(ONCE_MARK)}`)
  check('run 2 fires the keeper again (2 lines)', lines(KEEP_MARK) === 2, `${lines(KEEP_MARK)}`)
}

section('§2 IDENTITY PRECISION: NO ONCE-MARKED TWIN, NOTHING RETIRES')
{
  check('the helper is exported (retireOnceHookFromSettings)', helperExported)
  writeFixture([twinEntry, keeperEntry])
  resetSettingsCache()
  const before = readFileSync(SETTINGS, 'utf-8')
  const source = retire('SessionStart', { ...onceEntry })
  check('a fired once config with no once-marked file twin retires nothing', source === null, String(source))
  check('the file is byte-unchanged', readFileSync(SETTINGS, 'utf-8') === before)
}

section('§3 A BATCH CANCEL IS NOT A RUN')
{
  writeFixture([onceEntry])
  const aborted = new AbortController()
  aborted.abort()
  await drive(aborted.signal)
  const raw = readFileSync(SETTINGS, 'utf-8')
  check('a cancelled batch leaves the once entry in place', raw.includes('"once"'), raw)
}

console.log(failures === 0 ? '\nprove-once-hook-retires: all green' : `\nprove-once-hook-retires: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
