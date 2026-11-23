#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}fix the Windows shell road in src/platform/shell/windowsShellRoad.ts and the records in src/platform/shell/shellRecord.ts (systemShellRecord, shellRecord, shellLineWords, shellRow)` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const source = (rel: string): string => join(ROOT, rel).replace(/\\/g, '\\\\')

console.log('============================================================')
console.log(' The Windows road starts no zsh, whatever the seam and whatever $SHELL names')
console.log('============================================================')

const ZSH = ['/bin/zsh', '/usr/bin/zsh', '/opt/homebrew/bin/zsh'].find(path => existsSync(path)) ?? null
if (process.platform === 'win32') {
  console.log('  [SKIP] this proof walks the Windows road through its seam on a machine that has a zsh; on Windows itself the detector proof holds the order')
  process.exit(0)
}
if (ZSH === null) console.log('  (this machine has no zsh: the legs still run, with $SHELL naming a zsh that is not there)')

type Leg = {
  system: { path: string; version: string; origin: string } | null
  served: { path: string; version: string; origin: string } | null
  now: { path: string; origin: string } | null
  line: string
  ran: string | null
  error: string | null
  row: { status: string; evidence: string }
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'windows-road-no-zsh-')))
const PROBE = `
  ;(globalThis).MACRO = { VERSION: '0.0.0' }
  const record = await import('${source('src/platform/shell/shellRecord.ts')}')
  const shell = await import('${source('src/platform/shell/shellExec.ts')}')
  let system = null
  let error = null
  try { system = await record.systemShellRecord() } catch (e) { error = e instanceof Error ? e.message : String(e) }
  let served = null
  try { served = await record.shellRecord() } catch (e) { error = error ?? (e instanceof Error ? e.message : String(e)) }
  const line = await record.shellLineWords()
  let ran = null
  if (served !== null) {
    shell.setCwd(process.cwd())
    const handle = await shell.exec('printf "%s|%s" "\${BASH_VERSION:-none}" "\${ZSH_VERSION:-none}"', new AbortController().signal, 'bash', { timeout: 30000 })
    ran = (await handle.result).stdout
  }
  console.log('RESULT ' + JSON.stringify({ system, served, now: record.shellRecordNow(), line, ran, error, row: await record.shellRow() }))
  process.exit(0)
`

function leg(name: string, env: Record<string, string | undefined>): Leg | null {
  const home = join(scratch, name)
  const ran = spawnSync(process.execPath, ['-e', PROBE], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: join(home, 'config'),
      MERCURY_CREDENTIAL_STORE: 'file',
      HOME: home,
      SHELL: ZSH ?? '/bin/zsh',
      MERCURY_SHELL_ENGINE: undefined,
      MERCURY_SHELL_PREFIX: undefined,
      MERCURY_GIT_BASH_PATH: undefined,
      MERCURY_WINDOWS_SHELL_ROAD: undefined,
      ...env,
    },
  })
  const line = (ran.stdout ?? '').split('\n').find(text => text.startsWith('RESULT '))
  if (line === undefined) {
    check(`${name}: the leg answers`, false, `status ${String(ran.status)} · ${(ran.stderr ?? '').slice(-400)}`)
    return null
  }
  return JSON.parse(line.slice('RESULT '.length)) as Leg
}

const namesZsh = (value: string | null | undefined): boolean => value !== null && value !== undefined && /zsh/i.test(basename(value))

function holds(name: string, result: Leg | null): void {
  if (result === null) return
  check(`${name}: the record of the system road names no zsh`, !namesZsh(result.system?.path), JSON.stringify(result.system))
  check(`${name}: the record that serves a command names no zsh`, !namesZsh(result.served?.path) && !namesZsh(result.now?.path), JSON.stringify(result.served))
  check(`${name}: the prompt's shell line names no zsh`, !/zsh/i.test(result.line), result.line)
  check(`${name}: the health row names no zsh as the shell that runs`, !/zsh[^/]* — /i.test(result.row.evidence) && !result.row.evidence.includes('bash or zsh'), result.row.evidence)
  if (result.served !== null) check(`${name}: a command through the road runs in no zsh`, result.ran !== null && result.ran.endsWith('|none'), JSON.stringify(result.ran))
}

try {
  section(`(1) every value of the seam, with $SHELL naming ${ZSH ?? '/bin/zsh'}`)
  const pack = leg('pack', { MERCURY_WINDOWS_SHELL_ROAD: 'pack' })
  holds('seam pack', pack)
  check('seam pack: the bash Mercury ships serves', pack?.served?.origin === 'shipped' && /^5\./.test(pack.served.version), JSON.stringify(pack?.served))
  const locate = leg('locate', { MERCURY_WINDOWS_SHELL_ROAD: 'locate' })
  holds('seam locate', locate)
  check('seam locate: with no bash installed where the locator looks, the bash Mercury ships serves', locate?.served?.origin === 'shipped', JSON.stringify(locate?.served))
  const noBash = leg('no-bash', { MERCURY_WINDOWS_SHELL_ROAD: 'no-bash' })
  holds('seam no-bash', noBash)
  check('seam no-bash: the bundled engine serves, or nothing does', noBash !== null && (noBash.served === null || noBash.served.origin === 'engine'), JSON.stringify(noBash?.served))

  section('(2) a pin that names a zsh is not taken for a bash')
  const pinned = leg('pinned-zsh', { MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: ZSH ?? import.meta.path })
  holds('seam locate, MERCURY_GIT_BASH_PATH naming a zsh', pinned)
  check('…it is passed over and named, and the bash Mercury ships serves', pinned?.served?.origin === 'shipped' && pinned.row.evidence.includes('did not answer as a bash'), JSON.stringify({ served: pinned?.served, row: pinned?.row }))

  section('(3) the engine pin and the system pin')
  const enginePin = leg('engine-pin', { MERCURY_WINDOWS_SHELL_ROAD: 'pack', MERCURY_SHELL_ENGINE: 'brush' })
  holds('seam pack, MERCURY_SHELL_ENGINE=brush', enginePin)
  const systemPin = leg('system-pin', { MERCURY_WINDOWS_SHELL_ROAD: 'no-bash', MERCURY_SHELL_ENGINE: 'system' })
  holds('seam no-bash, MERCURY_SHELL_ENGINE=system', systemPin)
  check('seam no-bash with the engine turned off: nothing serves, and the error names the three roads', systemPin !== null && systemPin.served === null && (systemPin.error ?? '').includes('No shell found'), JSON.stringify({ served: systemPin?.served, error: systemPin?.error }))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-windows-road-no-zsh: ALL LAWS HOLD' : `\nprove-windows-road-no-zsh: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
