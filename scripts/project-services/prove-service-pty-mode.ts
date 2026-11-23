#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.argv[2] === '--start-detached') {
  const [, , , home, cwd, python] = process.argv as [string, string, string, string, string, string]
  process.env.MERCURY_CONFIG_DIR = home
  const { startService } = await import('../../src/tools/engines/project-services/serviceManager.ts')
  const result = await startService({ sessionId: 'the-other-session', spec: { name: 'foreign-tty', command: python, args: ['-c', 'import sys\nprint("tty", sys.stdin.isatty(), flush=True)\nsys.stdin.readline()'], cwd, readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'project', pty: true } })
  console.log(JSON.stringify(result))
  process.exit(0)
}

if (process.argv[2] === '--start-without-python') {
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'svc-pty-nopy-'))
  delete process.env.MERCURY_EVAL_PYTHON
  delete process.env.VIRTUAL_ENV
  const { startService } = await import('../../src/tools/engines/project-services/serviceManager.ts')
  const cwd = mkdtempSync(join(tmpdir(), 'svc-pty-nopy-work-'))
  const result = await startService({ sessionId: 'nopy', spec: { name: 'needs-tty', command: 'sh', args: ['-c', 'true'], cwd, readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'session', pty: true } })
  console.log(JSON.stringify(result))
  process.exit(0)
}

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'svc-pty-'))
delete process.env.MERCURY_SERVICES
delete process.env.MERCURY_EVAL_PYTHON

const { readLogs, readRecord, sendInput, servicesDir, startService, stopService } = await import('../../src/tools/engines/project-services/serviceManager.ts')
const { ensurePtyHost, PTY_HOST_COLS, PTY_HOST_ROWS, PTY_HOST_SOURCE, ptyHostUnavailable } = await import('../../src/tools/engines/project-services/ptyHost.ts')
const { readableTerminalLines, readableTerminalText } = await import('../../src/tools/engines/project-services/terminalText.ts')
const { primeEvalAvailability } = await import('../../src/tools/engines/eval-kernels/interpreters.ts')
const { ServiceTool } = await import('../../src/tools/service/ServiceTool.ts')
const { getOriginalCwd } = await import('../../src/boot/process-state/processState.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the pty-mode proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()
const workDir = mkdtempSync(join(tmpdir(), 'svc-pty-work-'))
const SESSION = 'svc-pty-session'
function until(label: string, ready: () => boolean, ceilingMs = 15_000, logOfService?: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const paths = [servicesDir(workDir), ...(logOfService !== undefined ? [readRecord(workDir, logOfService)?.logFile ?? ''] : [])].filter(Boolean)
    const watchers = paths.map(path => watch(path, { persistent: false }, () => {
      if (!settled && ready()) settle(true)
    }))
    const look = setInterval(() => {
      if (ready()) settle(true)
    }, 100)
    const ceiling = setTimeout(() => {
      console.log(`  (the ceiling of ${ceilingMs} ms passed waiting for ${label})`)
      settle(ready())
    }, ceilingMs)
    function settle(answer: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(ceiling)
      clearInterval(look)
      for (const watcher of watchers) watcher.close()
      resolve(answer)
    }
    if (ready()) settle(true)
  })
}
const logHas = (name: string, needle: string) => (): boolean => {
  const record = readRecord(workDir, name)
  try {
    return record !== null && readFileSync(record.logFile, 'utf8').includes(needle)
  } catch {
    return false
  }
}
const logShows = (name: string, needle: string, label = needle): Promise<boolean> => until(label, logHas(name, needle), 15_000, name)
const cold = await startService({ sessionId: SESSION, spec: { name: 'cold-start', command: 'true', args: [], cwd: workDir, readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'session', pty: true } })
const python = (await primeEvalAvailability(workDir)).find(row => row.language === 'py')!
const spec = (name: string, args: string[], pty: boolean) => ({ name, command: python.interpreterPath!, args, cwd: workDir, readiness: [], readinessMode: 'all' as const, restart: 'never' as const, lifecycle: 'session' as const, ...(pty ? { pty: true } : {}) })
const logOf = async (name: string): Promise<string> => {
  const record = readRecord(workDir, name)
  return record ? readFileSync(record.logFile, 'utf8') : ''
}
const readable = async (name: string): Promise<string[]> => {
  const logs = await readLogs(workDir, name, { cursor: 0, limitLines: 1000 })
  return 'error' in logs ? [] : readableTerminalLines(logs.lines)
}

section('§1 — the host: one Python stdlib script cached by content hash, both branches compiled, the Windows branch naming the console API it binds')
{
  check('this box has a Python 3 for the journeys', python.available === true, JSON.stringify(python) + ' — this proof needs a Python 3 that primeEvalAvailability (src/tools/engines/eval-kernels/interpreters.ts) finds; install one or set MERCURY_EVAL_PYTHON')
  check('the very first pty start of a process waits for the Python ladder to settle instead of refusing on a pending probe', 'record' in cold, JSON.stringify(cold) + ' — startService in src/tools/engines/project-services/serviceManager.ts must wait for the Python ladder before refusing a pty start')
  const path = ensurePtyHost()
  check('the host script lands under the config home, named by its content hash', path.includes('/eval/ptyhost-') && path.endsWith('.py') && readFileSync(path, 'utf8') === PTY_HOST_SOURCE, path + ' — ensurePtyHost in src/tools/engines/project-services/ptyHost.ts must write PTY_HOST_SOURCE to <config home>/eval/ptyhost-<hash>.py')
  const compiled = spawnSync(python.interpreterPath!, ['-m', 'py_compile', path], { encoding: 'utf8' })
  check('the whole script compiles (the Windows branch included)', compiled.status === 0, compiled.stderr + ' — fix the Python syntax in PTY_HOST_SOURCE in src/tools/engines/project-services/ptyHost.ts')
  check('the Windows branch binds CreatePseudoConsole, ResizePseudoConsole and ClosePseudoConsole through the pseudo-console thread attribute', ['CreatePseudoConsole', 'ResizePseudoConsole', 'ClosePseudoConsole', 'PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016', 'EXTENDED_STARTUPINFO_PRESENT = 0x00080000'].every(word => PTY_HOST_SOURCE.includes(word)), 'PTY_HOST_SOURCE in src/tools/engines/project-services/ptyHost.ts lost one of the named Windows console API words')
  check('Enter is the terminal\'s carriage return on both branches; end of input is the line discipline\'s EOF on POSIX and Ctrl+Z, Enter on Windows', PTY_HOST_SOURCE.includes('ENTER = b"\\r"') && PTY_HOST_SOURCE.includes('termios.VEOF') && PTY_HOST_SOURCE.includes('b"\\x1a\\r"'), 'PTY_HOST_SOURCE in src/tools/engines/project-services/ptyHost.ts must define ENTER as a carriage return, use termios.VEOF on POSIX and send Ctrl+Z, Enter on Windows')
  check('the default screen is 120 by 40', PTY_HOST_COLS === 120 && PTY_HOST_ROWS === 40, `PTY_HOST_COLS and PTY_HOST_ROWS in src/tools/engines/project-services/ptyHost.ts read ${PTY_HOST_COLS} by ${PTY_HOST_ROWS}`)
}

section('§2 — the pipe road is what it was: no terminal, submit adds a newline, write sends the bytes as given, eof closes stdin')
{
  const name = 'pipe-echo'
  const result = await startService({ sessionId: SESSION, spec: spec(name, ['-u', '-c', 'import sys\nprint("tty", sys.stdin.isatty(), flush=True)\nfor line in sys.stdin:\n    print("got", repr(line), flush=True)\nprint("end", flush=True)'], false) })
  check('the plain service starts', 'record' in result && result.record.state === 'starting', JSON.stringify(result) + ' — startService in src/tools/engines/project-services/serviceManager.ts must start a plain (non-pty) service in state starting')
  check('the program announced itself (no terminal)', await logShows(name, 'tty False', 'the tty line'))
  const first = sendInput(workDir, name, 'hello', SESSION)
  check('submit is the default and reports the stdin road', 'ok' in first && first.pty === false, JSON.stringify(first) + ' — sendInput in src/tools/engines/project-services/serviceManager.ts must default to submit and report pty false on the stdin road')
  sendInput(workDir, name, 'ab', SESSION, 'write')
  sendInput(workDir, name, 'c', SESSION, 'submit')
  sendInput(workDir, name, '', SESSION, 'eof')
  await until('the pipe child to end', () => readRecord(workDir, name)?.state === 'stopped')
  const log = await logOf(name)
  check('the child saw no terminal', log.includes('tty False'), log + ' — startService in src/tools/engines/project-services/serviceManager.ts must give a non-pty service plain pipes')
  check('submit delivered the line with a newline; write and a later submit made one line', log.includes("got 'hello\\n'") && log.includes("got 'abc\\n'"), log + ' — sendInput in src/tools/engines/project-services/serviceManager.ts: submit adds a newline, write sends the bytes as given')
  check('eof ended its input and it exited 0 as stopped', log.includes('end') && readRecord(workDir, name)?.state === 'stopped' && readRecord(workDir, name)?.lastExitCode === 0, JSON.stringify(readRecord(workDir, name)) + ' — sendInput mode eof in src/tools/engines/project-services/serviceManager.ts must close stdin so the child exits 0 as stopped')
}

section('§3 — the pseudo-terminal road: the program sees a terminal of the host\'s size, keystrokes type to it, Enter is the terminal\'s, eof ends its input, the exit code comes back')
{
  const name = 'tty-prompt'
  const result = await startService({ sessionId: SESSION, spec: spec(name, ['-c', 'import os, sys\nprint("tty", sys.stdin.isatty(), os.get_terminal_size().columns, os.get_terminal_size().lines, flush=True)\nname = input("name? ")\nprint("hello", name, flush=True)\nrest = sys.stdin.read()\nprint("rest", repr(rest), flush=True)\nsys.exit(5)'], true) })
  check('the pty service starts and its record carries the pseudo-terminal', 'record' in result && result.record.spec.pty === true, JSON.stringify(result) + ' — startService in src/tools/engines/project-services/serviceManager.ts must start a pty spec through the host and keep spec.pty on the record')
  check('the record\'s pid is the host, not the program (the program runs inside the host\'s terminal)', 'record' in result && typeof result.record.pid === 'number', 'startService in src/tools/engines/project-services/serviceManager.ts must record the pty host pid as the record pid')
  check('the program printed its prompt into the terminal', await logShows(name, 'name? ', 'the prompt'))
  const wrote = sendInput(workDir, name, 'Mer', SESSION, 'write')
  check('write reports the terminal road', 'ok' in wrote && wrote.pty === true, JSON.stringify(wrote) + ' — sendInput in src/tools/engines/project-services/serviceManager.ts must report pty true for a pty service')
  sendInput(workDir, name, 'cury', SESSION, 'submit')
  check('the greeting came back through the terminal', await logShows(name, 'hello Mercury', 'the greeting'))
  sendInput(workDir, name, '', SESSION, 'eof')
  await until('the pty child to end', () => (readRecord(workDir, name)?.state ?? '') === 'failed')
  const raw = await logOf(name)
  const lines = await readable(name)
  check('the program saw a terminal of 120 by 40', raw.includes('tty True 120 40'), raw + ' — the host in src/tools/engines/project-services/ptyHost.ts must give the program a terminal of PTY_HOST_COLS by PTY_HOST_ROWS')
  check('the terminal echoed the typed keys and the program read Mercury whole', raw.includes('name? Mercury') && raw.includes('hello Mercury'), raw + ' — sendInput in src/tools/engines/project-services/serviceManager.ts must type write and submit text to the pty host as keystrokes')
  check('eof ended its input (nothing more was read)', raw.includes("rest ''"), raw + ' — sendInput mode eof in src/tools/engines/project-services/serviceManager.ts must send the terminal EOF (host in ptyHost.ts)')
  check('the readable lines are plain on every platform: the greeting whole, no carriage return, no EOF echo', lines.includes('hello Mercury') && lines.includes('tty True 120 40') && !lines.some(line => line.includes('\r') || line.includes('^D')), JSON.stringify(lines) + ' — readLogs in src/tools/engines/project-services/serviceManager.ts must render lines through readableTerminalLines in src/tools/engines/project-services/terminalText.ts')
  check(process.platform === 'darwin' ? 'the raw log is the terminal\'s bytes: carriage returns and the EOF echo (macOS echoes ^D)' : 'the raw log is the terminal\'s bytes: carriage returns (this line discipline does not echo the EOF)', raw.includes('\r\n') && (process.platform !== 'darwin' || raw.includes('^D')), JSON.stringify(raw.slice(-120)) + ' — the raw log must keep the terminal bytes untouched; do not run the readable rendering on the log file')
  const record = readRecord(workDir, name)
  check('the program\'s own exit code comes back through the host: exit 5, state failed', record?.lastExitCode === 5 && record.state === 'failed', JSON.stringify(record) + ' — the host in src/tools/engines/project-services/ptyHost.ts must pass the program exit code back and serviceManager.ts must record it as lastExitCode')
}

section('§4 — a program that refuses to run without a terminal runs under pty and not under the pipe')
{
  const ttyOnly = ['-c', 'import sys\nsys.exit(0 if sys.stdin.isatty() and sys.stdout.isatty() else 3)']
  await startService({ sessionId: SESSION, spec: spec('tty-only-pipe', ttyOnly, false) })
  await startService({ sessionId: SESSION, spec: spec('tty-only-pty', ttyOnly, true) })
  await until('both to end', () => ['stopped', 'failed'].includes(readRecord(workDir, 'tty-only-pipe')?.state ?? '') && ['stopped', 'failed'].includes(readRecord(workDir, 'tty-only-pty')?.state ?? ''))
  check('under the pipe it exits 3 (no terminal)', readRecord(workDir, 'tty-only-pipe')?.lastExitCode === 3, JSON.stringify(readRecord(workDir, 'tty-only-pipe')) + ' — a service without pty must run with no terminal (startService in src/tools/engines/project-services/serviceManager.ts)')
  check('under the pseudo-terminal it exits 0', readRecord(workDir, 'tty-only-pty')?.lastExitCode === 0 && readRecord(workDir, 'tty-only-pty')?.state === 'stopped', JSON.stringify(readRecord(workDir, 'tty-only-pty')) + ' — a pty service must give the program a tty for stdin and stdout (host in src/tools/engines/project-services/ptyHost.ts)')
}

section('§5 — stop ends the program inside the terminal with the host, nothing lingers')
{
  const name = 'tty-sleeper'
  const result = await startService({ sessionId: SESSION, spec: spec(name, ['-c', 'import os, time\nprint("pid", os.getpid(), flush=True)\ntime.sleep(300)'], true) })
  check('the sleeper starts', 'record' in result, JSON.stringify(result) + ' — startService in src/tools/engines/project-services/serviceManager.ts refused the pty spec')
  await logShows(name, 'pid ', 'its pid line')
  const inner = Number(/pid (\d+)/.exec(await logOf(name))?.[1])
  const hostPid = readRecord(workDir, name)?.pid ?? 0
  check('the program is a child of the host, a different pid', Number.isInteger(inner) && inner > 0 && inner !== hostPid, `${inner} vs host ${hostPid} — the record pid must be the pty host and the program its child (startService in src/tools/engines/project-services/serviceManager.ts)`)
  const stopped = await stopService(workDir, name)
  check('the stop reads stopped', 'record' in stopped && stopped.record.state === 'stopped', JSON.stringify(stopped) + ' — stopService in src/tools/engines/project-services/serviceManager.ts must stop a pty service')
  const gone = ((): boolean => {
    try {
      process.kill(inner, 0)
      return false
    } catch {
      return true
    }
  })()
  check('the program inside the terminal is gone with the host (the host ends it before it exits)', gone, 'stopService in src/tools/engines/project-services/serviceManager.ts must end the program inside the terminal together with the host (ptyHost.ts)')
}

section('§6 — the readable rendering of terminal bytes')
{
  check('colour and cursor sequences go, CR LF reads as a line end', readableTerminalText('\x1b[32mok\x1b[0m\r\n\x1b[2K\x1b[1Gnext\r\n') === 'ok\nnext\n', 'readableTerminalText in src/tools/engines/project-services/terminalText.ts must drop colour and cursor sequences and read CR LF as a line end')
  check('a carriage return inside a line overwrites what stood before it (a progress bar shows its last state)', readableTerminalText('10%\r20%\r100% done\r\n') === '100% done\n', 'readableTerminalText in src/tools/engines/project-services/terminalText.ts must let a carriage return overwrite the line so far')
  check('a shorter overwrite keeps the tail it did not cover', readableTerminalText('abcdef\rXY\n') === 'XYcdef\n', 'readableTerminalText in src/tools/engines/project-services/terminalText.ts must keep the tail a shorter overwrite does not cover')
  check('a title sequence goes; a backspace steps the cursor back so what follows overwrites (the EOF echo under the next words)', readableTerminalText('\x1b]0;title\x07prompt> ^D\b\bok') === 'prompt> ok', 'readableTerminalText in src/tools/engines/project-services/terminalText.ts must drop title sequences and let a backspace step the cursor back')
  check('plain text is untouched', readableTerminalText('hello\nworld') === 'hello\nworld', 'readableTerminalText in src/tools/engines/project-services/terminalText.ts must leave plain text untouched')
}

section('§7 — the tool\'s surface')
{
  const schema = ServiceTool.inputSchema
  const shape = (schema as unknown as { shape: Record<string, unknown> }).shape
  check('start takes pty and input takes mode', 'pty' in shape && 'mode' in shape, Object.keys(shape).join(',') + ' — add the pty and mode fields to the input schema of ServiceTool in src/tools/service/ServiceTool.ts')
  const words = await ServiceTool.prompt({} as never)
  const fields = shape as Record<string, { description?: string }>
  check('pty and input meanings live in their fields, not the description', fields.pty?.description?.includes('pseudo-terminal') === true && fields.mode?.description?.includes('submit adds Enter') === true && !/pty:true|submit|eof/.test(words), 'the pty and mode field descriptions and the prompt text of ServiceTool in src/tools/service/ServiceTool.ts: meanings belong in the fields, not in the prompt')
  check('the description names returned state and cursored output; the timeout field owns reply waiting', words.includes('current state and cursored output') && fields.timeoutMs?.description?.includes('default 500') === true && !words.includes('500'), 'the prompt text and the timeoutMs field description of ServiceTool in src/tools/service/ServiceTool.ts')
  const ctx = { abortController: new AbortController(), getAppState: () => ({ sessionId: SESSION }), setAppState: () => {}, options: { tools: [], isNonInteractiveSession: true } } as never
  const toolTty = await ServiceTool.call({ op: 'start', name: 'tool-tty', command: python.interpreterPath!, args: ['-c', 'import sys\nname = input("name? ")\nprint("hello", name, flush=True)\nsys.stdin.readline()'], cwd: workDir, pty: true } as never, ctx)
  check('a pty service starts through the tool', toolTty.data.state === 'starting', toolTty.data.result + ' — ServiceTool.call op start in src/tools/service/ServiceTool.ts must pass pty through to startService')
  const toolProject = getOriginalCwd()
  await until('the tool pty prompt', () => {
    const record = readRecord(toolProject, 'tool-tty')
    try {
      return record !== null && readFileSync(record.logFile, 'utf8').includes('name? ')
    } catch {
      return false
    }
  }, 15_000)
  const typed = await ServiceTool.call({ op: 'input', name: 'tool-tty', text: 'Mercury' } as never, ctx)
  check("through the tool, the input answer carries the terminal's reply as plain lines with the cursor and the state", typed.data.result.startsWith("submitted 7 chars to 'tool-tty' terminal with Enter\n") && typed.data.result.includes('hello Mercury') && !typed.data.result.includes('\r') && /\n\[cursor: \d+ · \d+ bytes total · starting\]$/.test(typed.data.result), JSON.stringify(typed.data.result) + ' — ServiceTool.call op input in src/tools/service/ServiceTool.ts must answer with the terminal reply as plain lines, then the cursor and state')
  await ServiceTool.call({ op: 'stop', name: 'tool-tty' } as never, ctx)
  const valid = await ServiceTool.validateInput({ op: 'input', name: 'x', mode: 'eof' } as never, {} as never)
  const invalid = await ServiceTool.validateInput({ op: 'input', name: 'x' } as never, {} as never)
  check('eof needs no text; submit still does', valid.result === true && invalid.result === false, 'ServiceTool.validateInput in src/tools/service/ServiceTool.ts: mode eof needs no text, submit still needs it')
  const sentence = ptyHostUnavailable('needs-tty', 'no python3 found on PATH')
  check('the no-Python refusal names the road and the remedies', sentence.includes("service 'needs-tty' asks for a pseudo-terminal") && sentence.includes('Python 3') && sentence.includes('MERCURY_EVAL_PYTHON') && sentence.includes('without pty'), 'ptyHostUnavailable in src/tools/engines/project-services/ptyHost.ts must name the pseudo-terminal ask, Python 3, MERCURY_EVAL_PYTHON and running without pty')
  const masked = mkdtempSync(join(tmpdir(), 'svc-pty-no-python-'))
  for (const name of ['python3', 'python', 'py']) {
    writeFileSync(join(masked, name), '#!/bin/sh\nexit 127\n')
    chmodSync(join(masked, name), 0o755)
  }
  const child = spawnSync(process.execPath, [process.argv[1]!, '--start-without-python'], { encoding: 'utf8', env: { ...process.env, PATH: masked } })
  const last = child.stdout.trim().split('\n').at(-1) ?? ''
  check('a start with pty:true and no usable Python on the PATH (every python the PATH holds masked) is refused with that sentence, nothing spawned', child.status === 0 && last.includes('asks for a pseudo-terminal') && last.includes('"error"') && !last.includes('"pid"'), `${child.status}: ${last} ${child.stderr.slice(0, 200)} — startService in src/tools/engines/project-services/serviceManager.ts must refuse a pty start with the ptyHostUnavailable sentence when no Python is usable`)
}

section('refusals — the command is one argv word (no shell), typed text can never be a frame, a control byte is a keystroke, the asks stand in every mode, another session cannot type, a restart keeps the terminal')
{
  const marker = join(workDir, 'never-made.txt')
  const shellish = await startService({ sessionId: SESSION, spec: { name: 'shellish', command: `true; touch ${marker}`, args: [], cwd: workDir, readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'session', pty: true } })
  check('a command with shell words starts as one program name, which does not exist', 'record' in shellish, JSON.stringify(shellish) + ' — startService in src/tools/engines/project-services/serviceManager.ts must treat the command as one program name')
  await until('the shellish program to fail', () => readRecord(workDir, 'shellish')?.state === 'failed')
  check('nothing ran: the host reports it could not start the program (exit 127) and the marker was never written', readRecord(workDir, 'shellish')?.lastExitCode === 127 && (await logOf('shellish')).includes('cannot start') && !existsSync(marker), JSON.stringify(readRecord(workDir, 'shellish')) + ' — the command must never go through a shell (startService in serviceManager.ts, host in ptyHost.ts); the host must report exit 127 and cannot start')
  const name = 'typed'
  await startService({ sessionId: SESSION, spec: spec(name, ['-c', 'import sys\nprint("ready", flush=True)\nfor line in sys.stdin:\n    print("got", repr(line), flush=True)\nprint("end", flush=True)'], true) })
  await logShows(name, 'ready')
  sendInput(workDir, name, '{"t":"eof"}', SESSION, 'submit')
  check('a typed line shaped like a host frame is text to the program (Enter read as the terminal\'s newline), never a frame to the host', await logShows(name, 'got \'{"t":"eof"}\\n\'', 'the typed frame as text'), (await logOf(name)) + ' — sendInput in src/tools/engines/project-services/serviceManager.ts must send typed text as keystrokes, never as a host frame')
  sendInput(workDir, name, 'one\n{"t":"eof"}\ntwo', SESSION, 'write')
  sendInput(workDir, name, '', SESSION, 'submit')
  check('newlines inside a written text are keystrokes: three lines reach the program, its input still open', await logShows(name, "got 'two", 'the third line'), (await logOf(name)) + ' — sendInput write in src/tools/engines/project-services/serviceManager.ts must send newlines inside the text as keystrokes')
  const foreign = spawnSync(process.execPath, [process.argv[1]!, '--start-detached', process.env.MERCURY_CONFIG_DIR!, workDir, python.interpreterPath!], { encoding: 'utf8', env: process.env })
  check('a pty service spawned by another process is on the record', foreign.status === 0 && (readRecord(workDir, 'foreign-tty')?.pid ?? 0) > 0, `${foreign.status} ${foreign.stdout.slice(0, 200)} ${foreign.stderr.slice(0, 200)} — the --start-detached leg of this proof failed to start a pty service through startService in src/tools/engines/project-services/serviceManager.ts`)
  const other = sendInput(workDir, 'foreign-tty', 'x', SESSION, 'submit')
  check('this session cannot type to it: its terminal lives with the process that spawned it', 'error' in other && other.error.includes('spawned by another session'), JSON.stringify(other) + ' — sendInput in src/tools/engines/project-services/serviceManager.ts must refuse input to a pty service another process spawned')
  const foreignStop = await stopService(workDir, 'foreign-tty')
  check('it can still be stopped from here (a project-lifecycle service)', 'record' in foreignStop && foreignStop.record.state === 'stopped', JSON.stringify(foreignStop) + ' — stopService in src/tools/engines/project-services/serviceManager.ts must stop a project-lifecycle service spawned elsewhere')
  sendInput(workDir, name, '\u0003', SESSION, 'write')
  await until('the interrupted program to end', () => ['stopped', 'failed'].includes(readRecord(workDir, name)?.state ?? ''))
  check('a control byte written is the terminal\'s keystroke: Ctrl-C interrupts the program (it ends, its input never reached end)', readRecord(workDir, name)?.state !== 'starting' && !(await logOf(name)).includes('\nend'), JSON.stringify(readRecord(workDir, name)) + ' — sendInput write in src/tools/engines/project-services/serviceManager.ts must pass a control byte to the terminal as a keystroke')
  const start = await ServiceTool.checkPermissions({ op: 'start', name: 'x', command: 'sh', pty: true } as never, {} as never)
  const eof = await ServiceTool.checkPermissions({ op: 'input', name: 'x', mode: 'eof' } as never, {} as never)
  const logs = await ServiceTool.checkPermissions({ op: 'logs', name: 'x' } as never, {} as never)
  check('a pty start asks like any start; an eof input asks and says so; logs never ask', start.behavior === 'ask' && eof.behavior === 'ask' && (eof as { message?: string }).message?.includes('(end of input)') === true && logs.behavior === 'allow', 'ServiceTool.checkPermissions in src/tools/service/ServiceTool.ts: pty start and eof input must ask (eof message names (end of input)), logs must allow')
  const kept = await startService({ sessionId: SESSION, spec: spec('kept-tty', ['-c', 'import sys\nprint("tty", sys.stdin.isatty(), flush=True)\nsys.stdin.readline()'], true) })
  check('a pty service starts for the restart check', 'record' in kept, JSON.stringify(kept) + ' — startService in src/tools/engines/project-services/serviceManager.ts refused the pty spec')
  await logShows('kept-tty', 'tty True')
  const { restartService } = await import('../../src/tools/engines/project-services/serviceManager.ts')
  const restarted = await restartService(workDir, 'kept-tty', SESSION)
  check('a restart keeps the pseudo-terminal: the retained spec carries pty and the program sees a terminal again', 'record' in restarted && restarted.record.spec.pty === true && (await until('the restarted program', () => ((): boolean => { try { return (readFileSync(readRecord(workDir, 'kept-tty')!.logFile, 'utf8').match(/tty True/g) ?? []).length >= 2 } catch { return false } })(), 15_000, 'kept-tty')), JSON.stringify(restarted) + ' — restartService in src/tools/engines/project-services/serviceManager.ts must keep pty on the retained spec')
  check('a clipboard or title sequence in the terminal\'s bytes never reaches the reader', readableTerminalText('\x1b]52;c;aGVsbG8=\x07secret\x1b]0;t\x07') === 'secret', 'readableTerminalText in src/tools/engines/project-services/terminalText.ts must drop clipboard and title sequences')
}

for (const name of ['cold-start', 'pipe-echo', 'tty-prompt', 'tty-only-pipe', 'tty-only-pty', 'tty-sleeper', 'shellish', 'typed', 'kept-tty']) await stopService(workDir, name).catch(() => undefined)
writeFileSync(join(workDir, 'done'), 'ok')
console.log(failures === 0 ? '\nprove-service-pty-mode: ALL GREEN' : `\nprove-service-pty-mode: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
