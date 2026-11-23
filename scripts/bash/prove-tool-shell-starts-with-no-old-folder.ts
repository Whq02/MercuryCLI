#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tool-shell-oldpwd-')))
const proj = join(scratch, 'proj')
const home = join(scratch, 'home')
const altDir = join(proj, 'alt')
const altSub = join(altDir, 'sub')
mkdirSync(altSub, { recursive: true })
mkdirSync(join(home, '.ssh'), { recursive: true })
process.env.HOME = home
process.env.OLDPWD = home
process.env.CDPATH = `.:${home}`

const { loginExportsCarried, toolShellEnv, withLoginExports } = await import('../../src/platform/processes/subprocessEnv.js')
const { exec, setCwd } = await import('../../src/platform/shell/shellExec.js')
const { endEngineSessionFor, resolveShellEngine, runEngineCommand } = await import('../../src/platform/shell/engineSession.js')
const { locateGitBash } = await import('../../src/platform/files/windowsPaths.js')
setCwd(proj)

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitBash = (() => {
  if (process.platform !== 'win32') return null
  const located = locateGitBash()
  return 'path' in located ? located.path : null
})()
const cygpath = (flag: '-u' | '-w', value: string): string => {
  if (gitBash === null) return value
  try {
    return execFileSync(gitBash, ['-c', `cygpath ${flag} -- "$1"`, '_', value], { encoding: 'utf8', windowsHide: true }).trim() || value
  } catch {
    return value
  }
}
const normalizePath = (value: string): string => {
  if (process.platform !== 'win32') return value
  const native = value.startsWith('/') ? cygpath('-w', value) : value
  let canonical = native
  try {
    if (existsSync(native)) canonical = realpathSync(native)
  } catch {
    canonical = native
  }
  return canonical.replaceAll('/', '\\').toLowerCase()
}
const samePath = (a: string, b: string): boolean => normalizePath(a) === normalizePath(b)
const missingHome = join(home, 'zzz-missing')
const bashAltDir = process.platform === 'win32' ? cygpath('-u', altDir) : altDir
if (process.platform === 'win32') process.env.CDPATH = `.:${cygpath('-u', home)}`

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

async function run(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const shell = await exec(command, new AbortController().signal, 'bash', {
    timeout: 20_000,
    cwd: proj,
    preventCwdChanges: true,
  } as never)
  const result = await shell.result
  return {
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    code: result.code,
  }
}

try {
  console.log('============================================================')
  console.log(' the tool shell starts with no inherited OLDPWD')
  console.log('============================================================')

  const posixEnv = toolShellEnv({ OLDPWD: home, CDPATH: `.:${home}`, PATH: '/usr/bin' }, { OLDPWD: home, CDPATH: `.:${home}` }, 'darwin')
  check('toolShellEnv drops OLDPWD and CDPATH from env and overrides on posix', !('OLDPWD' in posixEnv) && !('CDPATH' in posixEnv), JSON.stringify({ OLDPWD: posixEnv.OLDPWD, CDPATH: posixEnv.CDPATH }))

  const winEnv = toolShellEnv({ oldpwd: home, cdpath: `.:${home}`, PATH: 'C:\\Windows' }, { OldPwd: home, CdPath: `.:${home}` }, 'win32')
  const winHasStripped = Object.keys(winEnv).some(key => key.toUpperCase() === 'OLDPWD' || key.toUpperCase() === 'CDPATH')
  check('toolShellEnv drops OLDPWD and CDPATH case-insensitively on win32', !winHasStripped, JSON.stringify(Object.keys(winEnv).filter(key => key.toUpperCase() === 'OLDPWD' || key.toUpperCase() === 'CDPATH')))

  const carriedLogin = loginExportsCarried({ CDPATH: `.:${home}`, OLDPWD: home, CUSTOM_LOGIN_VAR: '1' })
  check('loginExportsCarried drops CDPATH and OLDPWD while keeping normal exports', !('CDPATH' in carriedLogin) && !('OLDPWD' in carriedLogin) && carriedLogin.CUSTOM_LOGIN_VAR === '1', JSON.stringify(carriedLogin))

  const mergedLogin = withLoginExports({ PATH: '/usr/bin' }, { CDPATH: `.:${home}`, OLDPWD: home, CUSTOM_LOGIN_VAR: '1' }, [], 'darwin')
  check('withLoginExports drops CDPATH and OLDPWD while carrying normal exports', !('CDPATH' in mergedLogin) && !('OLDPWD' in mergedLogin) && mergedLogin.CUSTOM_LOGIN_VAR === '1', JSON.stringify(mergedLogin))
  const lastLine = (text: string): string => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? ''

  const bareReturn = await run('cd -; pwd')
  check('cd -; pwd stays in the project when OLDPWD was set in Mercury env', samePath(lastLine(bareReturn.stdout), proj), `stdout=${JSON.stringify(bareReturn.stdout)} expected=${JSON.stringify(proj)}`)

  const missingThenReturn = await run(`cd ${shQuote(missingHome)}; cd -; pwd`)
  check('cd <home>/zzz-missing; cd -; pwd stays in the project', samePath(lastLine(missingThenReturn.stdout), proj), `stdout=${JSON.stringify(missingThenReturn.stdout)} expected=${JSON.stringify(proj)}`)

  const missingWrite = await run(`cd ${shQuote(missingHome)}; cd -; echo k >> .ssh/authorized_keys; pwd`)
  const leakedKeys = existsSync(join(home, '.ssh', 'authorized_keys'))
  check('missing entry + cd - never writes into <home>/.ssh/authorized_keys', !leakedKeys && samePath(lastLine(missingWrite.stdout), proj), `leaked=${leakedKeys} stdout=${JSON.stringify(missingWrite.stdout)}`)

  const realReturn = await run(`cd ${shQuote(home)}; cd -; pwd`)
  check('a real return (cd <home>; cd -; pwd) still returns to the project', samePath(lastLine(realReturn.stdout), proj), `stdout=${JSON.stringify(realReturn.stdout)} expected=${JSON.stringify(proj)}`)

  const cdpathProbe = await run('cd .ssh; pwd')
  check('cd .ssh; pwd stays in the project when CDPATH=.:<home> is in Mercury env', samePath(lastLine(cdpathProbe.stdout), proj), `stdout=${JSON.stringify(cdpathProbe.stdout)} expected=${JSON.stringify(proj)}`)

  const cdpathWrite = await run('cd .ssh; echo k >> authorized_keys; pwd')
  const cdpathLeaked = existsSync(join(home, '.ssh', 'authorized_keys'))
  check('cd .ssh; echo k >> authorized_keys writes no key in <home>/.ssh under inherited CDPATH', !cdpathLeaked && samePath(lastLine(cdpathWrite.stdout), proj), `leaked=${cdpathLeaked} stdout=${JSON.stringify(cdpathWrite.stdout)}`)

  const inlineCdpath = await run(`CDPATH=${shQuote(bashAltDir)} cd sub; pwd`)
  check('in-line CDPATH=<x> cd y still works inside the same line', samePath(lastLine(inlineCdpath.stdout), altSub), `stdout=${JSON.stringify(inlineCdpath.stdout)} expected=${JSON.stringify(altSub)}`)
  const engine = resolveShellEngine('brush')
  check('the bundled shell engine is available for session checks', engine.engine === 'brush', engine.engine === 'brush' ? engine.binaryPath : engine.reason)
  if (engine.engine === 'brush') {
    const owner = 'proof-tool-shell-oldpwd'
    const runEngine = async (command: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> => {
      const cmd = runEngineCommand(engine.binaryPath, command, {
        timeout: 20_000,
        signal: new AbortController().signal,
        cwd,
        owner,
      })
      const result = await cmd.result
      return {
        stdout: String(result.stdout ?? '').trim(),
        stderr: String(result.stderr ?? '').trim(),
        code: result.code,
      }
    }
    try {
      const enterHome = await runEngine(`cd ${shQuote(home)}; pwd`, proj)
      check('engine call 1 enters the scratch home', samePath(lastLine(enterHome.stdout), home), `stdout=${JSON.stringify(enterHome.stdout)} expected=${JSON.stringify(home)}`)

      const secondCallReturn = await runEngine('cd -; pwd', proj)
      check('engine call 2 starts with no OLDPWD from call 1 (cd -; pwd prints project)', samePath(lastLine(secondCallReturn.stdout), proj), `stdout=${JSON.stringify(secondCallReturn.stdout)} expected=${JSON.stringify(proj)}`)

      const pushHome = await runEngine(`pushd ${shQuote(home)} >/dev/null; pushd ${shQuote(proj)} >/dev/null; pwd`, proj)
      check('engine call 3 leaves the scratch home on the folder stack', samePath(lastLine(pushHome.stdout), proj), `stdout=${JSON.stringify(pushHome.stdout)} expected=${JSON.stringify(proj)}`)

      const secondCallPopd = await runEngine('popd; pwd', proj)
      check('engine call 4 starts with an empty folder stack (popd; pwd prints project)', samePath(lastLine(secondCallPopd.stdout), proj), `stdout=${JSON.stringify(secondCallPopd.stdout)} expected=${JSON.stringify(proj)}`)

      const engineRealReturn = await runEngine(`cd ${shQuote(home)}; cd -; pwd`, proj)
      check('engine single-call real return (cd <home>; cd -; pwd) still returns to the project', samePath(lastLine(engineRealReturn.stdout), proj), `stdout=${JSON.stringify(engineRealReturn.stdout)} expected=${JSON.stringify(proj)}`)

      const engineSetCdpath = await runEngine(`export CDPATH=.:${shQuote(home)}; echo ok`, proj)
      check('engine call 5 sets CDPATH in the session', lastLine(engineSetCdpath.stdout) === 'ok', `stdout=${JSON.stringify(engineSetCdpath.stdout)}`)

      const engineAfterCdpath = await runEngine('echo "cdpath=${CDPATH:-unset}"; cd .ssh; pwd', proj)
      check('engine call 6 starts with CDPATH unset and cd .ssh stays in project', engineAfterCdpath.stdout.includes('cdpath=unset') && samePath(lastLine(engineAfterCdpath.stdout), proj), `stdout=${JSON.stringify(engineAfterCdpath.stdout)} expected=${JSON.stringify(proj)}`)
    } finally {
      await endEngineSessionFor(owner)
    }
  }

  const { createPowerShellProvider } = await import('../../src/platform/shell/powershellProvider.js')
  const { getCachedPowerShellPath } = await import('../../src/platform/shell/powershellDetection.js')
  const psProvider = createPowerShellProvider('pwsh')
  const psBuilt = await psProvider.buildExecCommand('cd -', { id: 'old-folder-check' })
  const clearAt = psBuilt.commandString.indexOf('Set-Location -LiteralPath .')
  const userAt = psBuilt.commandString.indexOf('\ncd -')
  check(
    'PowerShell provider prelude resets location history to the start folder before the command',
    clearAt !== -1 && userAt !== -1 && clearAt < userAt,
    `clearAt=${clearAt} userAt=${userAt}`,
  )

  const psPath = await getCachedPowerShellPath()
  if (psPath === null) {
    console.log('  [SKIP] no pwsh/PowerShell binary on this host; skipping live PowerShell location-history checks')
  } else {
    const runPs = async (command: string): Promise<{ stdout: string; stderr: string; code: number }> => {
      const shell = await exec(command, new AbortController().signal, 'powershell', {
        timeout: 20_000,
        cwd: proj,
        preventCwdChanges: true,
      } as never)
      const result = await shell.result
      return {
        stdout: String(result.stdout ?? '').trim(),
        stderr: String(result.stderr ?? '').trim(),
        code: result.code,
      }
    }
    const psVer = await runPs('$PSVersionTable.PSVersion.Major')
    const psMajor = Number(lastLine(psVer.stdout))

    const psCdDash = await runPs('cd -; (Get-Location).Path')
    check('PowerShell cd - as first command stays in the project', samePath(lastLine(psCdDash.stdout), proj), `stdout=${JSON.stringify(psCdDash.stdout)} expected=${JSON.stringify(proj)}`)

    const psSetLocDash = await runPs('Set-Location -; (Get-Location).Path')
    check('PowerShell Set-Location - as first command stays in the project', samePath(lastLine(psSetLocDash.stdout), proj), `stdout=${JSON.stringify(psSetLocDash.stdout)} expected=${JSON.stringify(proj)}`)

    const psRepeatDash = await runPs('cd -; cd -; cd -; (Get-Location).Path')
    check('PowerShell repeated cd - as first commands stay in the project', samePath(lastLine(psRepeatDash.stdout), proj), `stdout=${JSON.stringify(psRepeatDash.stdout)} expected=${JSON.stringify(proj)}`)

    if (Number.isFinite(psMajor) && psMajor >= 7) {
      const escapedHome = home.split("'").join("''")
      const psRealReturn = await runPs(`Set-Location -LiteralPath '${escapedHome}'; Set-Location -; (Get-Location).Path`)
      check('PowerShell 7 real return (Set-Location <home>; Set-Location -) returns to the project', samePath(lastLine(psRealReturn.stdout), proj), `stdout=${JSON.stringify(psRealReturn.stdout)} expected=${JSON.stringify(proj)}`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\ntool-shell-starts-with-no-old-folder: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
