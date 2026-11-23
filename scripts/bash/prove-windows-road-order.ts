#!/usr/bin/env bun
import { plugin } from 'bun'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

if (process.argv.includes('--no-shell-leg')) {
  plugin({
    name: 'stub-color-diff-napi',
    setup(build) {
      build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
    },
  })
  const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const { formatError } = await import('../../src/tools/kit/toolErrors.ts')
  const told: string[] = []
  let appState = getDefaultAppState()
  const context = {
    options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
    abortController: new AbortController(),
    toolUseId: 'no-shell-call',
    appendSystemMessage: (message: { content?: unknown }) => { told.push(String(message.content)) },
  } as never
  const call = async (): Promise<string> => {
    try {
      await BashTool.call({ command: 'echo ran' }, context)
      return 'the command ran'
    } catch (error) {
      return formatError(error)
    }
  }
  const pinAsked = process.argv[process.argv.indexOf('--no-shell-leg') + 1]
  const asks = (): number => (pinAsked !== undefined && existsSync(pinAsked) ? readFileSync(pinAsked, 'utf8').trim().split('\n').length : 0)
  const offered = { atStart: 0, whenOffered: 0, toldWhenOffered: 0 }
  const shells: Record<string, string | null> = {}
  if (pinAsked !== undefined) {
    const road = await import('../../src/platform/shell/windowsShellRoad.ts')
    const { subprocessEnv } = await import('../../src/platform/processes/subprocessEnv.ts')
    const reads = (env: NodeJS.ProcessEnv): string => spawnSync('/bin/sh', ['-c', 'printf %s "${SHELL:-unset}"'], { env, encoding: 'utf8' }).stdout
    road.armWindowsShellRoad()
    shells.armed = process.env.SHELL ?? null
    const hookPrepared = { ...subprocessEnv({ stripProviderCredentials: true }) }
    offered.atStart = road.bashToolAvailable() ? asks() : -1
    await BashTool.prompt({ tools: [] } as never)
    offered.whenOffered = asks()
    offered.toldWhenOffered = told.length
    shells.child = reads(subprocessEnv())
    shells.mcpServer = reads(subprocessEnv({ stripProviderCredentials: true }))
    shells.hook = reads(road.hookBashEnv(hookPrepared))
  }
  const first = await call()
  const second = await call()
  if (pinAsked !== undefined) {
    try {
      const result = await BashTool.call({ command: 'printf %s "$SHELL"' }, context)
      shells.command = String(BashTool.mapToolResultToToolResultBlockParam(result.data, 'x').content).split('\n')[0] ?? null
    } catch (error) {
      shells.command = formatError(error)
    }
  }
  console.log(`NOSHELL ${JSON.stringify({ first, second, told, offered, asksInAll: asks(), shells })}`)
  process.exit(0)
}

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) console.log('    what to change: make the road match this label in src/platform/shell/shellRecord.ts (startedBashVersion, shellRecord, shellRow) or src/platform/shell/windowsShellRoad.ts (armWindowsShellRoad, shellFollowsTheRecord, NO_SHELL_WAYS_OUT, PIN_WAYS_OUT)')
}
const section = (title: string): void => console.log(`\n${title}`)
const source = (rel: string): string => join(ROOT, rel).replace(/\\/g, '\\\\')
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

console.log('============================================================')
console.log(' The order of the Windows road, and the one question every candidate answers')
console.log('============================================================')

const WIN = process.platform === 'win32'
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'windows-road-order-')))
const record = (await import('../../src/platform/shell/shellRecord.ts')) as unknown as {
  startedBashVersion?: (path: string, limitMs?: number) => Promise<string | null>
}
const { resolveBashPackDir } = await import('../../src/platform/shell/bashPack.ts')
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
    spawnSync(process.execPath, ['-e', `;(globalThis).MACRO = { VERSION: '0.0.0' }\nconst record = await import('${source('src/platform/shell/shellRecord.ts')}')\nvoid record.startedBashVersion('${waits}', 20000)\nsetTimeout(() => process.exit(0), 700)`], { cwd: scratch, encoding: 'utf8', timeout: 60_000 })
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
    const record = await import('${source('src/platform/shell/shellRecord.ts')}')
    const road = await import('${source('src/platform/shell/windowsShellRoad.ts')}')
    const shell = await import('${source('src/platform/shell/shellExec.ts')}')
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
      mkdirSync(join(scratch, 'row-bound'), { recursive: true })
      const asking = spawnSync(
        process.execPath,
        ['-e', `;(globalThis).MACRO = { VERSION: '0.0.0' }\nconst record = await import('${source('src/platform/shell/shellRecord.ts')}')\nconst started = Date.now()\nconst row = await record.shellRow(1500)\nconsole.log('ROW ' + JSON.stringify({ row, ms: Date.now() - started }))\nprocess.exit(0)`],
        { cwd: scratch, encoding: 'utf8', timeout: 60_000, env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'row-bound', 'config'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_SHELL_ENGINE: undefined, MERCURY_SHELL_PREFIX: undefined, MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: stubborn, BASH_ENV: undefined, ENV: undefined } },
      )
      const rowLine = (asking.stdout ?? '').split('\n').find(text => text.startsWith('ROW '))
      const bound = rowLine === undefined ? null : (JSON.parse(rowLine.slice(4)) as { row: { status: string; evidence: string; fix?: string }; ms: number })
      check(
        'the health row does not wait for a shell past a bound of its own: asked while the pin is still being asked, it answers at the bound, names the program being asked and how long it has, and says what to do',
        bound !== null && bound.ms < 4_000 && bound.row.status === 'warn' && bound.row.evidence.startsWith(`no shell has answered after 1.5 s: ${stubborn} is being asked for its bash version and has 5 s to answer`) && (bound.row.fix ?? '').startsWith('Run the health check again in a moment'),
        `${JSON.stringify(bound)} ${(asking.stderr ?? '').slice(-300)}`,
      )
    }
  }
  const engine = leg('no-bash', { MERCURY_WINDOWS_SHELL_ROAD: 'no-bash' })
  check('with no bash of any origin the bundled engine answers, or nothing does where its pack is absent', engine !== null && (engine.served === null ? engine.error !== null : engine.served.origin === 'engine' && answer(engine).brush === engine.served.version && answer(engine).zsh === 'none'), JSON.stringify(engine))
  check('…and the health row warns that the last road is the one that serves', engine?.row.status === 'warn', JSON.stringify(engine?.row))
  const none = leg('no-bash-system-pin', { MERCURY_WINDOWS_SHELL_ROAD: 'no-bash', MERCURY_SHELL_ENGINE: 'system' })
  check('with no bash of any origin and MERCURY_SHELL_ENGINE=system nothing answers: no shell is named, the Bash tool is off the roster', none !== null && none.served === null && none.kind === 'absent' && none.tool === false && (none.error ?? '').includes('No shell found'), JSON.stringify(none))

  const MODEL_LINE = 'Bash cannot run in this session: no shell starts on this machine, and no shell tool is offered.'
  const { NO_SHELL_WAYS_OUT, PIN_WAYS_OUT } = (await import('../../src/platform/shell/windowsShellRoad.ts')) as { NO_SHELL_WAYS_OUT?: string; PIN_WAYS_OUT?: string }
  const waysOut = NO_SHELL_WAYS_OUT ?? 'the road names no ways out'
  const pinWaysOut = PIN_WAYS_OUT ?? 'the road names no way out of a pin'
  const guide = readFileSync(join(ROOT, 'docs', 'INSTALL.md'), 'utf8').replace(/`/g, '').replace(/\s+/g, ' ')
  const adviceFree = (text: string): boolean => !/install|Git for Windows|MERCURY_GIT_BASH_PATH|restart/i.test(text)
  {
    mkdirSync(join(scratch, 'no-shell'), { recursive: true })
    const ran = spawnSync(process.execPath, [import.meta.path, '--no-shell-leg'], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'no-shell', 'config'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_SHELL_ENGINE: 'system', MERCURY_SHELL_PREFIX: undefined, MERCURY_GIT_BASH_PATH: undefined, MERCURY_WINDOWS_SHELL_ROAD: 'no-bash', BASH_ENV: undefined, ENV: undefined },
    })
    const line = (ran.stdout ?? '').split('\n').find(text => text.startsWith('NOSHELL '))
    const said = line === undefined ? null : (JSON.parse(line.slice(8)) as { first: string; second: string; told: string[] })
    const shown = `${JSON.stringify(said)} ${(ran.stderr ?? '').slice(-300)}`
    check('where no shell serves, a Bash call answers the model with one short line and no install advice, each time', said !== null && said.first === MODEL_LINE && said.second === MODEL_LINE && adviceFree(said.first), shown)
    check(
      'the user is told once, where the first Bash result stands: that the session has no shell tool, each candidate with why it did not serve, the ways out and to restart Mercury',
      said !== null && said.told.length === 1 && said.told[0]!.startsWith('No shell starts on this machine, so this session has no shell tool — passed over: ') && said.told[0]!.includes('the bundled engine is turned off') && said.told[0]!.endsWith(waysOut),
      shown,
    )
    check('the install guide has the ways out in the same words', guide.includes(waysOut), waysOut)
  }
  if (WIN || SYSTEM_BASH === null || SHIPPED === null) {
    console.log('  [SKIP] a pin that is no bash with the bash Mercury ships serving instead: this leg is run where an sh script can stand in and a bash pack is')
  } else {
    const asked = join(scratch, 'no-bash-pin-asked')
    const noBash = script('pinned-no-bash', `#!/bin/sh\necho asked >> '${asked}'\nexit 0\n`)
    mkdirSync(join(scratch, 'pin-passed'), { recursive: true })
    const ran = spawnSync(process.execPath, [import.meta.path, '--no-shell-leg', asked], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'pin-passed', 'config'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_SHELL_ENGINE: undefined, MERCURY_SHELL_PREFIX: undefined, MERCURY_GIT_BASH_PATH: noBash, MERCURY_WINDOWS_SHELL_ROAD: 'locate', BASH_ENV: undefined, ENV: undefined },
    })
    const line = (ran.stdout ?? '').split('\n').find(text => text.startsWith('NOSHELL '))
    const said = line === undefined ? null : (JSON.parse(line.slice(8)) as { first: string; second: string; told: string[]; offered: { atStart: number; whenOffered: number; toldWhenOffered: number }; asksInAll: number; shells?: Record<string, string | null> })
    const shown = `${JSON.stringify(said)} ${(ran.stderr ?? '').slice(-300)}`
    const version = shipped.state === 'ok' ? shipped.manifest.bashVersion : ''
    check('a pin that is no bash is not started at init: with the road armed and the roster read, it has not been asked', said?.offered.atStart === 0, shown)
    check('…it is asked once, when the Bash tool is first offered, and nothing is said yet', said?.offered.whenOffered === 1 && said.offered.toldWhenOffered === 0, shown)
    check('…the commands run under what serves instead, and the pin is not asked again', said?.first === 'the command ran' && said.second === 'the command ran' && said.asksInAll === 1, shown)
    check(
      "…and the user is told once, where the first Bash result stands: the pin's path, why it did not serve, what serves instead and what to change",
      said !== null && said.told.length === 1 && said.told[0] === `The shell you pinned does not serve this session — passed over: ${noBash}, named by MERCURY_GIT_BASH_PATH, did not answer as a bash: it printed no bash version. Serving instead: bash ${version} at ${SHIPPED} — the bash Mercury ships; the Bash tool runs under it, no bash 5 being installed on this machine. ${pinWaysOut}`,
      shown,
    )
    check('the install guide has that way out in the same words', guide.includes(pinWaysOut), pinWaysOut)
    const shells = said?.shells ?? {}
    check('at init the road puts the pinned program in SHELL, as before: nothing has asked it yet', shells.armed === noBash, JSON.stringify(shells))
    check("once the record has settled, a program Mercury starts reads in SHELL the shell that serves and not the program that was passed over: any child, and the environment an MCP server is started with", shells.child === SHIPPED && shells.mcpServer === SHIPPED, JSON.stringify(shells))
    check('…and so does a hook, whose environment is prepared before the record settles', shells.hook === SHIPPED, JSON.stringify(shells))
    check('…as a Bash command does', shells.command === SHIPPED, JSON.stringify(shells))
    mkdirSync(join(scratch, 'restored'), { recursive: true })
    const settledOnNothing = (before: string | undefined): string => {
      const restored = spawnSync(
        process.execPath,
        ['-e', `;(globalThis).MACRO = { VERSION: '0.0.0' }\nconst road = await import('${source('src/platform/shell/windowsShellRoad.ts')}')\nroad.armWindowsShellRoad()\nconst armed = process.env.SHELL ?? null\nroad.shellFollowsTheRecord(null)\nconsole.log('SHELLS ' + JSON.stringify({ armed, after: process.env.SHELL ?? null }))\nprocess.exit(0)`],
        { cwd: scratch, encoding: 'utf8', timeout: 60_000, env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'restored', 'config'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_SHELL_ENGINE: undefined, MERCURY_SHELL_PREFIX: undefined, MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: noBash, SHELL: before, BASH_ENV: undefined, ENV: undefined } },
      )
      return (restored.stdout ?? '').split('\n').find(text => text.startsWith('SHELLS ')) ?? `no answer · ${(restored.stderr ?? '').slice(-300)}`
    }
    check('where the record settles on nothing, SHELL is what it was before the road was armed', settledOnNothing('/bin/zsh') === `SHELLS ${JSON.stringify({ armed: noBash, after: '/bin/zsh' })}`, settledOnNothing('/bin/zsh'))
    check('…and empty where it was not set before, as on Windows: no program that was passed over is left in it', settledOnNothing(undefined) === `SHELLS ${JSON.stringify({ armed: noBash, after: '' })}`, settledOnNothing(undefined))
  }

  section('(4) the built bundle under Node, which is what a user runs: the same question, the same limit')
  {
    const distAt = process.argv.indexOf('--dist')
    const bundle = distAt === -1 ? join(ROOT, 'dist', 'mercury.mjs') : resolve(process.argv[distAt + 1]!)
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

      const { FIXTURE_API_KEY, seedFirstRun } = await import('../lib/firstRunSeed.ts')
      const { startFixtureApi } = await import('../lib/fixtureApi.ts')
      const view = join(scratch, 'dist-without-the-pack')
      mkdirSync(join(view, 'vendor'), { recursive: true })
      for (const name of readdirSync(dirname(bundle))) {
        if (name !== 'vendor' && lstatSync(join(dirname(bundle), name)).isFile()) copyFileSync(join(dirname(bundle), name), join(view, name))
      }
      for (const name of readdirSync(join(dirname(bundle), 'vendor'))) {
        if (name !== 'bash') symlinkSync(join(dirname(bundle), 'vendor', name), join(view, 'vendor', name))
      }
      type Part = { type?: string; tool_use_id?: string; content?: unknown; text?: string }
      type Session = { exit: number | null; results: Map<string, string>; offered: number; stderr: string; cwd: string; env: Record<string, string> }
      const session = async (name: string, program: string, pins: Record<string, string>): Promise<Session> => {
        const world = join(scratch, name)
        const [userHome, config, cwd] = ['user-home', 'config-home', 'work'].map(part => join(world, part)) as [string, string, string]
        for (const dir of [userHome, config, cwd]) mkdirSync(dir, { recursive: true })
        seedFirstRun(config, [cwd])
        const api = await startFixtureApi([
          { kind: 'tool_use', name: 'Bash', id: 'toolu_first', input: { command: 'echo first', description: 'the first command' } },
          { kind: 'tool_use', name: 'Bash', id: 'toolu_second', input: { command: 'echo second', description: 'the second command' } },
          { kind: 'text', text: 'done' },
        ])
        const env = {
          HOME: userHome,
          SHELL: '/bin/zsh',
          TERM: 'dumb',
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          TMPDIR: tmpdir(),
          MERCURY_CONFIG_DIR: config,
          MERCURY_DAEMON_DIR: join(config, 'daemon'),
          MERCURY_CREDENTIAL_STORE: 'file',
          MERCURY_LOCAL_PROBE_TARGETS: 'none',
          MERCURY_WINDOWS_SHELL_ROAD: 'locate',
          ...pins,
          ANTHROPIC_API_KEY: FIXTURE_API_KEY,
          ANTHROPIC_BASE_URL: api.url,
        }
        const child = spawn(nodeBinPath(), [program, 'run', '--mode', 'sovereign', '--model', 'claude-opus-4-8', '--format', 'text', name], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        const guard = setTimeout(() => child.kill('SIGKILL'), 150_000)
        const exit = await new Promise<number | null>(done => child.once('close', code => done(code)))
        clearTimeout(guard)
        const results = new Map<string, string>()
        let offered = 0
        for (const request of api.messageRequests()) {
          const body = request.body as { tools?: Array<{ name?: string }>; messages?: Array<{ role?: string; content?: unknown }> } | null
          if (body?.tools?.some(tool => tool.name === 'Bash')) offered++
          for (const message of body?.messages ?? []) {
            if (message.role !== 'user' || !Array.isArray(message.content)) continue
            for (const part of message.content as Part[]) {
              if (part.type !== 'tool_result' || part.tool_use_id === undefined) continue
              results.set(part.tool_use_id, typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? (part.content as Part[]).map(inner => (inner.type === 'text' ? (inner.text ?? '') : '')).join('') : '')
            }
          }
        }
        await api.close()
        return { exit, results, offered, stderr, cwd, env }
      }
      const starts = (file: string): number => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0)
      const pinAsked = join(scratch, 'pin-asked')
      const noBash = script('pinned-and-no-bash', `#!/bin/sh\necho asked >> '${pinAsked}'\nexit 0\n`)
      const nothing = await session('settles-on-nothing', join(view, 'mercury.mjs'), { MERCURY_GIT_BASH_PATH: noBash, MERCURY_SHELL_ENGINE: 'system' })
      const { results, offered, cwd, env } = nothing
      const told = nothing.stderr.split('\n').filter(text => text.includes('this session has no shell tool'))
      const shown = `exit ${String(nothing.exit)} · ${JSON.stringify([...results])} · stderr ${JSON.stringify(nothing.stderr.slice(-900))}`
      check('a session whose pin is no bash, whose pack is gone and whose engine is off still offers Bash (the roster stays as taken)', offered >= 2, `${offered} requests offered Bash · ${shown}`)
      check('…each Bash call answers the model with the one short line, and no install advice', (results.get('toolu_first') ?? '').includes(MODEL_LINE) && (results.get('toolu_second') ?? '').includes(MODEL_LINE) && adviceFree(`${results.get('toolu_first') ?? ''}${results.get('toolu_second') ?? ''}`), shown)
      check(
        '…and the user is told once on stderr: no shell tool, each candidate with why it did not serve, the ways out, restart Mercury',
        told.length === 1 && told[0]!.includes(`${noBash}, named by MERCURY_GIT_BASH_PATH, did not answer as a bash`) && told[0]!.includes('this install carries no bash of its own') && told[0]!.includes('the bundled engine is turned off') && told[0]!.endsWith(waysOut),
        shown,
      )
      check('…and the pin was asked once in the whole session: nothing starts a bash before the first request that offers Bash, and none is asked again', starts(pinAsked) === 1, `${starts(pinAsked)} starts`)
      const after = spawnSync(nodeBinPath(), [join(view, 'mercury.mjs'), 'health', '--json'], { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 })
      let row: { status?: string; evidence?: string; fix?: string } | undefined
      try {
        row = (JSON.parse(after.stdout) as { sections?: Array<{ checks: Array<{ id: string; status?: string; evidence?: string; fix?: string }> }> }).sections?.flatMap(part => part.checks).find(found => found.id === 'shell')
      } catch {
        row = undefined
      }
      check('…and the health row of that machine warns that a session has no shell tool, names what was passed over, and its fix is the same ways out', row?.status === 'warn' && (row.evidence ?? '').includes('a session here has no shell tool') && (row.evidence ?? '').includes('did not answer as a bash') && row.fix === waysOut, JSON.stringify(row))

      const servedAsked = join(scratch, 'served-pin-asked')
      const passedPin = script('pinned-and-passed-over', `#!/bin/sh\necho asked >> '${servedAsked}'\nexit 0\n`)
      const served = await session('pin-passed-over', bundle, { MERCURY_GIT_BASH_PATH: passedPin })
      const saidOfThePin = served.stderr.split('\n').filter(text => text.includes('The shell you pinned does not serve this session'))
      const servedShown = `exit ${String(served.exit)} · ${JSON.stringify([...served.results])} · stderr ${JSON.stringify(served.stderr.slice(-900))}`
      check('a session whose pin is no bash and whose pack stands runs both commands under the bash Mercury ships', (served.results.get('toolu_first') ?? '').includes('first') && (served.results.get('toolu_second') ?? '').includes('second'), servedShown)
      check(
        "…and the user is told once on stderr: the pin's path, why it did not serve, what serves instead and what to change",
        saidOfThePin.length === 1 && saidOfThePin[0]!.includes(`passed over: ${passedPin}, named by MERCURY_GIT_BASH_PATH, did not answer as a bash: it printed no bash version. Serving instead: bash `) && saidOfThePin[0]!.includes('the bash Mercury ships') && saidOfThePin[0]!.endsWith(pinWaysOut),
        servedShown,
      )
      check('…and that pin was asked once in the whole session', starts(servedAsked) === 1, `${starts(servedAsked)} starts`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-windows-road-order: ALL LAWS HOLD' : `\nprove-windows-road-order: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
