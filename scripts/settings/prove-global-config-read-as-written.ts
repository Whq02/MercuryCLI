#!/usr/bin/env bun
// gate-watch: src/utils/config/schema.ts src/utils/config/globalConfig.ts src/main.tsx src/utils/releaseNotes.ts
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const SHORT = realpathSync(mkdtempSync(join(tmpdir(), 'gcrw-')))
const HOME = join(SHORT, 'h')
const CONFIG = join(HOME, 'c')
const CWD = join(HOME, 'w')
mkdirSync(CONFIG, { recursive: true })
mkdirSync(CWD, { recursive: true })
process.env.MERCURY_CONFIG_DIR = CONFIG
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const launchDir = process.cwd()
process.chdir(CWD)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const j = (value: unknown): string => JSON.stringify(value)

const UNDECLARED: Record<string, unknown> = {
  notAConfigKey: true,
  verbose: true,
  autoUpdates: false,
  autoUpdatesProtectedForNative: true,
  cachedChangelog: '## 0.0.1\n- old',
  migrationVersion: 1,
}
const written = (cwd: string): Record<string, unknown> => ({
  ...UNDECLARED,
  theme: 'dark',
  hasCompletedOnboarding: true,
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, history: ['an older build wrote this'], notAProjectKey: 1 } },
})
const configPath = join(CONFIG, '.config.json')
const readDisk = (): Record<string, unknown> => JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
const carriesEveryKey = (file: Record<string, unknown>, cwd: string): string[] => {
  const missing: string[] = []
  for (const [key, value] of Object.entries(UNDECLARED)) if (j(file[key]) !== j(value)) missing.push(key)
  const project = (file.projects as Record<string, Record<string, unknown>> | undefined)?.[cwd]
  if (j(project?.history) !== j(['an older build wrote this'])) missing.push('projects.history')
  if (project?.notAProjectKey !== 1) missing.push('projects.notAProjectKey')
  return missing
}

section('§1 the module: every undeclared key is carried through a load and kept by a save')
{
  writeFileSync(configPath, `${JSON.stringify(written(CWD), null, 2)}\n`)
  const { enableConfigs, getGlobalConfig, readGlobalConfigAgain, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  readGlobalConfigAgain()
  const loaded = getGlobalConfig() as unknown as Record<string, unknown>
  check('a load carries every undeclared key as written, the project record\'s too', carriesEveryKey(loaded, CWD).length === 0, carriesEveryKey(loaded, CWD).join(','))
  check('the declared keys read their defaults: no undeclared key wrote one', loaded.toolOutput === 'compact', j(loaded.toolOutput))
  check('the file keeps its bytes on load', readFileSync(configPath, 'utf8') === `${JSON.stringify(written(CWD), null, 2)}\n`)
  saveGlobalConfig(current => ({ ...current, numStartups: current.numStartups + 1 }))
  const afterSave = readDisk()
  check('a save writes its own change', afterSave.numStartups === 1, j(afterSave.numStartups))
  check('…and keeps every undeclared key in the file, the project record\'s history too', carriesEveryKey(afterSave, CWD).length === 0, carriesEveryKey(afterSave, CWD).join(','))
  check('…and writes no declared key in an undeclared one\'s place', !('toolOutput' in afterSave), j(afterSave.toolOutput))
}

section('§2 the built product: a boot leaves the keys as written')
if (!existsSync(DIST)) {
  console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` for the built-product leg')
} else {
  const home = join(SHORT, 'p')
  const configDir = join(home, 'c')
  const cwd = join(home, 'w')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const bytes = `${JSON.stringify(written(cwd), null, 2)}\n`
  const path = join(configDir, '.config.json')
  writeFileSync(path, bytes)
  const nodeDir = dirname(process.execPath)
  const env: Record<string, string> = {
    HOME: home,
    PATH: `/usr/bin:/bin:${nodeDir}:${process.env.PATH ?? ''}`,
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
  const result = await new Promise<{ code: number | null; err: string }>(resolve => {
    const child = spawn('node', [DIST, 'health', '--json'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => (err += d))
    child.stdin.end()
    const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('exit', code => { clearTimeout(killer); resolve({ code, err }) })
  })
  check('the boot answers (exit 0 or 3)', result.code === 0 || result.code === 3, `${result.code} · ${result.err.trim().slice(0, 160)}`)
  const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  check('every undeclared key is still in the file as written, the project record\'s history too', carriesEveryKey(after, cwd).length === 0, carriesEveryKey(after, cwd).join(','))
  check('no declared key was written in an undeclared one\'s place', !('toolOutput' in after), j(after.toolOutput))
}

section('§3 the sources: no startup migration set')
{
  const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
  const main = read('src/main.tsx')
  const schema = read('src/utils/config/schema.ts')
  const loader = read('src/utils/config/globalConfig.ts')
  check('main.tsx runs no migration set and stamps no version', !/runMigrations|MIGRATION_VERSION|migrationVersion/.test(main))
  check('the schema declares no version stamp and no cached changelog', !/migrationVersion|cachedChangelog/.test(schema))
  check('the loader strips nothing from a project record', !/removeProjectHistory|history/.test(loader))
  check('no module rewrites a config key spelling', !existsSync(join(REPO, 'src/migrations/migrateVerboseToToolOutput.ts')) && !existsSync(join(REPO, 'src/migrations/migrateAutoUpdatesToSettings.ts')) && !/migrateChangelogFromConfig/.test(read('src/utils/releaseNotes.ts')))
}

process.chdir(launchDir)
rmSync(SHORT, { recursive: true, force: true })
console.log(`\nglobal config read as written: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
