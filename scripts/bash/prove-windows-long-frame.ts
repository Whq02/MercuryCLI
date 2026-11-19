#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

console.log('============================================================')
console.log(' A frame the MSYS2 runtime would cut or misread goes through a file')
console.log('============================================================')

const { msysArgvCarries, msysSourceLine, protectBackslashRunsFromMsysArgv } = await import(join(ROOT, 'src/utils/shell/msysArgv.ts'))
const KEPT = 8186

section('(1) which frames argv carries')
check(`${KEPT} bytes ride on argv, one more does not`, msysArgvCarries('x'.repeat(KEPT), {}) && !msysArgvCarries('x'.repeat(KEPT + 1), {}))
check('the bound is counted in bytes, so text that is not ASCII leaves for the file before the runtime, which counts code points, would cut it', msysArgvCarries('é'.repeat(KEPT / 2), {}) && !msysArgvCarries('é'.repeat(KEPT / 2 + 1), {}))
const runs = `printf '%s' '${'C:\\\\dir\\\\'.repeat(700)}'`
check('it is counted on the text as it rides, with every backslash run doubled', runs.length < KEPT && protectBackslashRunsFromMsysArgv(runs).length > KEPT && !msysArgvCarries(runs, {}), `${runs.length} characters, ${protectBackslashRunsFromMsysArgv(runs).length} doubled`)
check('a frame of any length leaves for the file when the environment its bash starts with names glob in MSYS, whatever the case of the name', !msysArgvCarries('echo hi', { MSYS: 'noglob' }) && !msysArgvCarries('echo hi', { msys: 'winsymlinks:nativestrict noglob' }) && !msysArgvCarries('echo hi', { Msys: 'glob' }))
check('another word in MSYS, an empty MSYS and MSYS_NO_PATHCONV change nothing', msysArgvCarries('echo hi', { MSYS: 'winsymlinks:nativestrict' }) && msysArgvCarries('echo hi', { MSYS: '' }) && msysArgvCarries('echo hi', { MSYS_NO_PATHCONV: '1' }))
check('the loader is single-quoted, an apostrophe written as a quoted backslash: it adds no double quote of its own', msysSourceLine('/c/Users/x/AppData/Local/Temp/f') === "source '/c/Users/x/AppData/Local/Temp/f'" && msysSourceLine("/c/O'Brien & Co/f") === "source '/c/O'\\''Brien & Co/f'", msysSourceLine("/c/O'Brien & Co/f"))
const guarded = msysSourceLine("/c/it's/f", { words: "the file is gone (C:\\it's\\f)", exit: 126 })
check('…and with words for a file that is gone it tests the file first, still with no double quote', guarded.startsWith("[ -r '/c/it'\\''s/f' ] || { echo 'the file is gone (C:\\it'\\''s\\f)' >&2; exit 126; }; source '/c/it'\\''s/f'") && !guarded.includes('"'), guarded)

const scratch = mkdtempSync(join(tmpdir(), 'windows-long-frame-'))
try {
  const { windowsPathToPosixPath, posixPathToWindowsPath } = await import(join(ROOT, 'src/utils/windowsPaths.ts'))
  const windows = process.platform === 'win32'
  const inShell = (path: string): string => (windows ? windowsPathToPosixPath(path) : path)

  let bash = '/bin/bash'
  let origin: 'shipped' | 'system' | 'engine' = 'system'
  let version = ''
  if (windows) {
    const record = await (await import(join(ROOT, 'src/utils/shell/shellRecord.ts'))).systemShellRecord()
    bash = record.path
    origin = record.origin
    version = record.version
  }

  section('(2) a bash reads the loader as the frame it names')
  if (!existsSync(bash) || origin === 'engine') {
    console.log(`  [SKIP] no bash serves here (${bash}, ${origin}): the loader is read where one does`)
  } else {
    const odd = join(scratch, "it's here & there")
    mkdirSync(odd)
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`)
    const target = join(odd, 'written.txt')
    const frames: Array<[string, string, (r: { status: number | null; stdout: string }) => boolean]> = [
      ['a frame in a folder whose name holds an apostrophe, a blank and an ampersand is sourced', 'echo "loaded:$((6 * 7))"', r => r.status === 0 && r.stdout.trim() === 'loaded:42'],
      ['its exit status is the frame\'s', 'echo before; (exit 7)', r => r.status === 7 && r.stdout.trim() === 'before'],
      ['a here-document of 300 lines is written whole', `cat > ${JSON.stringify(inShell(target))} <<'EOF'\n${lines.join('\n')}\nEOF\necho "wrote $(wc -l < ${JSON.stringify(inShell(target))} | tr -d ' ') lines"`, r => r.status === 0 && r.stdout.trim() === 'wrote 300 lines' && readFileSync(target, 'utf8').trim().split('\n').length === 300],
    ]
    for (const [label, text, good] of frames) {
      const file = join(odd, 'frame')
      writeFileSync(file, text)
      const ran = spawnSync(bash, ['-c', protectBackslashRunsFromMsysArgv(msysSourceLine(inShell(file)))], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      check(label, good({ status: ran.status, stdout: ran.stdout ?? '' }), `exit ${String(ran.status)} · ${JSON.stringify((ran.stdout ?? '').slice(0, 120))} · ${JSON.stringify((ran.stderr ?? '').slice(0, 200))}`)
      const gone = spawnSync(bash, ['-c', protectBackslashRunsFromMsysArgv(msysSourceLine(inShell(join(odd, 'no-such-frame')), { words: 'the file is gone, so nothing ran', exit: 126 }))], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      if (label.startsWith('a frame in a folder')) check('a loader whose file is gone ends 126 with its words and runs nothing', gone.status === 126 && (gone.stderr ?? '').trim() === 'the file is gone, so nothing ran' && (gone.stdout ?? '') === '', `exit ${String(gone.status)} · ${JSON.stringify((gone.stderr ?? '').slice(0, 200))}`)
      if (windows) {
        const plain = spawnSync(bash, ['-c', protectBackslashRunsFromMsysArgv(msysSourceLine(inShell(file)))], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, MSYS: 'noglob' } })
        check(`…and the same with MSYS=noglob in the bash's environment`, good({ status: plain.status, stdout: plain.stdout ?? '' }), `exit ${String(plain.status)} · ${JSON.stringify((plain.stdout ?? '').slice(0, 120))} · ${JSON.stringify((plain.stderr ?? '').slice(0, 200))}`)
      }
    }
  }

  section('(3) the Windows road hands its frames over: the provider, the hand-over and the bash that serves')
  if (!windows) {
    console.log('  [SKIP] the hand-over is built on Windows alone; macOS and Linux hand every frame to bash -c as before')
  } else if (origin === 'engine') {
    console.log('  [SKIP] the bundled engine serves here: it reads its command line by other rules and cuts nothing')
  } else {
    const { createBashShellProvider } = await import(join(ROOT, 'src/utils/shell/bashProvider.ts'))
    const { subprocessEnv, toolShellEnv } = await import(join(ROOT, 'src/utils/subprocessEnv.ts'))
    const { withRoadPrograms } = await import(join(ROOT, 'src/utils/shell/windowsShellRoad.ts'))
    const provider = await createBashShellProvider({ path: bash, dialect: 'bash', version, origin }, { skipSnapshot: true })
    const work = join(scratch, 'work')
    mkdirSync(work)
    let id = 0
    type Ran = { status: number | null; stdout: string; stderr: string; viaFile: boolean; startedIn: string; record: string[]; pipeline: string }
    const run = async (command: string, more: { env?: Record<string, string>; cwd?: string } = {}): Promise<Ran> => {
      const cwd = more.cwd ?? work
      const env = toolShellEnv({ ...subprocessEnv(), ...more.env }, { SHELL: bash })
      const built = await provider.buildExecCommand(command, { id: `lf${id++}` })
      const handed = built.handOver(env, cwd)
      if (handed.file !== undefined) writeFileSync(handed.file.path, handed.file.text)
      const startedIn = handed.startIn ?? cwd
      const ran = await new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
        const child = spawn(bash, handed.args, { cwd: startedIn, env: withRoadPrograms(env, origin, bash), windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
        const bound = setTimeout(() => child.kill(), 60_000)
        child.once('error', error => { clearTimeout(bound); done({ status: null, stdout, stderr: `${stderr}${String(error)}` }) })
        child.once('close', status => { clearTimeout(bound); done({ status, stdout, stderr }) })
      })
      const read = (path: string | undefined): string => {
        if (path === undefined) return ''
        const file = posixPathToWindowsPath(path)
        const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
        rmSync(file, { force: true })
        return text
      }
      const record = read(built.cwdFilePath).trim().split(/\r?\n/).filter(line => line !== '')
      const pipeline = read(built.pipelineStatusPath).trim().split(/\s+/).join(' ')
      read(built.jobsPath)
      if (handed.file !== undefined) rmSync(handed.file.path, { force: true })
      return { ...ran, viaFile: handed.file !== undefined, startedIn, record, pipeline }
    }
    const shown = (r: Ran): string => `exit ${String(r.status)} · via ${r.viaFile ? 'the file' : 'argv'} · ${JSON.stringify(r.stdout.slice(0, 160))} · ${JSON.stringify(r.stderr.slice(0, 240))}`

    const short = await run(`printf '%s|' 'a\\\\b' "it's" '*' && echo`)
    check('a short command rides on argv and arrives as written, backslash run, apostrophe and star', !short.viaFile && short.status === 0 && short.stdout.trim() === "a\\\\b|it's|*|", shown(short))
    const plain = await run(`printf '%s' '${'word '.repeat(1700)}' | wc -c`)
    check('an 8.5K command goes through the file and runs whole (8500)', plain.viaFile && plain.status === 0 && plain.stdout.trim() === '8500' && plain.pipeline === '0 0', `${shown(plain)} · pipeline ${plain.pipeline}`)
    const notes = join(work, 'notes.md')
    const heredoc = await run(`cat > ${JSON.stringify(inShell(notes))} <<'EOF'\n${Array.from({ length: 260 }, (_, i) => `- item ${String(i).padStart(3, '0')}: the model's note text goes here`).join('\n')}\nEOF\necho "wrote $(wc -l < ${JSON.stringify(inShell(notes))}) lines"`)
    check('a here-document of 260 lines is written whole, and the command after it runs', heredoc.viaFile && heredoc.status === 0 && heredoc.stdout.trim() === 'wrote 260 lines' && existsSync(notes) && readFileSync(notes, 'utf8').trim().split('\n').length === 260, shown(heredoc))
    check('…and the frame recorded its folder, both spellings', heredoc.record.length === 2, JSON.stringify(heredoc.record))
    const backslashes = await run(`printf '%s' '${'C:\\\\dir\\\\'.repeat(900)}' | wc -c`)
    check('an 8.1K command of backslash runs arrives with every run whole (8100)', backslashes.viaFile && backslashes.status === 0 && backslashes.stdout.trim() === '8100', shown(backslashes))
    const accents = await run(`printf '%s' '${'é'.repeat(4000)}' | wc -c`)
    check('a frame under the bound in characters and over it in bytes goes through the file (8000)', accents.viaFile && accents.status === 0 && accents.stdout.trim() === '8000', shown(accents))
    const failing = await run(`: '${'x'.repeat(9000)}'; false`)
    check('a long command that ends in false gives exit 1', failing.viaFile && failing.status === 1, shown(failing))
    const status = await run('false; echo "status $?"')
    check('what stands before the command in the frame leaves its exit status alone: false; echo $? reads 1', status.status === 0 && status.stdout.trim() === 'status 1', shown(status))

    const quoted = await run('echo "hi there"', { env: { MSYS: 'noglob' } })
    check('with MSYS=noglob a command with a double quote goes through the file and runs as written', quoted.viaFile && quoted.status === 0 && quoted.stdout.trim() === 'hi there', shown(quoted))
    const piped = await run('echo hi | cat', { env: { MSYS: 'noglob' } })
    check('…and a pipe ends 0 with its statuses recorded', piped.viaFile && piped.status === 0 && piped.stdout.trim() === 'hi' && piped.pipeline === '0 0', `${shown(piped)} · pipeline ${piped.pipeline}`)
    const unconverted = await run('cmd //c echo via-cmd', { env: { MSYS_NO_PATHCONV: '' } })
    check('an empty MSYS_NO_PATHCONV does not turn path conversion off', unconverted.status === 0 && unconverted.stdout.trim() === 'via-cmd', shown(unconverted))

    const asWritten = await run('cmd /c echo as-written')
    check('cmd /c runs its command (the one-slash switch reaches cmd as written)', asWritten.status === 0 && asWritten.stdout.trim() === 'as-written', shown(asWritten))
    const doubled = await run('cmd //c echo doubled')
    check('cmd //c runs its command as before', doubled.status === 0 && doubled.stdout.trim() === 'doubled', shown(doubled))
    const code = await run('cmd /c exit 3')
    check('cmd /c exit 3 gives exit 3', code.status === 3, shown(code))

    let deep = join(scratch, 'deep')
    while (deep.length < 280) deep = join(deep, 'a-folder-with-a-long-name-0123456789')
    try {
      mkdirSync(deep, { recursive: true })
      const far = await run('pwd -W | wc -c', { cwd: deep })
      check(`a command whose folder is ${deep.length} characters long is started in a folder above it that Windows can start a program in, and runs in its own`, far.startedIn.length <= 258 && existsSync(far.startedIn) && far.status === 0 && Number(far.stdout.trim()) === deep.length + 1, `${shown(far)} · started in ${far.startedIn.length} characters`)
      const back = await run('cd / && pwd', { cwd: deep })
      check('…and a cd out of it is recorded', back.status === 0 && back.record.length === 2 && back.record[0] === '/', `${shown(back)} · ${JSON.stringify(back.record)}`)
    } catch (error) {
      check(`a command whose folder is ${deep.length} characters long is started in a folder above it`, false, `the leg threw: ${String(error)}`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-windows-long-frame: ALL LAWS HOLD' : `\nprove-windows-long-frame: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
