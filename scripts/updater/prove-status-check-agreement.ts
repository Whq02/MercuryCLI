#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.env.MERCURY_PROOF_LAYOUT_SCRATCH) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'updstatus-home-')))
  const userHome = join(scratch, 'userhome')
  const configDir = join(scratch, 'config')
  const localAppData = join(userHome, 'AppData', 'Local')
  const appData = join(userHome, 'AppData', 'Roaming')
  for (const d of [userHome, configDir, localAppData, appData]) mkdirSync(d, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_PROOF_LAYOUT_SCRATCH: scratch,
    HOME: userHome,
    USERPROFILE: userHome,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    XDG_CONFIG_HOME: join(userHome, '.config'),
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_VERSIONS_DIR: join(configDir, 'versions'),
  }
  delete env.MERCURY_HOME
  delete env.HOMEDRIVE
  delete env.HOMEPATH
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env })
    process.exit(child.status ?? 1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const SCRATCH = process.env.MERCURY_PROOF_LAYOUT_SCRATCH!
const HOME = join(SCRATCH, 'config')
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const statusFixHint = 'change the options.status branch of update() in src/commands/verbs/update.ts (exit code, the report lines on stderr, the --json output and the pointerDamaged exit through failJson)'
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond ? '' : `${detail ? '; ' : ' — '}${statusFixHint}`}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { resolveLayoutRoots } = await import('../../src/platform/update-channel/installLayout.js')
const { update } = await import('../../src/commands/verbs/update.js')

const assertRootsUnder = (rootDir: string): void => {
  const roots = resolveLayoutRoots()
  const base = resolve(rootDir)
  for (const p of [roots.versionsDir, roots.binDir, roots.shimPath, ...(roots.shimSetPaths ?? [])]) {
    const rel = relative(base, resolve(p))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      console.log(`  [FAIL] SAFETY: resolved layout root escapes scratch: ${p}`)
      process.exit(1)
    }
  }
}
const drive = async (
  options: Record<string, boolean>,
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  let code: number | null = null
  const outChunks: string[] = []
  const errChunks: string[] = []
  const realExit = process.exit
  const realWrite = process.stdout.write.bind(process.stdout)
  const realConsoleError = console.error
  process.exit = ((c?: number) => {
    if (code === null) code = c ?? 0
  }) as never
  process.stdout.write = ((c: unknown) => {
    outChunks.push(String(c))
    return true
  }) as never
  console.error = ((...a: unknown[]) => {
    errChunks.push(a.map(String).join(' '))
  }) as never
  try {
    await update(options)
  } catch {
  } finally {
    process.exit = realExit
    process.stdout.write = realWrite
    console.error = realConsoleError
  }
  return { code, stdout: outChunks.join(''), stderr: errChunks.join('\n') }
}

section('§1 DAMAGED POINTER — STATUS SPEAKS THE VERDICT')
{
  assertRootsUnder(SCRATCH)
  check('every resolved layout root lies under scratch', true)
  mkdirSync(join(HOME, 'versions', 'current.txt'), { recursive: true })
  const r = await drive({ status: true })
  check('--status exits 1 on the unreadable pointer', r.code === 1, `code=${r.code}`)
  check(
    'the report still renders whole and names the unreadable pointer',
    r.stderr.includes('running version:') && r.stderr.includes('unreadable'),
    r.stderr.split('\n').find(l => l.includes('installed')) ?? '(no installed line)',
  )
  const j = await drive({ status: true, json: true })
  check('--status --json exits 1 too', j.code === 1, `code=${j.code}`)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(j.stdout)
  } catch {
    parsed = null
  }
  check(
    'the JSON is parseable and carries the pointer state',
    parsed !== null && (parsed as { installedPointer?: string }).installedPointer === 'unreadable',
    j.stdout.slice(0, 120),
  )
}

section('§2 HEALTHY INSTALL — STATUS EXITS 0 (control)')
{
  const HOME2 = join(SCRATCH, 'config-ok')
  mkdirSync(join(HOME2, 'versions'), { recursive: true })
  process.env.MERCURY_CONFIG_DIR = HOME2
  process.env.MERCURY_VERSIONS_DIR = join(HOME2, 'versions')
  assertRootsUnder(SCRATCH)
  writeFileSync(join(HOME2, 'versions', 'current.txt'), '1.0.0\n')
  const r = await drive({ status: true })
  check('--status exits 0', r.code === 0, `code=${r.code}`)
  check('the report is on stdout', r.stdout.includes('running version:'))
}


console.log(failures === 0 ? '\nprove-status-check-agreement: all green' : `\nprove-status-check-agreement: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
