#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'settings-last-good-')))
const HOME = join(ROOT, 'home')
const PROJECT = join(ROOT, 'project')
mkdirSync(HOME, { recursive: true })
mkdirSync(join(PROJECT, '.mercury'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'

const state = await import('../../src/bootstrap/state.ts')
state.setOriginalCwd(PROJECT)
state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const { parseSettingsFile, getSettingsWithErrors } = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { settingsFaultLine } = await import('../../src/utils/settings/validation.ts')
const { untoldSettingsFaults, resetToldSettingsFaults } = await import('../../src/utils/settings/faultNotices.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v).slice(0, 300)

const projectFile = join(PROJECT, '.mercury', 'settings.json')
const userFile = join(HOME, 'settings.json')
const GOOD = { view: { ping: false }, events: { hooks: { 'tool.before': [{ name: 'guard', match: 'Read', run: 'echo guard' }] } } }
const BROKEN = '{ "view": { "ping": false, },\n  "events": { "hooks": {'
const hooksOf = (settings: unknown): unknown => (settings as { events?: { hooks?: unknown } } | null)?.events?.hooks
const holdsGuard = (settings: unknown): boolean => {
  const list = (hooksOf(settings) as Record<string, Array<Record<string, unknown>>> | undefined)?.['tool.before']
  return Array.isArray(list) && list.length === 1 && list[0]?.name === 'guard' && list[0]?.match === 'Read' && list[0]?.run === 'echo guard'
}
const write = (path: string, body: unknown): void => {
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  resetSettingsCache()
}

section('§1 a settings file that parsed and then stops parsing: the last good settings stay in force, the fault is named')
{
  write(projectFile, GOOD)
  const good = parseSettingsFile(projectFile)
  check('the good file parses clean', good.settings !== null && good.errors.length === 0 && Array.isArray((hooksOf(good.settings) as Record<string, unknown[]>)['tool.before']), j(good))
  write(projectFile, BROKEN)
  const broken = parseSettingsFile(projectFile)
  check('the broken file keeps the last good settings (not null)', broken.settings !== null, j(broken))
  check('…the hooks it held are still there', holdsGuard(broken.settings), j(hooksOf(broken.settings)))
  check('…and ping:false still applies', broken.settings?.view?.ping === false, j(broken.settings?.view))
  check('one fault names the malformed JSON', broken.errors.length === 1 && /malformed JSON/.test(broken.errors[0]?.message ?? ''), j(broken.errors))
  check('…graded held, not a value skip and not a whole-file skip', broken.errors[0]?.severity === 'held', j(broken.errors))
  const line = settingsFaultLine(broken.errors[0]!)
  check('the one-line form says what happened and what stands', /settings: .*\.mercury\/settings\.json · The settings file contains malformed JSON \(or is empty\) — the file cannot be read; the last good settings stay in force$/.test(line), line)
  const merged = getSettingsWithErrors()
  check('the merged view keeps the project hooks after the break', holdsGuard(merged.settings), j(hooksOf(merged.settings)))
  check('…and carries the held fault once', merged.errors.filter(e => e.severity === 'held').length === 1, j(merged.errors))
}

section('§2 a file with no good parse behind it still fails whole (the boot shape stands)')
{
  write(userFile, '{ not json')
  const first = parseSettingsFile(userFile)
  check('settings null when nothing good was ever read from this path', first.settings === null, j(first))
  check('…with the hard words: the file is skipped', first.errors.length === 1 && first.errors[0]?.severity === undefined && /the file is skipped$/.test(settingsFaultLine(first.errors[0]!)), j(first.errors))
  const other = parseSettingsFile(join(HOME, 'never-written.json'))
  check('an absent file is no settings and no fault', other.settings === null && other.errors.length === 0, j(other))
}

section('§3 the file fixed, then broken again: the newest good parse is what stays')
{
  const NEWER = { view: { ping: true }, engine: { effort: 'high' } }
  write(projectFile, NEWER)
  const fixed = parseSettingsFile(projectFile)
  check('the fixed file applies with no fault', fixed.errors.length === 0 && fixed.settings?.view?.ping === true && fixed.settings?.engine?.effort === 'high' && hooksOf(fixed.settings) === undefined, j(fixed))
  write(projectFile, BROKEN)
  const again = parseSettingsFile(projectFile)
  check('broken again: the NEWER settings are held, not the older ones', again.settings?.view?.ping === true && again.settings?.engine?.effort === 'high' && hooksOf(again.settings) === undefined, j(again.settings))
  check('…one held fault', again.errors.length === 1 && again.errors[0]?.severity === 'held', j(again.errors))
}

section('§4 a deleted file forgets its last good parse; a value-level fault never holds the whole file')
{
  unlinkSync(projectFile)
  resetSettingsCache()
  const gone = parseSettingsFile(projectFile)
  check('a deleted file is no settings and no fault', gone.settings === null && gone.errors.length === 0, j(gone))
  write(projectFile, BROKEN)
  const afterDelete = parseSettingsFile(projectFile)
  check('a broken file written after the deletion has nothing to hold: null, the file is skipped', afterDelete.settings === null && afterDelete.errors[0]?.severity === undefined, j(afterDelete))
  write(projectFile, GOOD)
  parseSettingsFile(projectFile)
  write(projectFile, { view: { ping: 'loud' }, engine: { effort: 'max' } })
  const salvaged = parseSettingsFile(projectFile)
  check('a wrong value is dropped alone and the rest of THAT file applies (no hold)', salvaged.settings?.engine?.effort === 'max' && salvaged.settings?.view?.ping === undefined && hooksOf(salvaged.settings) === undefined && salvaged.errors.every(e => e.severity === 'warning'), j(salvaged))
}

section('§5 a fault is told once, and told again only after it went away and came back')
{
  resetToldSettingsFaults()
  write(projectFile, GOOD)
  parseSettingsFile(projectFile)
  write(userFile, { engine: { model: 'claude-opus-5-5' } })
  check('a clean cascade has nothing to tell', untoldSettingsFaults().length === 0)
  write(projectFile, BROKEN)
  const first = untoldSettingsFaults()
  check('the break is told once: one held fault', first.length === 1 && first[0]?.severity === 'held', j(first))
  check('…and not again while it stands', untoldSettingsFaults().length === 0)
  resetSettingsCache()
  check('…nor after a cache reset with the file still broken', untoldSettingsFaults().length === 0)
  write(projectFile, GOOD)
  check('the fix has nothing to tell', untoldSettingsFaults().length === 0)
  write(projectFile, BROKEN)
  const second = untoldSettingsFaults()
  check('a second break is told again', second.length === 1 && second[0]?.severity === 'held', j(second))
  write(projectFile, { ...GOOD, memory: { journal: 'yes' } })
  const valueFault = untoldSettingsFaults()
  check('a value fault is told with the value-skip words', valueFault.length === 1 && /memory\.journal · Expected boolean, received string — this value is skipped; the rest of the file applies$/.test(settingsFaultLine(valueFault[0]!)), j(valueFault.map(settingsFaultLine)))
  check('…once', untoldSettingsFaults().length === 0)
}

rmSync(ROOT, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-settings-last-good: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-settings-last-good: all green')
