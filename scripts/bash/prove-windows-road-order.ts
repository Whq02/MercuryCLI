#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const source = (rel: string): string => join(ROOT, rel).replace(/\\/g, '\\\\')
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

console.log('============================================================')
console.log(' The order of the Windows road, and the one question every candidate answers')
console.log('============================================================')

const WIN = process.platform === 'win32'
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'windows-road-order-')))
const record = (await import('../../src/utils/shell/shellRecord.ts')) as unknown as {
  startedBashVersion?: (path: string, limitMs?: number) => Promise<string | null>
}
const { resolveBashPackDir } = await import('../../src/utils/shell/bashPack.ts')
const shipped = resolveBashPackDir()
const SHIPPED = shipped.state === 'ok' ? shipped.binaryPath : null
const SYSTEM_BASH = existsSync('/bin/bash') ? '/bin/bash' : null
const ZSH = ['/bin/zsh', '/usr/bin/zsh', '/opt/homebrew/bin/zsh'].find(path => existsSync(path)) ?? null
const A_BASH = SYSTEM_BASH ?? SHIPPED
const VERSION_ALONE = /^\d+\.\d+\.\d+\(\d+\)-[a-z0-9]+$/
const question = record.startedBashVersion
const ask = (path: string, limitMs?: number): Promise<string | null> => (typeof question === 'function' ? question(path, limitMs) : Promise.resolve('the record exports no version question'))
const script = (name: string, body: string): string => {
  const path = join(scratch, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}
const startFile = join(scratch, 'start-file.sh')
const marker = join(scratch, 'start-file-ran')
writeFileSync(startFile, `echo START-FILE-PRINT\n: > '${marker.replace(/\\/g, '/')}'\n`)

try {
  section('(1) the version question')
  check('the record owns the question, with its limit', typeof question === 'function')
  if (A_BASH === null) {
    console.log('  [SKIP] this machine has neither /bin/bash nor a bash pack: the question is asked where a bash is')
  } else {
    const plain = await ask(A_BASH)
    check(`a bash answers its version and nothing else (${A_BASH}: ${String(plain)})`, plain !== null && VERSION_ALONE.test(plain), String(plain))
    const before = { BASH_ENV: process.env.BASH_ENV, ENV: process.env.ENV }
    process.env.BASH_ENV = startFile
    process.env.ENV = startFile
    const withStartFiles = await ask(A_BASH)
    process.env.BASH_ENV = before.BASH_ENV
    process.env.ENV = before.ENV
    if (before.BASH_ENV === undefined) delete process.env.BASH_ENV
    if (before.ENV === undefined) delete process.env.ENV
    check('with BASH_ENV and ENV naming a file that prints, the answer is the same version, and the file was not read', withStartFiles === plain && !existsSync(marker), `${String(withStartFiles)} · marker ${existsSync(marker)}`)
  }
  check('a path that holds no program answers nothing', (await ask(join(scratch, 'nowhere', 'bash'))) === null)
  if (WIN || SYSTEM_BASH === null) {
    console.log('  [SKIP] the stand-in programs of this section are sh scripts: they are run on a machine with /bin/bash')
  } else {
    const noisy = script('noisy-bash', `#!/bin/sh\necho A-LINE-BEFORE\nexec ${SYSTEM_BASH} "$@"\n`)
    const answered = await ask(noisy)
    check('a program that prints a line before the version: the last line is the version', answered !== null && VERSION_ALONE.test(answered), String(answered))
    check('a program that prints its arguments back is not a bash: nothing is taken for a version', (await ask('/bin/echo')) === null, String(await ask('/bin/echo')))
    if (ZSH !== null) check(`a zsh is not a bash: ${ZSH} answers nothing`, (await ask(ZSH)) === null, String(await ask(ZSH)))
    const pidFile = join(scratch, 'stubborn.pid')
    const stubborn = script('stubborn-bash', `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 1; done\n`)
    const started = Date.now()
    const never = await ask(stubborn, 700)
    const took = Date.now() - started
    check(`a program that ignores SIGTERM and never answers: the question ends at its limit (700 ms asked, ${took} ms taken) with no answer`, never === null && took < 3_000, `${String(never)} after ${took} ms`)
    await sleep(400)
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : NaN
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    check('…and that program was killed, not asked: it is gone', Number.isInteger(pid) && !alive, `pid ${String(pid)} alive ${alive}`)
    const gone = (file: string): { pid: number; alive: boolean } => {
      const at = existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) : NaN
      try {
        process.kill(at, 0)
        process.kill(at, 'SIGKILL')
        return { pid: at, alive: true }
      } catch {
        return { pid: at, alive: false }
      }
    }
    const launchedFile = join(scratch, 'launched.pid')
    const launcher = script('launcher-bash', `#!/bin/sh\nsleep 300 &\necho $! > '${launchedFile}'\nwait\n`)
    const fromLauncher = await ask(launcher, 700)
    await sleep(400)
    const launched = gone(launchedFile)
    check('a candidate that is a launcher: at the limit the program it started is ended with it', fromLauncher === null && Number.isInteger(launched.pid) && !launched.alive, JSON.stringify({ fromLauncher, launched }))
    const openFile = join(scratch, 'open.pid')
    const waits = script('waits-bash', `#!/bin/sh\necho $$ > '${openFile}'\nexec sleep 300\n`)
    spawnSync(process.execPath, ['-e', `;(globalThis).MACRO = { VERSION: '0.0.0' }\nconst record = await import('${source('src/utils/shell/shellRecord.ts')}')\nvoid record.startedBashVersion('${waits}', 20000)\nsetTimeout(() => process.exit(0), 700)`], { cwd: scratch, encoding: 'utf8', timeout: 60_000 })
    await sleep(300)
    const leftOpen = gone(openFile)
    check('a process that ends while a question is open ends the program it asked', Number.isInteger(leftOpen.pid) && !leftOpen.alive, JSON.stringify(leftOpen))
    if (A_BASH !== null) {
      const names = ['BASH_FUNC_printf%%', 'BASH_FUNC_builtin%%']
      for (const name of names) process.env[name] = '() { echo not-a-version; }'
      const withFunctions = await ask(A_BASH)
      for (const name of names) delete process.env[name]
      check('exported functions named printf and builtin do not answer for the bash: the question runs no function of the user\'s', withFunctions !== null && VERSION_ALONE.test(withFunctions), String(withFunctions))
    }
  }

  type Leg = { served: { path: string; version: string; origin: string } | null; ran: string | null; error: string | null; row: { status: string; evidence: string }; kind: string; tool: boolean; ms: number }
  const PROBE = `
    ;(globalThis).MACRO = { VERSION: '0.0.0' }
    const record = await import('${source('src/utils/shell/shellRecord.ts')}')
    const road = await import('${source('src/utils/shell/windowsShellRoad.ts')}')
    const shell = await import('${source('src/utils/Shell.ts')}')
    const started = Date.now()
    let served = null
    let error = null
    try { served = await record.shellRecord() } catch (e) { error = e instanceof Error ? e.message : String(e) }
    const ms = Date.now() - started
    let ran = null
    if (served !== null) {
      shell.setCwd(process.cwd())
      const handle = await shell.exec('printf "%s|%s|%s" "\${BASH_VERSION:-none}" "\${BRUSH_VERSION:-none}" "\${ZSH_VERSION:-none}"', new AbortController().signal, 'bash', { timeout: 30000 })
      ran = (await handle.result).stdout
    }
    console.log('RESULT ' + JSON.stringify({ served, ran, error, row: await record.shellRow(), kind: road.windowsShellRoadActive() ? road.windowsBashRoad().kind : 'off', tool: road.bashToolAvailable(), ms }))
    process.exit(0)
  `
  const leg = (name: string, env: Record<string, string | undefined>): Leg | null => {
    const home = join(scratch, name)
    mkdirSync(home, { recursive: true })
    const ran = spawnSync(process.execPath, ['-e', PROBE], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, MERCURY_CONFIG_DIR: join(home, 'config'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_SHELL_ENGINE: undefined, MERCURY_SHELL_PREFIX: undefined, MERCURY_GIT_BASH_PATH: undefined, MERCURY_WINDOWS_SHELL_ROAD: undefined, BASH_ENV: undefined, ENV: undefined, ...env },
    })
    const line = (ran.stdout ?? '').split('\n').find(text => text.startsWith('RESULT '))
    if (line === undefined) {
      check(`${name}: the leg answers`, false, `status ${String(ran.status)} · ${(ran.stderr ?? '').slice(-400)}`)
      return null
    }
    return JSON.parse(line.slice('RESULT '.length)) as Leg
  }
  const answer = (result: Leg | null): { bash: string; brush: string; zsh: string } => {
    const [bash = '', brush = '', zsh = ''] = (result?.ran ?? '').split('|')
    return { bash, brush, zsh }
  }

  section("(2) this machine's own road, with BASH_ENV and ENV set in the window")
  {
    rmSync(marker, { force: true })
    const own = leg('own-road', { BASH_ENV: startFile, ENV: startFile })
    check('the record names a version and nothing else (before: the line the start file printed stood before the version)', own?.served !== null && own?.served !== undefined && (own.served.origin === 'engine' || VERSION_ALONE.test(own.served.version)), JSON.stringify(own?.served))
  }

  section('(3) the order: which shell answers a command')
  if (WIN) {
    const host = leg('host', {})
    check("this machine's own road: a bash 5 that is installed serves, else the one Mercury ships, else the engine", host?.served !== null && host !== null && (host.served?.origin === 'system' ? Number(/^\d+/.exec(answer(host).bash)?.[0]) >= 5 : host.served?.origin === 'shipped' ? /^5\./.test(answer(host).bash) : answer(host).brush !== 'none'), JSON.stringify(host))
    console.log(`  (this machine: ${JSON.stringify(host?.served)} · ${host?.row.evidence ?? ''})`)
  } else if (SYSTEM_BASH === null) {
    console.log('  [SKIP] this machine has no /bin/bash to stand in for an installed bash')
  } else {
    const installed = spawnSync(SYSTEM_BASH, ['--norc', '--noprofile', '-c', 'printf %s "$BASH_VERSION"'], { encoding: 'utf8' }).stdout
    const pinned = leg('pinned', { MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: SYSTEM_BASH })
    check(`the bash MERCURY_GIT_BASH_PATH names serves first, whatever its version (${installed})`, pinned?.served?.origin === 'system' && pinned.served.path === SYSTEM_BASH && pinned.served.version === installed && answer(pinned).bash === installed && pinned.kind === 'git-bash', JSON.stringify(pinned))
    check('…and the health row says who named it', (pinned?.row.evidence ?? '').includes('named by MERCURY_GIT_BASH_PATH') && pinned?.row.status === 'ok', pinned?.row.evidence)
  }
  if (SHIPPED === null) {
    console.log('  [SKIP] this checkout holds no bash pack for this machine: the legs of the shipped road are run where one is')
  } else {
    const pack = leg('pack', { MERCURY_WINDOWS_SHELL_ROAD: 'pack' })
    const packVersion = shipped.state === 'ok' ? shipped.manifest.bashVersion : ''
    check(`with no bash installed the bash Mercury ships answers (${packVersion})`, pack?.served?.origin === 'shipped' && pack.served.path === SHIPPED && answer(pack).bash === packVersion && answer(pack).brush === 'none' && pack.kind === 'shipped', JSON.stringify(pack))
    const kept = leg('pack-system-pin', { MERCURY_WINDOWS_SHELL_ROAD: 'pack', MERCURY_SHELL_ENGINE: 'system' })
    check('…and MERCURY_SHELL_ENGINE=system keeps it: system means a bash, never the engine', kept?.served?.origin === 'shipped' && answer(kept).bash === packVersion, JSON.stringify(kept?.served))
    if (!WIN && ZSH !== null) {
      const zshPin = leg('zsh-pin-system', { MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: ZSH, MERCURY_SHELL_ENGINE: 'system' })
      check(`a pin that names a zsh, with the engine turned off (before: the record read ${ZSH} as a bash and the Bash tool was offered under it): the record names the bash Mercury ships`, zshPin?.served?.origin === 'shipped' && zshPin.served.path === SHIPPED && answer(zshPin).zsh === 'none' && answer(zshPin).bash === packVersion, JSON.stringify(zshPin))
      check('…and the health row says the pin was passed over, and why', (zshPin?.row.evidence ?? '').includes(`${ZSH}, named by MERCURY_GIT_BASH_PATH, did not answer as a bash`), zshPin?.row.evidence)
    }
    if (!WIN && SYSTEM_BASH !== null) {
      const stubborn = script('stubborn-pinned-bash', "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n")
      const passed = leg('stubborn-pin', { MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: stubborn })
      check(`a pin that names a program which ignores SIGTERM and never answers: the record settles all the same (${String(passed?.ms)} ms), on the bash Mercury ships`, passed?.served?.origin === 'shipped' && (passed?.ms ?? 99_999) < 12_000 && answer(passed).bash === packVersion, JSON.stringify(passed))
    }
  }
  const engine = leg('no-bash', { MERCURY_WINDOWS_SHELL_ROAD: 'no-bash' })
  check('with no bash of any origin the bundled engine answers, or nothing does where its pack is absent', engine !== null && (engine.served === null ? engine.error !== null : engine.served.origin === 'engine' && answer(engine).brush === engine.served.version && answer(engine).zsh === 'none'), JSON.stringify(engine))
  check('…and the health row warns that the last road is the one that serves', engine?.row.status === 'warn', JSON.stringify(engine?.row))
  const none = leg('no-bash-system-pin', { MERCURY_WINDOWS_SHELL_ROAD: 'no-bash', MERCURY_SHELL_ENGINE: 'system' })
  check('with no bash of any origin and MERCURY_SHELL_ENGINE=system nothing answers: no shell is named, the Bash tool is off the roster', none !== null && none.served === null && none.kind === 'absent' && none.tool === false && (none.error ?? '').includes('No shell found'), JSON.stringify(none))

  section('(4) the built bundle under Node, which is what a user runs: the same question, the same limit')
  {
    const bundle = join(ROOT, 'dist', 'mercury.mjs')
    if (WIN || SYSTEM_BASH === null || !existsSync(bundle)) {
      console.log(`  [SKIP] ${existsSync(bundle) ? 'the stand-in program is an sh script: this leg is run on a machine with /bin/bash' : 'dist/mercury.mjs absent — build first (the gate prebuilds)'}`)
    } else {
      const { nodeBinPath } = await import('../lib/nodeBin.ts')
      const pidFile = join(scratch, 'bundle-stubborn.pid')
      const stubborn = script('bundle-stubborn-bash', `#!/bin/sh\ntrap '' TERM\necho $$ > '${pidFile}'\nwhile :; do sleep 1; done\n`)
      const home = join(scratch, 'bundle-home')
      const started = Date.now()
      const health = spawnSync(nodeBinPath(), [bundle, 'health', '--json'], {
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_SHELL_ENGINE: undefined, MERCURY_SHELL_PREFIX: undefined, MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: stubborn, BASH_ENV: startFile, ENV: startFile },
      })
      const took = Date.now() - started
      let shell: { status?: string; evidence?: string } | undefined
      try {
        shell = (JSON.parse(health.stdout) as { sections?: Array<{ checks: Array<{ id: string; status: string; evidence: string }> }> }).sections?.flatMap(part => part.checks).find(row => row.id === 'shell')
      } catch {
        shell = undefined
      }
      check(`health --json answers with the pin that never answers passed over, and names why (${took} ms)`, shell !== undefined && (shell.evidence ?? '').includes('did not answer as a bash') && !/START-FILE-PRINT/.test(shell.evidence ?? ''), `${JSON.stringify(shell)} ${(health.stderr ?? '').slice(-300)}`)
      await sleep(400)
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : NaN
      let alive = true
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      check('…and under Node too that program was killed, not asked: it is gone', Number.isInteger(pid) && !alive, `pid ${String(pid)} alive ${alive}`)
      const asked = join(scratch, 'asked-at-start')
      const counting = script('counting-bash', `#!/bin/sh\necho asked >> '${asked}'\nexec ${SYSTEM_BASH} "$@"\n`)
      const version = spawnSync(nodeBinPath(), [bundle, '--version'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'version-home'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_SHELL_ENGINE: undefined, MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: counting } })
      check('--version on the Windows road asks no bash for its version: nothing is started before a command or the shell line needs the record', version.status === 0 && /^Mercury /.test(version.stdout) && !existsSync(asked), `status ${String(version.status)} · ${version.stdout.slice(0, 60)} · asked ${existsSync(asked)}`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-windows-road-order: ALL LAWS HOLD' : `\nprove-windows-road-order: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
