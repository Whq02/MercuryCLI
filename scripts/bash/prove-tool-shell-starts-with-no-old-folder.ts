#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tool-shell-oldpwd-')))
const proj = join(scratch, 'proj')
const home = join(scratch, 'home')
mkdirSync(proj, { recursive: true })
mkdirSync(join(home, '.ssh'), { recursive: true })
process.env.HOME = home
process.env.OLDPWD = home

const { toolShellEnv } = await import('../../src/utils/subprocessEnv.js')
const { exec, setCwd } = await import('../../src/utils/Shell.js')
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

  const posixEnv = toolShellEnv({ OLDPWD: home, PATH: '/usr/bin' }, { OLDPWD: home }, 'darwin')
  check('toolShellEnv drops OLDPWD from env and overrides on posix', !('OLDPWD' in posixEnv), JSON.stringify(posixEnv.OLDPWD))

  const winEnv = toolShellEnv({ oldpwd: home, PATH: 'C:\\Windows' }, { OldPwd: home }, 'win32')
  const winHasOldPwd = Object.keys(winEnv).some(key => key.toUpperCase() === 'OLDPWD')
  check('toolShellEnv drops OLDPWD case-insensitively on win32', !winHasOldPwd, JSON.stringify(Object.keys(winEnv).filter(key => key.toUpperCase() === 'OLDPWD')))

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
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\ntool-shell-starts-with-no-old-folder: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
