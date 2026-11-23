#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve, win32 } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

const ROOT = resolve(import.meta.dir, '..', '..')
const road = await import('../../src/platform/shell/windowsShellRoad.ts')
const { shellEngineRequest } = await import('../../src/platform/shell/shellEngineArm.ts')
const { gitBashCandidatePaths } = await import('../../src/platform/files/windowsPaths.ts')
const { BASH_COMPANION_PROGRAMS, OLDEST_BASH_THAT_COUNTS, composeWindowsBashRoad, describeBashCandidate, roadOfRecord, settleWindowsShell } = road
type World = Parameters<typeof settleWindowsShell>[0]
type Candidate = ReturnType<typeof describeBashCandidate>

let failures = 0
let where = 'settleWindowsShell, composeWindowsBashRoad, describeBashCandidate and roadOfRecord in src/platform/shell/windowsShellRoad.ts, and shellEngineRequest in src/platform/shell/shellEngineArm.ts'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}fix ${where}` : ''}`)
}
const section = (title: string): void => {
  where = title.startsWith('(4)')
    ? 'gitBashCandidatePaths in src/platform/files/windowsPaths.ts'
    : title.startsWith('(5)')
      ? 'BASH_COMPANION_PROGRAMS and describeBashCandidate in src/platform/shell/windowsShellRoad.ts, or the programs list in vendor/bash.lock.json'
      : title.startsWith('(2)')
        ? 'settleWindowsShell in src/platform/shell/windowsShellRoad.ts, or windowsShellQuestion and windowsShellAnswer in src/platform/shell/shellRecord.ts'
        : 'settleWindowsShell, composeWindowsBashRoad, describeBashCandidate and roadOfRecord in src/platform/shell/windowsShellRoad.ts, and shellEngineRequest in src/platform/shell/shellEngineArm.ts'
  console.log(`\n${title}`)
}

console.log('============================================================')
console.log(' Which shell serves on Windows: the detector over described machines')
console.log('============================================================')

const GIT = 'C:/Program Files/Git'
const GIT_BASH = `${GIT}/bin/bash.exe`
const PACK_BASH = 'C:/Users/x/.mercury/versions/1.0.12/vendor/bash/win-x64/usr/bin/bash.exe'
const ENGINE = 'C:/Users/x/.mercury/versions/1.0.12/vendor/brush/win-x64/brush.exe'
const gitFiles = (root: string): string[] => [`${root}/bin/bash.exe`, `${root}/usr/bin/bash.exe`, `${root}/usr/bin/msys-2.0.dll`, ...BASH_COMPANION_PROGRAMS.map(name => `${root}/usr/bin/${name}.exe`)]

type Machine = {
  files?: string[]
  bashes?: string[]
  versions?: Record<string, string>
  pinned?: string
  pack?: boolean
  engine?: boolean
  engineOff?: boolean
  unfit?: Record<string, string>
}

const held = (files: ReadonlySet<string>) => (file: string): boolean => files.has(file.replace(/\\/g, '/'))

function worldOf(machine: Machine): { world: World; started: string[] } {
  const files = new Set(machine.files ?? [])
  const started: string[] = []
  const world: World = {
    pinned: machine.pinned ?? null,
    installed: () => (machine.bashes ?? []).map(path => describeBashCandidate(path, held(files))),
    shipped: () => (machine.pack === false ? { absent: 'no bash pack for win-x64' } : { path: PACK_BASH }),
    engine: () => (machine.engine === false ? { absent: 'no shell-engine pack for win-x64' } : { path: ENGINE, version: '0.4.0' }),
    engineAllowed: machine.engineOff !== true,
    start: async path => {
      started.push(path)
      return machine.unfit?.[path] !== undefined ? null : (machine.versions?.[path] ?? null)
    },
    unfit: path => machine.unfit?.[path],
  }
  return { world, started }
}

async function settle(machine: Machine): Promise<{ origin: string; path: string; version: string; passed: string[]; started: string[] }> {
  const { world, started } = worldOf(machine)
  const choice = await settleWindowsShell(world)
  return { origin: choice.origin, path: choice.path, version: choice.version, passed: choice.passed, started }
}

const PACK_VERSION = '5.3.20(3)-release'
const withPack = { [PACK_BASH]: PACK_VERSION }

section('(1) the nine machines')
{
  const described = held(new Set(gitFiles(GIT)))
  const asWindowsJoins = [win32.join(GIT, 'usr', 'bin', 'msys-2.0.dll'), ...BASH_COMPANION_PROGRAMS.map(name => win32.join(GIT, 'usr', 'bin', `${name}.exe`))]
  check(
    '0. a described machine holds its files by the name node:path joins on Windows too, with backslashes: the machines below read the same there',
    asWindowsJoins.every(file => file.includes('\\') && described(file)),
    asWindowsJoins.filter(file => !described(file)).join(' · '),
  )
}
{
  const m = await settle({ files: gitFiles(GIT), bashes: [GIT_BASH], versions: { [GIT_BASH]: '5.3.15(2)-release', ...withPack } })
  check('1. Git for Windows with a bash 5.3: the installed bash serves, and the shipped one is never started', m.origin === 'system' && m.path === GIT_BASH && m.version === '5.3.15(2)-release' && JSON.stringify(m.started) === JSON.stringify([GIT_BASH]) && m.passed.length === 0, JSON.stringify(m))
}
{
  const m = await settle({ files: gitFiles(GIT), bashes: [GIT_BASH], versions: { [GIT_BASH]: '4.4.23(1)-release', ...withPack } })
  check(`2. an installed bash 4: it does not count, the shipped bash serves, and the reason names its version and ${OLDEST_BASH_THAT_COUNTS}`, m.origin === 'shipped' && m.path === PACK_BASH && m.version === PACK_VERSION && m.passed.some(line => line.includes(GIT_BASH) && line.includes('4.4.23') && line.includes(`older than ${OLDEST_BASH_THAT_COUNTS}`)), JSON.stringify(m))
}
{
  const m = await settle({ files: gitFiles(GIT), bashes: [GIT_BASH], versions: withPack })
  check('3. an installed bash that does not start: the shipped bash serves, and the reason says it does not start', m.origin === 'shipped' && m.passed.some(line => line.includes(GIT_BASH) && line.includes('does not start')), JSON.stringify(m))
}
{
  const m = await settle({ versions: withPack })
  check('4. no bash installed: the shipped bash serves', m.origin === 'shipped' && m.path === PACK_BASH && JSON.stringify(m.started) === JSON.stringify([PACK_BASH]), JSON.stringify(m))
}
{
  const m = await settle({ pack: false })
  check('5. no bash installed and no pack: the bundled engine serves, last, and the reason names the missing pack', m.origin === 'engine' && m.path === ENGINE && m.version === '0.4.0' && m.started.length === 0 && m.passed.some(line => line.includes('no bash of its own')), JSON.stringify(m))
}
{
  const pin = shellEngineRequest('brush', undefined, false)
  const setting = shellEngineRequest(undefined, 'brush', false)
  const first = composeWindowsBashRoad({ path: GIT_BASH }, { path: PACK_BASH, programsDir: null }, { path: ENGINE, arm: 'pin' })
  check('6. the engine pin, with a bash 5 installed and the pack present: the engine serves, by the pin (and by the setting when no pin is set)', pin.requested === 'brush' && pin.arm === 'pin' && setting.requested === 'brush' && setting.arm === 'setting' && first.kind === 'engine' && first.path === ENGINE && first.arm === 'pin', JSON.stringify({ pin, setting, first }))
}
{
  const m = await settle({ pack: false, engineOff: true })
  const request = shellEngineRequest('system', 'brush', true)
  check('7. the system pin with no bash and no pack: nothing serves, never the engine, and the reason says the engine is turned off', m.origin === 'none' && m.started.length === 0 && m.passed.some(line => line.includes('turned off')) && request.requested === 'system' && request.arm === 'pin', JSON.stringify({ m, request }))
  const kept = await settle({ engineOff: true, versions: withPack })
  check('…and with the pack present the system pin keeps the shipped bash', kept.origin === 'shipped' && kept.path === PACK_BASH, JSON.stringify(kept))
  const ZSH_PIN = 'D:/tools/zsh/zsh.exe'
  const zshPin = await settle({ pinned: ZSH_PIN, pack: false, engineOff: true })
  check('…and the system pin with MERCURY_GIT_BASH_PATH naming a zsh: asked the one question, it is no bash, so nothing serves and no zsh is ever the shell', zshPin.origin === 'none' && zshPin.path === '' && JSON.stringify(zshPin.started) === JSON.stringify([ZSH_PIN]) && zshPin.passed.some(line => line.includes(ZSH_PIN) && line.includes('did not answer as a bash')), JSON.stringify(zshPin))
  const zshPinPack = await settle({ pinned: ZSH_PIN, engineOff: true, versions: withPack })
  check('…and with the pack present that pin is passed over and the shipped bash serves', zshPinPack.origin === 'shipped' && zshPinPack.path === PACK_BASH && zshPinPack.passed.some(line => line.includes(ZSH_PIN)), JSON.stringify(zshPinPack))
}
{
  const WSL = 'C:/Windows/System32/bash.exe'
  const CYGWIN = 'C:/cygwin64/bin/bash.exe'
  const files = [WSL, CYGWIN, 'C:/cygwin64/bin/cygwin1.dll', ...BASH_COMPANION_PROGRAMS.map(name => `C:/cygwin64/bin/${name}.exe`)]
  const m = await settle({ files, bashes: [WSL, CYGWIN], versions: { [WSL]: '5.2.21(1)-release', [CYGWIN]: '5.2.21(1)-release', ...withPack } })
  check("8. the bash.exe of Windows' own System32 and a Cygwin bash are no candidates: neither is started, the shipped bash serves, and each is named as outside the MSYS2 family", m.origin === 'shipped' && JSON.stringify(m.started) === JSON.stringify([PACK_BASH]) && [WSL, CYGWIN].every(path => m.passed.some(line => line.includes(path) && line.includes('MSYS2 family'))), JSON.stringify(m))
}
{
  const MINGIT = 'C:/Tools/MinGit'
  const minGitFiles = [`${MINGIT}/cmd/git.exe`, `${MINGIT}/usr/bin/sh.exe`, `${MINGIT}/usr/bin/msys-2.0.dll`, ...['grep', 'head', 'cat', 'sed', 'tail', 'ls', 'cut', 'find', 'wc', 'env', 'rm', 'date'].map(name => `${MINGIT}/usr/bin/${name}.exe`)]
  const none = await settle({ files: minGitFiles, bashes: [], versions: withPack })
  check('9. a MinGit, which brings sh.exe and no bash.exe: the shipped bash serves', none.origin === 'shipped' && JSON.stringify(none.started) === JSON.stringify([PACK_BASH]), JSON.stringify(none))
  const named = `${MINGIT}/bin/bash.exe`
  const lacking = await settle({ files: [...minGitFiles, named], bashes: [named], versions: { [named]: '5.3.15(2)-release', ...withPack } })
  check('…and a bash.exe whose folder lacks one of the programs a command names is passed over without being started, the missing program named', lacking.origin === 'shipped' && !lacking.started.includes(named) && lacking.passed.some(line => line.includes(named) && line.includes('has no bash beside it')), JSON.stringify(lacking))
}

section('(2) the order')
{
  const OLD = 'C:/Old/Git/bin/bash.exe'
  const m = await settle({ files: [...gitFiles('C:/Old/Git'), ...gitFiles(GIT)], bashes: [OLD, GIT_BASH], versions: { [OLD]: '4.3.46(2)-release', [GIT_BASH]: '5.2.37(1)-release', ...withPack } })
  check('a second installed bash serves when the first is too old', m.origin === 'system' && m.path === GIT_BASH && JSON.stringify(m.started) === JSON.stringify([OLD, GIT_BASH]), JSON.stringify(m))
  const PIN = 'D:/tools/bash/bash.exe'
  const pinned = await settle({ pinned: PIN, files: gitFiles(GIT), bashes: [GIT_BASH], versions: { [PIN]: '4.4.23(1)-release', [GIT_BASH]: '5.3.15(2)-release', ...withPack } })
  check('the bash MERCURY_GIT_BASH_PATH names serves before any found one, whatever its version: it is the user\'s word', pinned.origin === 'system' && pinned.path === PIN && pinned.version === '4.4.23(1)-release' && JSON.stringify(pinned.started) === JSON.stringify([PIN]), JSON.stringify(pinned))
  const notBash = await settle({ pinned: 'D:/tools/zsh/zsh.exe', files: gitFiles(GIT), bashes: [GIT_BASH], versions: { [GIT_BASH]: '5.3.15(2)-release', ...withPack } })
  check('a pinned program that does not answer as a bash is passed over, named, and the next road serves', notBash.origin === 'system' && notBash.path === GIT_BASH && notBash.passed.some(line => line.includes('zsh.exe') && line.includes('MERCURY_GIT_BASH_PATH')), JSON.stringify(notBash))
  const CYGDRIVE = 'its runtime reads drive C as /cygdrive/c, where Mercury writes /c'
  const cygdrive = await settle({ pinned: PIN, files: gitFiles(GIT), bashes: [GIT_BASH], versions: { [PIN]: '5.3.15(1)-release', [GIT_BASH]: '5.3.15(2)-release', ...withPack }, unfit: { [PIN]: CYGDRIVE } })
  check('a pinned bash whose runtime does not read /c as drive C is passed over with that reason, and the next bash serves', cygdrive.origin === 'system' && cygdrive.path === GIT_BASH && cygdrive.passed.some(line => line === `${PIN}, named by MERCURY_GIT_BASH_PATH: ${CYGDRIVE}`), JSON.stringify(cygdrive))
  const record = await import(join(ROOT, 'src/platform/shell/shellRecord.ts'))
  const question = record.windowsShellQuestion('C:\\Users\\x\\AppData\\Local\\Temp') as { text: string; drive: string | null }
  check('on Windows the version question also asks how the bash reads the drive of TEMP, with no quote and no backslash in it', question.drive === 'C' && question.text === 'printf %s $BASH_VERSION; cd C:/ && printf :%s $PWD; :' && !/["\'\\\\]/.test(question.text), JSON.stringify(question))
  check('a TEMP with no drive letter asks the version alone', record.windowsShellQuestion('\\\\server\\share\\temp').drive === null && record.windowsShellQuestion('\\\\server\\share\\temp').text === 'printf %s $BASH_VERSION')
  const reads = (said: string): { version: string; unfit?: string } => record.windowsShellAnswer(said, 'C')
  check('an answer of the version and /c is fit; /cygdrive/c is unfit and says so; a bash that could not enter the drive is taken by its version alone', reads('5.3.15(1)-release:/c').unfit === undefined && reads('5.3.15(1)-release:/c').version === '5.3.15(1)-release' && reads('5.3.15(1)-release:/C').unfit === undefined && reads('noise\n5.3.15(1)-release:/cygdrive/c').unfit === CYGDRIVE && reads('noise\n5.3.15(1)-release:/cygdrive/c').version === '5.3.15(1)-release' && reads('5.3.15(1)-release').unfit === undefined && reads('5.3.15(1)-release').version === '5.3.15(1)-release', JSON.stringify([reads('5.3.15(1)-release:/c'), reads('5.3.15(1)-release:/cygdrive/c'), reads('5.3.15(1)-release')]))
  const broken = await settle({ versions: {} })
  check('a shipped bash that does not start gives way to the engine, and the reason says so', broken.origin === 'engine' && broken.passed.some(line => line.includes(PACK_BASH) && line.includes('does not start')), JSON.stringify(broken))
  const nothing = await settle({ pack: false, engine: false })
  check('with no bash, no pack and no engine nothing serves', nothing.origin === 'none' && nothing.passed.some(line => line.includes('engine is unavailable')), JSON.stringify(nothing))
}

section('(3) the first road, before any bash is started, and the road once the record has settled')
{
  const shipped = { path: PACK_BASH, programsDir: null }
  const found = composeWindowsBashRoad({ path: GIT_BASH }, shipped, null)
  const packed = composeWindowsBashRoad({ absent: true }, shipped, null)
  const engineLast = composeWindowsBashRoad({ absent: true }, null, { path: ENGINE, arm: 'no-bash' })
  const absent = composeWindowsBashRoad({ absent: true }, null, null)
  check('a found bash comes before the pack, the pack before the engine, and the engine arms itself only when neither stands', found.kind === 'git-bash' && packed.kind === 'shipped' && packed.path === PACK_BASH && engineLast.kind === 'engine' && engineLast.arm === 'no-bash' && absent.kind === 'absent', JSON.stringify([found, packed, engineLast, absent]))
  const unarmed = shellEngineRequest(undefined, undefined, false)
  check('on Windows with a bash present nothing arms the engine: the request is the system shell by default', unarmed.requested === 'system' && unarmed.arm === 'default' && shellEngineRequest(undefined, undefined, true).arm === 'no-bash', JSON.stringify(unarmed))
  const settledShipped = roadOfRecord(found, { path: PACK_BASH, dialect: 'bash', version: PACK_VERSION, origin: 'shipped' })
  const settledEngine = roadOfRecord(found, { path: ENGINE, dialect: 'bash', version: '0.4.0', origin: 'engine' })
  const pinnedEngine = roadOfRecord({ kind: 'engine', path: ENGINE, arm: 'pin' }, { path: GIT_BASH, dialect: 'bash', version: '5.3.15(2)-release', origin: 'system' })
  check('once the record settles the road follows it: an old found bash gives the shipped one, no bash that starts gives the engine as the fallback, and an engine armed by the pin stays', settledShipped.kind === 'shipped' && settledShipped.path === PACK_BASH && settledEngine.kind === 'engine' && settledEngine.arm === 'fallback' && pinnedEngine.kind === 'engine' && pinnedEngine.arm === 'pin', JSON.stringify([settledShipped, settledEngine, pinnedEngine]))
  check('before the record settles the first road stands', JSON.stringify(roadOfRecord(found, null)) === JSON.stringify(found))
  const noneStarts = roadOfRecord(found, null, true)
  const pinnedEngineStays = roadOfRecord({ kind: 'engine', path: ENGINE, arm: 'pin' }, null, true)
  check('once the record has settled on nothing the road is the absence, and the Bash tool leaves the roster; an engine armed by the pin stays the road', noneStarts.kind === 'absent' && pinnedEngineStays.kind === 'engine', JSON.stringify([noneStarts, pinnedEngineStays]))
}

section('(4) where Git for Windows keeps its bash')
{
  const ROOT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
  for (const folder of ['ucrt64', 'clangarm64', 'clang64', 'mingw64']) {
    const out = gitBashCandidatePaths([`C:\\Program Files\\Git\\${folder}\\bin\\git.exe`])
    check(`a git.exe found in ${folder}\\bin leads to the installation's bin\\bash.exe`, out.includes(ROOT_BASH) && out.indexOf(ROOT_BASH) <= 1, out.join(' · '))
  }
  const elsewhere = gitBashCandidatePaths(['D:\\Tools\\Git\\ucrt64\\bin\\git.exe'])
  check('…also for an installation outside Program Files, which the two fixed paths would not reach', elsewhere.includes('D:\\Tools\\Git\\bin\\bash.exe'), elsewhere.join(' · '))
}

section('(5) what stands beside a bash')
{
  const lock = JSON.parse(readFileSync(join(ROOT, 'vendor', 'bash.lock.json'), 'utf8')) as { msys2: { programs: string[] } }
  check(`the programs the detector asks for beside an installed bash are the ones the lock promises beside the shipped one: ${BASH_COMPANION_PROGRAMS.length}`, JSON.stringify([...BASH_COMPANION_PROGRAMS]) === JSON.stringify(lock.msys2.programs), `${BASH_COMPANION_PROGRAMS.join(' ')} · ${lock.msys2.programs.join(' ')}`)
  const whole: Candidate = describeBashCandidate(GIT_BASH, held(new Set(gitFiles(GIT))))
  const usrBin: Candidate = describeBashCandidate(`${GIT}/usr/bin/bash.exe`, held(new Set(gitFiles(GIT))))
  check("the launcher bin\\bash.exe is judged by the installation's usr\\bin, and usr\\bin\\bash.exe by its own folder", whole.runtimeBeside && whole.programsMissing.length === 0 && usrBin.runtimeBeside && usrBin.programsMissing.length === 0, JSON.stringify([whole, usrBin]))
}

console.log(failures === 0 ? '\nprove-windows-bash-detector: ALL LAWS HOLD' : `\nprove-windows-bash-detector: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
