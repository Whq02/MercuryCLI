#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { plugin } from 'bun'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SEAM = 'MERCURY_WINDOWS_SHELL_ROAD'
const PIN = 'MERCURY_GIT_BASH_PATH'
const ENGINE_PIN = 'MERCURY_SHELL_ENGINE'
const GIT_LS = 'GIT-USR-BIN-LS'
const WINDOW_LS = 'WINDOW-LS'
const SERVED = '${BRUSH_VERSION:-system}'
const SEEN = `printf '%s|%s|%s' "${SERVED}" "$SHELL" "$PATH"`
const NOT_FOUND = 'error: command not found: ls'
const OWN_NAME = 'prove-engine-git-programs'

type Depth = 'line' | 'session' | 'all'
type Call = { out: string; code: number }
type LegReport = {
  leg: string
  engineBinary: string | null
  arm: string
  calls: Record<string, Call>
  health: { road: string; absent: boolean; line: string; fix: string | null }
  manual: string
  readings: string
  processPath: string
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const flagAt = (flag: string): string | null => (process.argv.includes(flag) ? (process.argv[process.argv.indexOf(flag) + 1] ?? null) : null)
const legArg = flagAt('--leg')

async function runLeg(leg: string, depth: Depth): Promise<LegReport> {
  const { exec } = await import('../../src/utils/Shell.ts')
  const engine = await import('../../src/utils/shell/engineSession.ts')
  const road = await import('../../src/utils/shell/windowsShellRoad.ts')
  const { getInitialSettings } = await import('../../src/utils/settings/settings.ts')
  const { getSimplePrompt } = await import('../../src/tools/BashTool/prompt.ts')
  road.armWindowsShellRoad()
  const resolution = engine.resolveShellEngine(getInitialSettings().shell?.engine)
  const signal = (): AbortSignal => new AbortController().signal
  const call = async (command: string, options: Record<string, unknown> = {}): Promise<Call> => {
    const handle = await exec(command, signal(), 'bash', { timeout: 30_000, ...options })
    const result = await handle.result
    return { out: result.stdout.trim(), code: result.code }
  }
  const streamed = async (command: string): Promise<Call> => {
    let chunks = ''
    const handle = await exec(command, signal(), 'bash', {
      timeout: 30_000,
      preventCwdChanges: true,
      onStdout: (chunk: string) => {
        chunks += chunk
      },
    })
    const result = await handle.result
    for (let waited = 0; waited < 40 && chunks === ''; waited++) await sleep(50)
    return { out: chunks.trim(), code: result.code }
  }
  const calls: Record<string, Call> = {}
  let readings = ''
  if (depth !== 'line') {
    calls.mainLs = await call('ls')
    calls.mainSeen = await call(SEEN)
    calls.crewLs = await call('ls', { owner: 'agent-git-programs' })
    calls.crewSeen = await call(SEEN, { owner: 'agent-git-programs' })
    const { checkReadOnlyConstraints } = await import('../../src/tools/BashTool/readOnlyValidation.ts')
    const { shellSelfProtectionReason, shellMercurySecretPath } = await import('../../src/utils/permissions/shellProtectedPaths.ts')
    const table: Record<string, unknown> = {}
    for (const command of [
      'ls -la node_modules',
      'cat notes.txt | head -2',
      'grep -n x notes.txt',
      'find . -name "*.md" | wc -l',
      'sort names.txt',
      'ls "a b"',
      'sort -o out names.txt',
      'find . -name x -delete',
      'rm -rf x',
      `pkill -f ${OWN_NAME}`,
      'pkill -f some-other-program',
      `cat ${proofHome}/.credentials.json`,
      `ls ${proofHome}`,
    ]) {
      const readOnly = await checkReadOnlyConstraints({ command, cwd: ROOT }, false)
      table[command] = {
        readOnly: readOnly.behavior,
        why: readOnly.notReadOnly?.kind ?? null,
        kill: await shellSelfProtectionReason(command, false, ROOT),
        secret: await shellMercurySecretPath(command, false, ROOT),
      }
    }
    readings = JSON.stringify(table).split(proofHome).join('<home>')
  }
  if (depth === 'all') {
    calls.background = await call(SEEN, { shouldAutoBackground: true, backgroundIntent: true })
    calls.inherit = await call(SEEN, { shouldAutoBackground: true, inheritSessionEnv: true })
    calls.monitor = await streamed(SEEN)
  }
  const described = road.describeWindowsShellRoad()
  const report: LegReport = {
    leg,
    engineBinary: resolution.engine === 'brush' ? resolution.binaryPath : null,
    arm: resolution.arm,
    calls,
    health: { road: described.road, absent: described.absent, line: described.line, fix: described.fix ?? null },
    manual: sha(getSimplePrompt()),
    readings,
    processPath: process.env.PATH ?? '',
  }
  await engine.endEngineSession()
  return report
}

if (legArg !== null) {
  const settings = flagAt('--settings')
  if (settings !== null) writeFileSync(join(proofHome, 'settings.json'), settings)
  const report = await runLeg(legArg, (flagAt('--depth') ?? 'line') as Depth)
  console.log(`GIT-PROGRAMS-LEG ${JSON.stringify(report)}`)
  process.exit(0)
}

for (const name of Object.keys(process.env)) {
  if (name.startsWith('MERCURY_') && !['MERCURY_CONFIG_DIR', 'MERCURY_CREDENTIAL_STORE', 'MERCURY_DESKTOP_DRIVER'].includes(name)) delete process.env[name]
}

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title} ──`)

type Programs = { from: string; dir?: string; key?: string; path?: string }
const WIN = process.platform === 'win32'
const road = (await import('../../src/utils/shell/windowsShellRoad.ts')) as unknown as {
  toolPrograms?: (env: NodeJS.ProcessEnv, world?: unknown) => Programs
  withGitPrograms?: (env: NodeJS.ProcessEnv, world?: unknown) => NodeJS.ProcessEnv
}
const { shellEngineArmWords } = await import('../../src/utils/shell/shellEngineArm.ts')
const { resolveBrushPackDir } = await import('../../src/utils/shell/brushPack.ts')
const programs: (env: NodeJS.ProcessEnv, world?: unknown) => Programs = road.toolPrograms ?? (() => ({ from: 'path' }))
const withGit: (env: NodeJS.ProcessEnv, world?: unknown) => NodeJS.ProcessEnv = road.withGitPrograms ?? (env => env)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'engine-git-programs-')))

const legEnvBase = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('MERCURY_') || name === 'SHELL') delete env[name]
  return env
}

function runLegProcess(leg: string, depth: Depth, extra: Record<string, string>, settings?: unknown): Promise<{ report: LegReport | null; text: string }> {
  const legTmp = realpathSync(mkdtempSync(join(scratch, `${leg}-tmp-`)))
  const env: NodeJS.ProcessEnv = { ...legEnvBase(), HOME: join(scratch, 'user'), TMPDIR: legTmp, MERCURY_TMPDIR: legTmp, MERCURY_CREDENTIAL_STORE: 'file', ...extra }
  const args = [import.meta.path, '--leg', leg, '--depth', depth, ...(settings === undefined ? [] : ['--settings', JSON.stringify(settings)])]
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.on('close', () => {
      clearTimeout(timer)
      const line = text.split('\n').find(l => l.startsWith('GIT-PROGRAMS-LEG '))
      resolvePromise({ report: line ? (JSON.parse(line.slice('GIT-PROGRAMS-LEG '.length)) as LegReport) : null, text })
    })
  })
}

const seen = (call: Call | undefined): { served: string; shell: string; path: string } => {
  const [served = '', shell = '', ...rest] = (call?.out ?? '').split('|')
  return { served, shell, path: rest.join('|') }
}

async function twoAtATime<T>(starts: Array<() => Promise<T>>): Promise<T[]> {
  const answers: T[] = []
  let next = 0
  const lane = async (): Promise<void> => {
    for (let at = next++; at < starts.length; at = next++) answers[at] = await starts[at]!()
  }
  await Promise.all([lane(), lane()])
  return answers
}

try {
  section('§1 the rule, read through its platform seam: a Windows host, the path grammar of Windows, real files in a scratch tree')
  {
    const tree = join(scratch, 'rule')
    const file = (...parts: string[]): string => {
      const path = join(tree, ...parts)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, '')
      return path
    }
    const dir = (...parts: string[]): string => {
      const path = join(tree, ...parts)
      mkdirSync(path, { recursive: true })
      return path
    }
    const gitBash = file('Program Files', 'Git', 'bin', 'bash.exe')
    file('Program Files', 'Git', 'usr', 'bin', 'ls.exe')
    dir('Program Files', 'Git', 'mingw64', 'bin')
    dir('Program Files', 'Git', 'cmd')
    const usrBin = join(tree, 'Program Files', 'Git', 'usr', 'bin')
    const bareGit = file('Bare', 'Git', 'bin', 'bash.exe')
    dir('Bare', 'Git', 'usr', 'bin')
    const msysBash = file('msys64', 'usr', 'bin', 'bash.exe')
    file('msys64', 'usr', 'bin', 'ls.exe')
    const system32 = dir('Windows', 'System32')
    const tools = dir('Users', 'o', 'tools')
    const window = `${system32};${tools}`
    const found = (bash: string): unknown => ({ platform: 'win32', gitBash: { path: bash } })
    const noGit = { platform: 'win32', gitBash: { absent: true } }

    check('the road owns the rule: toolPrograms reads where the ordinary programs come from, withGitPrograms hands the shell its environment', typeof road.toolPrograms === 'function' && typeof road.withGitPrograms === 'function')

    const env: NodeJS.ProcessEnv = { SystemRoot: 'C:\\Windows', Path: window, PATHEXT: '.COM;.EXE;.BAT;.CMD', OTHER: 'kept' }
    const before = JSON.stringify(env)
    const fired = withGit(env, found(gitBash))
    const entries = (fired.Path ?? '').split(';')
    check('Git for Windows found and no ls on the path: <Git>\\usr\\bin is the first entry of the path the shell is given', fired.Path === `${usrBin};${window}` && entries[0] === usrBin, JSON.stringify(fired.Path))
    check('…usr\\bin alone: one entry more than the window had, and neither mingw64\\bin nor cmd among them', entries.length === 3 && !entries.some(entry => /mingw64|[\\/]cmd$/.test(entry)), JSON.stringify(fired.Path))
    check('…under the name the path already had (no second path variable), every other variable byte for byte', JSON.stringify(Object.keys(fired)) === JSON.stringify(Object.keys(env)) && JSON.stringify({ ...fired, Path: window }) === before)
    check('…and the environment it was handed is left as it was: the rule answers with a new one', fired !== env && JSON.stringify(env) === before)
    const reading = programs(env, found(gitBash))
    check('…the reading names the folder, the variable and the whole new path', reading.from === 'git' && reading.dir === usrBin && reading.key === 'Path' && reading.path === `${usrBin};${window}`, JSON.stringify(reading))
    for (const key of ['PATH', 'Path', 'path']) {
      const spelled = withGit({ [key]: window }, found(gitBash))
      check(`the path variable spelled ${key} keeps that spelling`, JSON.stringify(spelled) === JSON.stringify({ [key]: `${usrBin};${window}` }), JSON.stringify(spelled))
    }
    check('an empty path, or none at all, becomes that one folder with no separator beside it', withGit({ Path: '' }, found(gitBash)).Path === usrBin && JSON.stringify(withGit({ OTHER: 'kept' }, found(gitBash))) === JSON.stringify({ OTHER: 'kept', PATH: usrBin }))
    check('a bash located inside a usr\\bin of its own (MSYS2, or a pin at the real bash) lends that folder', programs({ Path: window }, found(msysBash)).dir === join(tree, 'msys64', 'usr', 'bin'), JSON.stringify(programs({ Path: window }, found(msysBash))))
    file('Users', 'o', 'scripts', 'ls')
    const bare = withGit({ Path: `${system32};${join(tree, 'Users', 'o', 'scripts')}` }, found(gitBash))
    check('a file named ls with no extension is not a program the engine can start on Windows: the rule still fires', (bare.Path ?? '').split(';')[0] === usrBin, JSON.stringify(bare.Path))

    for (const name of ['ls.exe', 'ls.com', 'ls.cmd', 'ls.bat']) {
      const holder = join(tree, 'has', name)
      file('has', name, name)
      for (const [where, path] of [['last', `${window};${holder}`], ['first', `${holder};${window}`], ['quoted', `${system32};"${holder}"`]] as Array<[string, string]>) {
        const already = { Path: path, OTHER: 'kept' }
        check(`${name} already on the path (${where}): the very environment comes back, byte for byte`, withGit(already, found(gitBash)) === already && programs(already, found(gitBash)).from === 'path')
      }
    }
    const absent = { Path: window }
    check('no Git for Windows found and no ls: nothing is borrowed, the environment comes back as it was', withGit(absent, noGit) === absent)
    check('…and the reading says the programs are nowhere', programs(absent, noGit).from === 'nowhere', JSON.stringify(programs(absent, noGit)))
    check('a located bash whose usr\\bin holds no ls lends nothing', withGit(absent, found(bareGit)) === absent)
    check('…and that reading is nowhere too', programs(absent, found(bareGit)).from === 'nowhere', JSON.stringify(programs(absent, found(bareGit))))
    check('off the Windows road (a Mac, Linux) the rule is not read: the environment comes back whatever stands on the machine', withGit(absent, null) === absent && programs(absent, null).from === 'path')
    if (WIN) console.log('  [SKIP] the host default off the road — this host is the road')
    else check('this host, with no seam set, is off the road: the default answers the very environment', withGit(absent) === absent && programs(absent).from === 'path')
  }

  if (WIN) {
    console.log('\n  [SKIP] the live legs walk the Windows road through its seam on a Mac or Linux host, with a stand-in Git made of two scripts; on a Windows host the road is the product\'s own, and those lines are read there by hand')
  } else {
    const pack = resolveBrushPackDir()
    const VERSION = pack.state === 'ok' ? pack.manifest.version : 'unresolved'
    const git = join(scratch, 'Program Files', 'Git')
    const gitBash = join(git, 'bin', 'bash')
    const gitDir = join(git, 'usr', 'bin')
    const window = join(scratch, 'window')
    const windowLs = join(scratch, 'window-ls')
    for (const made of [join(git, 'bin'), gitDir, window, windowLs, join(scratch, 'user')]) mkdirSync(made, { recursive: true })
    const script = (path: string, word: string): void => {
      writeFileSync(path, `#!/bin/sh\necho ${word}\n`)
      chmodSync(path, 0o755)
    }
    script(join(gitDir, 'ls'), GIT_LS)
    script(join(windowLs, 'ls'), WINDOW_LS)
    const standIn = existsSync('/bin/bash')
    if (standIn) symlinkSync('/bin/bash', gitBash)
    section('the stand: the engine pack, and a stand-in Git under a folder with a space in its name')
    check('the shell engine pack resolves on this tree (build or fetch it first: bun run scripts/vendor/fetch-brush.ts)', pack.state === 'ok', pack.state === 'ok' ? '' : pack.note)
    check('a bash stands in for the located Git Bash on this host', standIn, 'no /bin/bash')

    const located = { [SEAM]: 'locate', [PIN]: gitBash }
    const [fired, firedPin, firedSetting, lsThere, systemPin, nothing, noBashLs, posix] = await twoAtATime([
      () => runLegProcess('fired', 'all', { ...located, PATH: window }),
      () => runLegProcess('fired-pin', 'line', { ...located, [ENGINE_PIN]: 'brush', PATH: window }),
      () => runLegProcess('fired-setting', 'line', { ...located, PATH: window }, { shell: { engine: 'brush' } }),
      () => runLegProcess('ls-there', 'session', { ...located, PATH: windowLs }),
      () => runLegProcess('system-pin', 'session', { ...located, [ENGINE_PIN]: 'system', PATH: window }),
      () => runLegProcess('nothing', 'all', { [SEAM]: 'no-bash', PATH: window }),
      () => runLegProcess('no-bash-ls', 'line', { [SEAM]: 'no-bash', PATH: windowLs }),
      () => runLegProcess('posix', 'session', { [ENGINE_PIN]: 'brush', [PIN]: gitBash, PATH: window }),
    ])
    const ruled = `${gitDir}:${window}`
    const engineLine = (binary: string, arm: string, tail: string): string => `the shell engine at ${binary} — the Bash tool runs under it (${shellEngineArmWords(arm as never)})${tail}`
    const borrowed = `; ls, cat, grep and the like come from Git for Windows (${gitDir}, first on its path)`
    const noBashLine = (binary: string, tail: string): string => `the bundled shell engine at ${binary} — no bash.exe was found on this machine, so the Bash tool runs under Mercury's own bash-compatible engine${tail}`
    const ownProcess: Array<[string, string]> = [['background', 'a run_in_background call'], ['inherit', 'an inherit_session_env call'], ['monitor', 'a Monitor-shaped call']]

    section('§2 the Windows road with Git found and no ls on the window\'s path: the Bash tool finds ls')
    {
      const r = fired.report
      check('the leg ran and reported', r !== null, fired.text.slice(-1500))
      if (r !== null) {
        const main = seen(r.calls.mainSeen)
        const crew = seen(r.calls.crewSeen)
        check('the engine is the road, by the Windows default', (r.engineBinary ?? '').includes('brush') && r.arm === 'windows', JSON.stringify({ engine: r.engineBinary, arm: r.arm }))
        check('ls in the session runs Git\'s (before: error: command not found: ls, exit 127)', r.calls.mainLs?.out === GIT_LS && r.calls.mainLs.code === 0, JSON.stringify(r.calls.mainLs))
        check('the session\'s shell is the engine, and the first entry of its path is <Git>/usr/bin with the window\'s own path after it', main.served === VERSION && main.shell === r.engineBinary && main.path === ruled, JSON.stringify(r.calls.mainSeen))
        check('…that folder has a space in its name, as Program Files has, and it is one entry of the path all the same', gitDir.includes(' ') && main.path.split(':').length === 2 && main.path.split(':')[0] === gitDir, main.path)
        check('ls in a crewmate\'s session runs Git\'s too', r.calls.crewLs?.out === GIT_LS && r.calls.crewLs.code === 0, JSON.stringify(r.calls.crewLs))
        check('…and the crewmate\'s session has the same path as the main conversation\'s', crew.served === VERSION && crew.path === ruled && crew.path === main.path, JSON.stringify(r.calls.crewSeen))
        for (const [name, words] of ownProcess) {
          const own = seen(r.calls[name])
          check(`${words} is not the engine's on this road: Git's own bash runs it, and its path has no entry of the rule's`, own.served === 'system' && own.shell === gitBash && !own.path.split(':').includes(gitDir), JSON.stringify(r.calls[name]))
        }
        check('Mercury\'s own path is as it was: the rule changes the shell\'s environment and nothing else', r.processPath === window, r.processPath)
      }
    }

    section('§3 the same road with an ls already resolving: the path is byte for byte the window\'s')
    {
      const r = lsThere.report
      check('the leg ran and reported', r !== null, lsThere.text.slice(-1500))
      if (r !== null) {
        check('ls is the window\'s own, in the session and in a crewmate\'s', r.calls.mainLs?.out === WINDOW_LS && r.calls.crewLs?.out === WINDOW_LS, JSON.stringify([r.calls.mainLs, r.calls.crewLs]))
        check('the engine session\'s path is the window\'s path, nothing before it', seen(r.calls.mainSeen).served === VERSION && seen(r.calls.mainSeen).path === windowLs && seen(r.calls.crewSeen).path === windowLs, JSON.stringify([r.calls.mainSeen, r.calls.crewSeen]))
      }
    }

    section('§4 the roads the rule leaves alone: the system shell kept by the pin, a machine with no Git, a POSIX host')
    {
      const kept = systemPin.report
      check('the system-pin leg ran and reported', kept !== null, systemPin.text.slice(-1500))
      if (kept !== null) {
        const plain = seen(kept.calls.mainSeen)
        check('MERCURY_SHELL_ENGINE=system on the Windows road: Git\'s own bash serves the plain call and no engine is armed', kept.engineBinary === null && plain.served === 'system' && plain.shell === gitBash, JSON.stringify(kept.calls.mainSeen))
        check('…and its path has no entry of the rule\'s', !plain.path.split(':').includes(gitDir), plain.path)
      }
      const none = nothing.report
      check('the no-Git leg ran and reported', none !== null, nothing.text.slice(-1500))
      if (none !== null) {
        check('no bash.exe found: the engine arms itself, and ls answers as before (command not found, exit 127)', none.arm === 'no-bash' && none.calls.mainLs?.out === NOT_FOUND && none.calls.mainLs.code === 127, JSON.stringify(none.calls.mainLs))
        check('…the session\'s path is the window\'s, byte for byte', seen(none.calls.mainSeen).path === window && seen(none.calls.crewSeen).path === window, JSON.stringify([none.calls.mainSeen, none.calls.crewSeen]))
        for (const [name, words] of ownProcess) {
          const own = seen(none.calls[name])
          check(`…${words} is the engine's own process there, and takes the same path as the session`, own.served === VERSION && own.shell === none.engineBinary && own.path === seen(none.calls.mainSeen).path, JSON.stringify(none.calls[name]))
        }
      }
      const off = posix.report
      check('the POSIX leg ran and reported', off !== null, posix.text.slice(-1500))
      if (off !== null) {
        check('a POSIX host with the engine pinned, a stand-in Git named and no ls on its path: ls answers as before', off.arm === 'pin' && off.calls.mainLs?.out === NOT_FOUND && off.calls.mainLs.code === 127, JSON.stringify(off.calls.mainLs))
        check('…and the path the engine is given is the host\'s, byte for byte, in the session and in a crewmate\'s', seen(off.calls.mainSeen).served === VERSION && seen(off.calls.mainSeen).path === window && seen(off.calls.crewSeen).path === window, JSON.stringify([off.calls.mainSeen, off.calls.crewSeen]))
      }
    }

    section('§5 the health report\'s Bash tool shell line: two lines say where the ordinary programs are, the others stand as they were')
    {
      type Leg = { report: LegReport | null; text: string }
      const line = (leg: Leg): string => leg.report?.health.line ?? ''
      const binary = (leg: Leg): string => leg.report?.engineBinary ?? ''
      const stands = (leg: Leg): boolean => leg.report?.health.road === 'engine' && leg.report.health.absent === false && leg.report.health.fix === null
      check('the rule fired, the Windows default', line(fired) === engineLine(binary(fired), 'windows', borrowed), line(fired))
      check('the rule fired, the MERCURY_SHELL_ENGINE pin', firedPin.report?.arm === 'pin' && line(firedPin) === engineLine(binary(firedPin), 'pin', borrowed), line(firedPin) || firedPin.text.slice(-600))
      check('the rule fired, the Shell engine setting', firedSetting.report?.arm === 'setting' && line(firedSetting) === engineLine(binary(firedSetting), 'setting', borrowed), line(firedSetting) || firedSetting.text.slice(-600))
      check('nothing to borrow (no Git for Windows found, no ls on the path)', line(nothing) === noBashLine(binary(nothing), '; ls, cat, grep and the like are not on this machine: Git for Windows carries them'), line(nothing))
      check('an ls already there, Git found: the line as it stood', line(lsThere) === engineLine(binary(lsThere), 'windows', ', no Git dependency'), line(lsThere))
      check('an ls already there, no Git found: the line as it stood', noBashLs.report?.arm === 'no-bash' && line(noBashLs) === noBashLine(binary(noBashLs), ''), line(noBashLs) || noBashLs.text.slice(-600))
      check('the system shell kept by the pin: the git-bash line as it stood', line(systemPin) === `git-bash at ${gitBash} — found on this machine; the Bash tool runs under it`, line(systemPin))
      check('a POSIX host: the line as it stood', line(posix) === 'the system shell (bash or zsh on PATH) — the Bash tool runs under it', line(posix))
      check('the row does not move with the words: the engine road, present, with no fix, in all six engine legs', [fired, firedPin, firedSetting, nothing, lsThere, noBashLs].every(stands), JSON.stringify([fired, firedPin, firedSetting, nothing, lsThere, noBashLs].map(leg => leg.report?.health)))
    }

    section('§6 the permission layer reads a command by its name: the same readings whichever ls would run')
    {
      const a = fired.report?.readings ?? ''
      const b = lsThere.report?.readings ?? ''
      const c = posix.report?.readings ?? ''
      const d = nothing.report?.readings ?? ''
      type Reading = { readOnly: string; why: string | null; kill: string | null; secret: string | null }
      let table: Record<string, Reading> = {}
      try {
        table = JSON.parse(a) as Record<string, Reading>
      } catch {
        table = {}
      }
      check('thirteen commands read by the read-only table, the kill guard and the credential floor in each leg', Object.keys(table).length === 13, a.slice(0, 300))
      check('the readings are byte for byte the same with the rule fired, with an ls already there, with no Git and on a POSIX host', a !== '' && a === b && a === c && a === d, JSON.stringify({ fired: sha(a), lsThere: sha(b), posix: sha(c), nothing: sha(d) }))
      check('the read-only table: ls, cat | head, grep, find | wc, sort and a quoted name with a space read as reads', ['ls -la node_modules', 'cat notes.txt | head -2', 'grep -n x notes.txt', 'find . -name "*.md" | wc -l', 'sort names.txt', 'ls "a b"'].every(command => table[command]?.readOnly === 'allow'), JSON.stringify(table))
      check('…and sort -o, find -delete and rm do not', table['sort -o out names.txt']?.why === 'form' && table['find . -name x -delete']?.why === 'form' && table['rm -rf x']?.why === 'not-on-list', JSON.stringify(table))
      check('the kill guard refuses a kill by this process\'s own name and lets another name through', (table[`pkill -f ${OWN_NAME}`]?.kill ?? '').startsWith(`Killing by image ${OWN_NAME} is refused`) && table['pkill -f some-other-program']?.kill === null, JSON.stringify(table[`pkill -f ${OWN_NAME}`]))
      check('the credential floor names the credential file a cat would read, and not the home\'s listing', table['cat <home>/.credentials.json']?.secret === '<home>/.credentials.json' && table['ls <home>']?.secret === null, JSON.stringify(table['cat <home>/.credentials.json']))
      console.log(`  (readings sha256 ${sha(a).slice(0, 16)})`)
    }

    section('§7 the Bash tool\'s manual does not move with the rule')
    {
      check('the manual is the same text with the rule fired and with an ls already there (the engine by the Windows default)', fired.report !== null && fired.report.manual === lsThere.report?.manual, JSON.stringify([fired.report?.manual, lsThere.report?.manual]))
      check('…and the same with nothing to borrow and with an ls there on a machine with no Git', nothing.report !== null && nothing.report.manual === noBashLs.report?.manual, JSON.stringify([nothing.report?.manual, noBashLs.report?.manual]))
      console.log(`  (manual sha256 ${[fired, nothing, systemPin, posix].map(leg => (leg.report?.manual ?? '').slice(0, 12)).join(' ')}: the Windows default, no bash, the system pin, a POSIX host with the engine pinned)`)
    }

    section('§8 the built bundle through the seam: health --json and the readiness row carry the same line')
    {
      const DIST = join(ROOT, 'dist', 'mercury.mjs')
      if (!existsSync(DIST)) {
        console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
      } else {
        const { nodeBinPath } = await import('../lib/nodeBin.ts')
        const NODE = nodeBinPath()
        type Row = { status?: string; evidence?: string; state?: string; detail?: string }
        const health = (label: string, extra: Record<string, string>): Promise<{ shell: Row | null; ready: Row | null; text: string }> => {
          const home = realpathSync(mkdtempSync(join(scratch, `${label}-health-home-`)))
          const env: NodeJS.ProcessEnv = { ...legEnvBase(), HOME: join(scratch, 'user'), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_OPERATOR: 'sam', ...extra }
          return new Promise(resolvePromise => {
            const child = spawn(NODE, [DIST, 'health', '--json'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
            let out = ''
            let err = ''
            child.stdout!.on('data', (chunk: Buffer) => {
              out += chunk.toString('utf8')
            })
            child.stderr!.on('data', (chunk: Buffer) => {
              err += chunk.toString('utf8')
            })
            const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
            child.on('close', () => {
              clearTimeout(timer)
              try {
                const cert = JSON.parse(out) as { sections?: Array<{ checks: Array<Row & { id: string }> }>; readiness?: Array<Row & { id: string }> }
                resolvePromise({ shell: cert.sections?.flatMap(s => s.checks).find(row => row.id === 'shell') ?? null, ready: cert.readiness?.find(row => row.id === 'tool:shell') ?? null, text: err.slice(-400) })
              } catch {
                resolvePromise({ shell: null, ready: null, text: `${out.slice(0, 200)} ${err.slice(-400)}` })
              }
            })
          })
        }
        const [firedHealth, nothingHealth, thereHealth] = await twoAtATime([
          () => health('fired', { ...located, PATH: window }),
          () => health('nothing', { [SEAM]: 'no-bash', PATH: window }),
          () => health('ls-there', { ...located, PATH: windowLs }),
        ])
        const firedTail = ` — the Bash tool runs under it (${shellEngineArmWords('windows')})${borrowed}`
        const nothingTail = " — no bash.exe was found on this machine, so the Bash tool runs under Mercury's own bash-compatible engine; ls, cat, grep and the like are not on this machine: Git for Windows carries them"
        const thereTail = ` — the Bash tool runs under it (${shellEngineArmWords('windows')}), no Git dependency`
        const carries = (row: Row | null, head: string, tail: string): boolean => {
          const text = row?.evidence ?? ''
          return text.startsWith(head) && text.endsWith(tail) && text.slice(head.length, text.length - tail.length).includes('brush')
        }
        check('the rule fired: the shell check carries the line, and stays ok', carries(firedHealth.shell, 'the shell engine at ', firedTail) && firedHealth.shell?.status === 'ok', JSON.stringify(firedHealth.shell) + firedHealth.text)
        check('…the readiness row tool:shell carries the same string, and stays ready', firedHealth.shell !== null && firedHealth.ready?.detail === firedHealth.shell.evidence && firedHealth.ready?.state === 'ready', JSON.stringify(firedHealth.ready))
        check('nothing to borrow: the shell check carries the line, and stays ok', carries(nothingHealth.shell, 'the bundled shell engine at ', nothingTail) && nothingHealth.shell?.status === 'ok', JSON.stringify(nothingHealth.shell) + nothingHealth.text)
        check('…the readiness row tool:shell carries the same string, and stays ready', nothingHealth.shell !== null && nothingHealth.ready?.detail === nothingHealth.shell.evidence && nothingHealth.ready?.state === 'ready', JSON.stringify(nothingHealth.ready))
        check('an ls already there: the line as it stood, the same status and state', carries(thereHealth.shell, 'the shell engine at ', thereTail) && thereHealth.shell?.status === 'ok' && thereHealth.ready?.detail === thereHealth.shell?.evidence && thereHealth.ready?.state === 'ready', JSON.stringify(thereHealth.shell) + thereHealth.text)
      }
    }

    section('§9 the built bundle, a scripted model: the Bash tool answers ls from Git\'s folder')
    {
      const DIST = join(ROOT, 'dist', 'mercury.mjs')
      if (!existsSync(DIST)) {
        console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
      } else {
        const { seedScratchHome, startScriptedFixture } = await import('../lib/scriptedTurn.ts')
        const { childEnv, MODEL } = await import('../daemon/dupline-world.ts')
        const { nodeBinPath } = await import('../lib/nodeBin.ts')
        const NODE = nodeBinPath()
        const ASK = 'list this folder and say what the path is'
        const drive = async (label: string, path: string): Promise<{ code: number | null; tools: string[]; ls: string; seen: string; tail: string }> => {
          const home = join(scratch, `${label}-run-home`)
          const cwd = join(scratch, `${label}-run-work`)
          seedScratchHome(home, cwd)
          const fixture = await startScriptedFixture(req => {
            if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
            if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'list the folder' } }]
            if (req.step === 1) return [{ type: 'tool_use', name: 'Bash', input: { command: SEEN, description: 'say the path' } }]
            return [{ type: 'text', text: 'done' }]
          })
          const env: NodeJS.ProcessEnv = childEnv(home, Number(new URL(fixture.base).port))
          for (const name of [ENGINE_PIN, 'MERCURY_SHELL_ENGINE_SESSIONS', SEAM, PIN, 'MERCURY_SHELL_PREFIX', 'MERCURY_ENV_FILE', 'SHELL']) delete env[name]
          Object.assign(env, located, { PATH: path, HOME: join(scratch, 'user'), MERCURY_TMPDIR: realpathSync(mkdtempSync(join(scratch, `${label}-run-tmp-`))) })
          const run = await new Promise<{ code: number | null; out: string }>(resolvePromise => {
            const child = spawn(NODE, [DIST, 'run', ASK, '--format', 'rows', '--mode', 'sovereign', '--model', MODEL], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
            let out = ''
            child.stdout!.on('data', (chunk: Buffer) => {
              out += chunk.toString('utf8')
            })
            child.stderr!.on('data', (chunk: Buffer) => {
              out += chunk.toString('utf8')
            })
            const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
            child.on('close', code => {
              clearTimeout(timer)
              resolvePromise({ code, out })
            })
          })
          await fixture.close()
          const ours = fixture.requests.filter(r => r.ask.trim() === ASK)
          const resultAt = (step: number): string => ours.find(r => r.step === step)?.results[0]?.text ?? ''
          return { code: run.code, tools: ours[0]?.toolNames ?? [], ls: resultAt(1), seen: resultAt(2), tail: run.out.slice(-600) }
        }
        const [firedRun, thereRun] = await Promise.all([drive('fired', window), drive('ls-there', windowLs)])
        const firstLine = (text: string): string => text.split('\n')[0] ?? ''
        const firedSeen = seen({ out: firstLine(firedRun.seen), code: 0 })
        const thereSeen = seen({ out: firstLine(thereRun.seen), code: 0 })
        check('both runs completed with the Bash tool on the roster', firedRun.code === 0 && thereRun.code === 0 && firedRun.tools.includes('Bash') && thereRun.tools.includes('Bash'), JSON.stringify([firedRun, thereRun]))
        check('the model\'s ls is answered by Git\'s ls (before: Shell command failed (exit code 127), error: command not found: ls)', firstLine(firedRun.ls) === GIT_LS, JSON.stringify(firedRun.ls))
        check('…in the engine session the bundle started, <Git>/usr/bin the first entry of its path and the window\'s own path after it', firedSeen.served === VERSION && firedSeen.shell.includes('brush') && firedSeen.path === ruled, JSON.stringify(firedRun.seen))
        check('with an ls already there the model\'s ls is the window\'s own, and the session\'s path is the window\'s byte for byte', firstLine(thereRun.ls) === WINDOW_LS && thereSeen.served === VERSION && thereSeen.path === windowLs, JSON.stringify([thereRun.ls, thereRun.seen]))
      }
    }
  }

  section('§10 the source: each start of a command under the engine takes its environment through the rule, and the permission layer never reads it')
  {
    const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
    const engine = read('src/utils/shell/engineSession.ts')
    const shell = read('src/utils/Shell.ts')
    const roadSource = read('src/utils/shell/windowsShellRoad.ts')
    check('the engine session (the main conversation\'s and each crewmate\'s) is started with the ruled environment', engine.includes('env: withGitPrograms(toolShellEnv(base.env, { SHELL: binaryPath, ...envOverrides() })),'))
    check('a command the session cannot take (run_in_background, inherit_session_env, Monitor) is started with the ruled environment when the engine runs it, and with the tool environment as it was otherwise', shell.includes('env: engineBinary === null ? childEnv : withGitPrograms(childEnv),'))
    check('the rule is read on the Windows road alone, with the Git the road already located: off the road nothing is located', roadSource.includes('world: ProgramsWorld | null = windowsShellRoadActive() ? { platform: process.platform, gitBash: locatedWindowsBash() } : null,') && roadSource.includes("if (world === null) return { from: 'path' }"))
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap(name => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : []
      })
    const readers = ['src/utils/permissions', 'src/utils/wards', 'src/tools/BashTool'].flatMap(rel => walk(join(ROOT, rel)))
    const naming = readers.filter(path => /withGitPrograms|toolPrograms/.test(readFileSync(path, 'utf8')))
    check(`no file of the permission layer, the wards or the Bash tool names the rule (${readers.length} files read)`, readers.length > 50 && naming.length === 0, naming.join(', '))
  }
} finally {
  removeScratch(scratch)
}

console.log(failures === 0 ? `\n✅ ENGINE GIT PROGRAMS PROOF PASS (${checks} checks)` : `\n❌ ENGINE GIT PROGRAMS PROOF RED (${failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
