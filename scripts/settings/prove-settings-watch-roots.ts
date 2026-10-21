#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = realpathSync(mkdtempSync(join(existsSync('/private/tmp') ? '/private/tmp' : tmpdir(), 'watch-roots-')))
const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const same = (a: string[], b: string[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

const state = await import('../../src/bootstrap/state.ts')
state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const detector = await import('../../src/utils/settings/changeDetector.ts')
const { getManagedFilePath, getManagedSettingsDropInDir } = await import('../../src/utils/settings/managedPath.ts')
const managedRoot = getManagedFilePath()
const dropIn = getManagedSettingsDropInDir()
const managedArmed = [managedRoot, dropIn].filter(d => existsSync(d))
console.log(`scratch root ${ROOT}\nconfig home ${HOME}\nmanaged root ${managedRoot} (${existsSync(managedRoot) ? 'exists: armed' : 'absent: not armed, nor its parent'})`)

type Armed = { targets: string[]; roots: string[] | null; awaited: string[] | null }
const armedFor = async (cwd: string): Promise<Armed> => {
  state.setOriginalCwd(cwd)
  state.setCwdState(cwd)
  await detector.resetForTesting({ stabilityThresholdMs: 60, pollIntervalMs: 20 })
  await detector.initialize()
  const seam = (detector as Record<string, unknown>)._watchRootsForTesting
  const listed = typeof seam === 'function' ? (seam as () => { roots: string[]; awaited: string[] })() : null
  return { targets: detector._watchTargetsForTesting(), roots: listed?.roots ?? null, awaited: listed?.awaited ?? null }
}
const pinRoots = (label: string, armed: Armed, projectDirs: string[], expectedRoots: string[], expectedAwaited: string[]): void => {
  const mcpDirs = armed.targets.filter(t => t.endsWith('mcp.json')).map(t => dirname(dirname(t)))
  check(`${label}: the mcp.json targets name the project folders only — ${projectDirs.map(r => r.replace(ROOT, '<root>')).join(', ')} — never an ancestor above them`, same(mcpDirs, projectDirs), mcpDirs.join(' · '))
  check(`${label}: the armed-roots seam answers`, armed.roots !== null, 'changeDetector exports no _watchRootsForTesting')
  if (armed.roots === null || armed.awaited === null) return
  check(`${label}: the armed roots are exactly ${expectedRoots.map(r => r.replace(ROOT, '<root>')).join(', ')}`, same(armed.roots, expectedRoots), armed.roots.join(' · '))
  check(`${label}: the awaited project folders are exactly ${expectedAwaited.length === 0 ? 'none' : expectedAwaited.map(r => r.replace(ROOT, '<root>')).join(', ')}`, same(armed.awaited, expectedAwaited), armed.awaited.join(' · '))
  check(`${label}: no root is the scratch temp root, a system root, the home's parent or the managed root's parent`, !armed.roots.some(r => r === ROOT || r === sep || r === '/private' || r === '/tmp' || r === '/private/tmp' || r === '/etc' || r === dirname(HOME) || r === dirname(managedRoot)), armed.roots.join(' · '))
}

section('§1 a deep cwd inside a git repository: the launch folder, the repository top and the config home — nothing between, nothing above')
{
  const top = join(ROOT, 'deep', 'er', 'still', 'project')
  const cwd = join(top, 'pkg', 'sub')
  mkdirSync(cwd, { recursive: true })
  execFileSync('git', ['init', '-q', top])
  const armed = await armedFor(cwd)
  pinRoots('§1', armed, [cwd, top], [HOME, cwd, top, ...managedArmed], [join(cwd, '.mercury'), join(top, '.mercury')])
  await detector.dispose()
}

section('§2 a plain deep folder with no repository: the launch folder and the config home')
{
  const cwd = join(ROOT, 'plain', 'deep', 'here')
  mkdirSync(cwd, { recursive: true })
  const armed = await armedFor(cwd)
  pinRoots('§2', armed, [cwd], [HOME, cwd, ...managedArmed], [join(cwd, '.mercury')])
  await detector.dispose()
}

section('§3 the cwd is the repository top with a .mercury folder: that folder, the config home, and nothing awaited')
{
  const top = join(ROOT, 'repo')
  mkdirSync(join(top, '.mercury'), { recursive: true })
  execFileSync('git', ['init', '-q', top])
  const armed = await armedFor(top)
  pinRoots('§3', armed, [top], [HOME, join(top, '.mercury'), ...managedArmed], [])
  await detector.dispose()
}

section('§4 the config home is armed only as itself: a missing home arms nothing, never its parent')
{
  const cwd = join(ROOT, 'elsewhere')
  mkdirSync(cwd, { recursive: true })
  const ghost = join(ROOT, 'ghost-home')
  process.env.MERCURY_CONFIG_DIR = ghost
  const armed = await armedFor(cwd)
  process.env.MERCURY_CONFIG_DIR = HOME
  check('§4 the home that does not exist is not armed and neither is the scratch root above it', armed.roots !== null && !armed.roots.includes(ghost) && !armed.roots.includes(ROOT), (armed.roots ?? []).join(' · '))
  check('§4 the project folder is still armed', armed.roots !== null && armed.roots.includes(cwd), (armed.roots ?? []).join(' · '))
  await detector.dispose()
}

rmSync(ROOT, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-settings-watch-roots: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-settings-watch-roots: all green')
