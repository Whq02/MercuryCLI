#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const MISSING_PROGRAM = 'mercury-proof-no-such-program-7c1e4a'
const SERVICE = 'missing-program'
const SESSION = 'missing-program-proof'
const REPLY = 'spawn produced no pid'

if (process.argv[2] === '--child') {
  const [mode, workDir, home] = process.argv.slice(3) as [string, string, string]
  const { crashReportDir } = await import('../../src/utils/crashReport.ts')
  if (relative(home, crashReportDir()) !== 'crashes') {
    console.log(`REFUSED ${crashReportDir()}`)
    process.exit(3)
  }
  console.log(`CRASHDIR ${crashReportDir()}`)
  const { setupGracefulShutdown } = await import('../../src/utils/gracefulShutdown.ts')
  setupGracefulShutdown()
  process.on('uncaughtException', err => console.log(`UNCAUGHT ${err.message}`))
  const { readRecord, startService, stopService } = await import('../../src/services/projectServices/serviceManager.ts')
  if (mode === 'control') {
    process.nextTick(() => {
      throw new Error('control-uncaught')
    })
  } else {
    const found = mode === 'found'
    const result = await startService({
      sessionId: SESSION,
      spec: {
        name: SERVICE,
        command: found ? process.execPath : MISSING_PROGRAM,
        args: found ? ['-e', 'setTimeout(() => {}, 30000)'] : ['run', 'dev'],
        cwd: workDir,
        readiness: [],
        readinessMode: 'all',
        restart: 'never',
        lifecycle: 'session',
      },
    })
    console.log(`RESULT ${JSON.stringify(result)}`)
    console.log(`RECORD ${JSON.stringify(readRecord(workDir, SERVICE))}`)
  }
  await new Promise(resolve => setTimeout(resolve, 1500))
  if (mode === 'found') {
    const stopped = await stopService(workDir, SERVICE)
    console.log(`STOPPED ${JSON.stringify('error' in stopped ? stopped : stopped.record.state)}`)
  }
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

delete process.env.MERCURY_SERVICES
const scratch = mkdtempSync(join(tmpdir(), 'prove-svc-missing-program-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'parent-home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM'
  }
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

interface Run {
  status: number | null
  stderr: string
  lines: string[]
  home: string
}

function runChild(mode: 'missing' | 'found' | 'control'): Run {
  const home = join(scratch, `home-${mode}`)
  const workDir = join(scratch, `work-${mode}`)
  mkdirSync(home, { recursive: true })
  mkdirSync(workDir, { recursive: true })
  const res = spawnSync(process.execPath, ['run', import.meta.path, '--child', mode, workDir, home], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: { ...process.env, MERCURY_CONFIG_DIR: home },
  })
  return {
    status: res.status,
    stderr: res.stderr ?? '',
    lines: (res.stdout ?? '').split('\n').map(l => l.trimEnd()),
    home,
  }
}

const tagged = (run: Run, tag: string): string | undefined => run.lines.find(l => l.startsWith(`${tag} `))?.slice(tag.length + 1)
const parse = (text: string | undefined): unknown => {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}
const uncaughtOf = (run: Run): string[] => run.lines.filter(l => l.startsWith('UNCAUGHT '))
const reportsOf = (run: Run): string[] => {
  try {
    return readdirSync(join(run.home, 'crashes')).filter(f => f.startsWith('crash-'))
  } catch {
    return []
  }
}
const messageOf = (run: Run, file: string): string => {
  try {
    return String((JSON.parse(readFileSync(join(run.home, 'crashes', file), 'utf8')) as { message?: unknown }).message)
  } catch {
    return ''
  }
}
const describeReports = (run: Run): string => reportsOf(run).map(f => `${f}: ${messageOf(run, f)}`).join(' | ')
const ranToEnd = (run: Run): string => `status=${run.status} stderr=${JSON.stringify(run.stderr.slice(-300))}`

console.log('============================================================')
console.log(' a service start whose program is not found fails where it happens')
console.log('============================================================')

section('§1 a program that is not found: the model gets its error and nothing crashes')
{
  const run = runChild('missing')
  check('the child ran to its end (exit 0)', run.status === 0, ranToEnd(run))
  const dir = tagged(run, 'CRASHDIR')
  check('its crash reporter writes inside the throwaway home (never the real one)', dir !== undefined && relative(run.home, dir) === 'crashes', String(dir))
  check(`the model gets exactly the error it got before: ${REPLY}`, tagged(run, 'RESULT') === JSON.stringify({ error: REPLY }), String(tagged(run, 'RESULT')))
  check('no service record is left behind', tagged(run, 'RECORD') === 'null', String(tagged(run, 'RECORD')))
  check('NO UNCAUGHT EXCEPTION reaches the process (the base left the spawn failure unlistened)', uncaughtOf(run).length === 0, uncaughtOf(run).join(' | '))
  check('NO CRASH REPORT is written (the next boot reads one as a crashed session)', reportsOf(run).length === 0, describeReports(run))
}

section('§2 control: the same child still reports a real uncaught exception')
{
  const run = runChild('control')
  const reports = reportsOf(run)
  check('the child ran to its end (exit 0)', run.status === 0, ranToEnd(run))
  check('one uncaught-exception report lands in the throwaway home', reports.length === 1 && reports[0]!.endsWith('-uncaught-exception.json'), describeReports(run) || '(none)')
  check('…carrying the thrown error (so an empty crashes folder in §1 means something)', reports.length === 1 && messageOf(run, reports[0]!) === 'control-uncaught', describeReports(run) || '(none)')
}

section('§3 a program that is found starts and stops exactly as before')
{
  const run = runChild('found')
  check('the child ran to its end (exit 0)', run.status === 0, ranToEnd(run))
  const result = parse(tagged(run, 'RESULT')) as { error?: string; record?: { pid?: number; state?: string } } | undefined
  const pid = Number(result?.record?.pid)
  check('the start answers a record: a pid and state starting, no error', result !== undefined && result.error === undefined && Number.isInteger(pid) && pid > 0 && result.record?.state === 'starting', String(tagged(run, 'RESULT')).slice(0, 300))
  check('the stop settles it as stopped', parse(tagged(run, 'STOPPED')) === 'stopped', String(tagged(run, 'STOPPED')))
  check('no uncaught exception and no crash report', uncaughtOf(run).length === 0 && reportsOf(run).length === 0, `${uncaughtOf(run).join(' | ')} ${describeReports(run)}`)
  const deadline = Date.now() + 5000
  while (Number.isInteger(pid) && pid > 0 && alive(pid) && Date.now() < deadline) await sleep(50)
  const gone = !(Number.isInteger(pid) && pid > 0 && alive(pid))
  check('the service process is gone', gone, `pid ${pid} is still running`)
  if (!gone) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
    }
  }
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
}
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-service-missing-program${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
