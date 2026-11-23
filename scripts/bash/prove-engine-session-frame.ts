#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.argv.includes('--drive')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const engine = process.argv[process.argv.indexOf('--drive') + 1]!
  const { runEngineCommand, endEngineSession } = await import('../../src/platform/shell/engineSession.ts')
  const { setCwd } = await import('../../src/platform/shell/shellExec.ts')
  setCwd(homedir())
  const run = async (command: string): Promise<{ code: number; text: string }> => {
    const result = await runEngineCommand(engine, command, { timeout: 30_000, signal: new AbortController().signal, cwd: homedir() }).result
    return { code: result.code, text: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
  }
  const extglob = await run('shopt -q extglob && echo extglob-on || echo extglob-off')
  const carried = await run('from_profile')
  await endEngineSession()
  console.log(`DROVE ${JSON.stringify({ extglob, carried })}`)
  process.exit(0)
}

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' The engine\'s session road with a snapshot and a prefix: the frame it writes puts the snapshot before the preamble')
console.log('============================================================')

if (process.platform === 'win32') {
  console.log('  [SKIP] this proof stands a bash in for the engine, which it can do on macOS and Linux; the session road on Windows has its own proofs')
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'engine-session-frame-')))
try {
  const userHome = join(scratch, 'user-home')
  mkdirSync(userHome)
  writeFileSync(join(userHome, '.profile'), 'shopt -s extglob\nfrom_profile() { echo fn-from-profile; }\n')
  const platform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const shipped = join(ROOT, 'vendor', 'bash', platform, 'bash')
  const real = existsSync(shipped) ? shipped : '/bin/bash'
  const frames = join(scratch, 'frames')
  const engine = join(scratch, 'engine')
  writeFileSync(
    engine,
    ['#!/bin/bash', 'keep=()', 'for word in "$@"; do', '  case "$word" in --no-config|--disable-color) ;; *) keep+=("$word") ;; esac', 'done', `tee -a ${JSON.stringify(frames)} | ${JSON.stringify(real)} "\${keep[@]}"`, ''].join('\n'),
  )
  chmodSync(engine, 0o755)

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(?:BASH_ENV|ENV|MERCURY_SHELL_ENGINE|MERCURY_WINDOWS_SHELL_ROAD)$/.test(key)) continue
    env[key] = value
  }
  Object.assign(env, { HOME: userHome, SHELL: '/bin/zsh', MERCURY_CONFIG_DIR: join(scratch, 'config-home'), MERCURY_SHELL_PREFIX: '/usr/bin/env' })
  const child = spawnSync(process.execPath, [import.meta.path, '--drive', engine], { encoding: 'utf8', env })
  const line = (child.stdout ?? '').split('\n').find(text => text.startsWith('DROVE '))
  const drove = line === undefined ? null : (JSON.parse(line.slice(6)) as { extglob: { code: number; text: string }; carried: { code: number; text: string } })
  const told = `${JSON.stringify(drove)} · exit ${String(child.status)} · ${JSON.stringify(String(child.stderr ?? '').slice(-300))}`

  const written = existsSync(frames) ? readFileSync(frames, 'utf8').split('\n') : []
  const first = (written[1] ?? '').replace(/\\x0a/g, '\n').replace(/\\\\/g, '\\')
  const sourceAt = first.search(/^source .*shell-snapshots\/snapshot-/m)
  const preambleAt = first.search(/^shopt -u extglob/m)
  check('the session is started with a snapshot: the stand-in engine took the login capture and the first frame sources it', sourceAt !== -1, JSON.stringify(first.slice(0, 300)) + ' · the first frame of the session must hold a source line for the snapshot: see the seeds built in spawnSession in src/platform/shell/engineSession.ts')
  check('under a prefix the first frame carries the preamble too', preambleAt !== -1, JSON.stringify(first.slice(0, 300)) + ' · the first frame must hold the glob preamble (shopt -u extglob): see the seeds built in spawnSession in src/platform/shell/engineSession.ts')
  check('the snapshot comes before the preamble in the frame the session road writes', sourceAt !== -1 && preambleAt !== -1 && sourceAt < preambleAt, JSON.stringify(first.slice(0, 300)) + ' · spawnSession in src/platform/shell/engineSession.ts must push the snapshot source line into seeds before the glob preamble')
  check('so an option the user\'s file switched on is off when a command runs: extglob reads off though ~/.profile set it', drove?.extglob.text === 'extglob-off', told + ' · the glob preamble must reach the session after the snapshot: see spawnSession in src/platform/shell/engineSession.ts')
  check('and what the snapshot carries is there: the function of ~/.profile runs', drove?.carried.text === 'fn-from-profile', told + ' · the snapshot source line must reach the session: see spawnSession in src/platform/shell/engineSession.ts')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-engine-session-frame: ALL LAWS HOLD' : `\nprove-engine-session-frame: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
