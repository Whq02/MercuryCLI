#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
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

const { loginExportsCarried, toolShellEnv, withLoginExports } = await import('../../src/utils/subprocessEnv.js')
const { exec, setCwd } = await import('../../src/utils/Shell.js')
const { endEngineSessionFor, resolveShellEngine, runEngineCommand } = await import('../../src/utils/shell/engineSession.js')
setCwd(proj)

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
  check('cd -; pwd stays in the project when OLDPWD was set in Mercury env', lastLine(bareReturn.stdout) === proj, `stdout=${JSON.stringify(bareReturn.stdout)} expected=${JSON.stringify(proj)}`)

  const missingThenReturn = await run(`cd ${home}/zzz-missing; cd -; pwd`)
  check('cd <home>/zzz-missing; cd -; pwd stays in the project', lastLine(missingThenReturn.stdout) === proj, `stdout=${JSON.stringify(missingThenReturn.stdout)} expected=${JSON.stringify(proj)}`)

  const missingWrite = await run(`cd ${home}/zzz-missing; cd -; echo k >> .ssh/authorized_keys; pwd`)
  const leakedKeys = existsSync(join(home, '.ssh', 'authorized_keys'))
  check('missing entry + cd - never writes into <home>/.ssh/authorized_keys', !leakedKeys && lastLine(missingWrite.stdout) === proj, `leaked=${leakedKeys} stdout=${JSON.stringify(missingWrite.stdout)}`)

  const realReturn = await run(`cd ${home}; cd -; pwd`)
  check('a real return (cd <home>; cd -; pwd) still returns to the project', lastLine(realReturn.stdout) === proj, `stdout=${JSON.stringify(realReturn.stdout)} expected=${JSON.stringify(proj)}`)

  const cdpathProbe = await run('cd .ssh; pwd')
  check('cd .ssh; pwd stays in the project when CDPATH=.:<home> is in Mercury env', lastLine(cdpathProbe.stdout) === proj, `stdout=${JSON.stringify(cdpathProbe.stdout)} expected=${JSON.stringify(proj)}`)

  const cdpathWrite = await run('cd .ssh; echo k >> authorized_keys; pwd')
  const cdpathLeaked = existsSync(join(home, '.ssh', 'authorized_keys'))
  check('cd .ssh; echo k >> authorized_keys writes no key in <home>/.ssh under inherited CDPATH', !cdpathLeaked && lastLine(cdpathWrite.stdout) === proj, `leaked=${cdpathLeaked} stdout=${JSON.stringify(cdpathWrite.stdout)}`)

  const inlineCdpath = await run(`CDPATH=${altDir} cd sub; pwd`)
  check('in-line CDPATH=<x> cd y still works inside the same line', lastLine(inlineCdpath.stdout) === altSub, `stdout=${JSON.stringify(inlineCdpath.stdout)} expected=${JSON.stringify(altSub)}`)
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
      const enterHome = await runEngine(`cd ${home}; pwd`, proj)
      check('engine call 1 enters the scratch home', lastLine(enterHome.stdout) === home, `stdout=${JSON.stringify(enterHome.stdout)} expected=${JSON.stringify(home)}`)

      const secondCallReturn = await runEngine('cd -; pwd', proj)
      check('engine call 2 starts with no OLDPWD from call 1 (cd -; pwd prints project)', lastLine(secondCallReturn.stdout) === proj, `stdout=${JSON.stringify(secondCallReturn.stdout)} expected=${JSON.stringify(proj)}`)

      const pushHome = await runEngine(`pushd ${home} >/dev/null; pushd ${proj} >/dev/null; pwd`, proj)
      check('engine call 3 leaves the scratch home on the folder stack', lastLine(pushHome.stdout) === proj, `stdout=${JSON.stringify(pushHome.stdout)} expected=${JSON.stringify(proj)}`)

      const secondCallPopd = await runEngine('popd; pwd', proj)
      check('engine call 4 starts with an empty folder stack (popd; pwd prints project)', lastLine(secondCallPopd.stdout) === proj, `stdout=${JSON.stringify(secondCallPopd.stdout)} expected=${JSON.stringify(proj)}`)

      const engineRealReturn = await runEngine(`cd ${home}; cd -; pwd`, proj)
      check('engine single-call real return (cd <home>; cd -; pwd) still returns to the project', lastLine(engineRealReturn.stdout) === proj, `stdout=${JSON.stringify(engineRealReturn.stdout)} expected=${JSON.stringify(proj)}`)

      const engineSetCdpath = await runEngine(`export CDPATH=.:${home}; echo ok`, proj)
      check('engine call 5 sets CDPATH in the session', lastLine(engineSetCdpath.stdout) === 'ok', `stdout=${JSON.stringify(engineSetCdpath.stdout)}`)

      const engineAfterCdpath = await runEngine('echo "cdpath=${CDPATH:-unset}"; cd .ssh; pwd', proj)
      check('engine call 6 starts with CDPATH unset and cd .ssh stays in project', engineAfterCdpath.stdout.includes('cdpath=unset') && lastLine(engineAfterCdpath.stdout) === proj, `stdout=${JSON.stringify(engineAfterCdpath.stdout)} expected=${JSON.stringify(proj)}`)
    } finally {
      await endEngineSessionFor(owner)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\ntool-shell-starts-with-no-old-folder: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
