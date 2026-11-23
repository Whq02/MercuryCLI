#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SCENARIOS, type Scenario } from './daemonRunScenarios.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const HARNESS = join(import.meta.dir, 'daemonRunScenarios.ts')
const SELF = 'scripts/daemon/prove-daemon-run-recording.ts'
const args = process.argv.slice(2)
const after = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const dist = resolve(after('--dist') ?? join(ROOT, 'dist'))
const against = after('--against')
const write = after('--write')
const only = after('--only')?.split(',')
const atOnce = Math.max(1, Number(after('--par') ?? 3))
const runs = args.includes('--once') && against !== undefined && write === undefined ? [1] : [1, 2]
const QUICK = ['boot-hello-stop', 'plane-served', 'signals', 'control-off', 'periodic-cold']
const VERBS = ['answer-permission', 'park-all', 'park', 'set-title', 'set-schedule', 'mcp-action', 'mcp-tools', 'set-kit', 'set-model', 'set-effort', 'set-spawn-switch', 'set-permission-mode', 'session-facts', 'focus', 'blur', 'interrupt', 'stop-agent', 'resume-agent', 'withdraw-send', 'background-shell', 'send-now', 'board-post', 'pause-gate', 'leave', 'stop', 'attach', 'detach', 'grant-workflows', 'revoke-workflows', 'pause', 'resume']
const PERIODIC = ['the plane heal', 'the armed-restart beat', 'the sessionless beat', 'the idle-predecessor sweep', 'the handover lock beat', 'the reconcile tick', 'the keep-alive', 'the owner watch', 'the installed-build watch']
const WAYS_OUT = ['control:shutdown', 'control:restart-when-idle', 'restart-when-idle:armed', 'control:processSweep', 'sessionless', 'parkAllThenShutdown', 'home-gone', 'SIGINT', 'SIGTERM', 'SIGHUP', 'crashShutdown', 'the failed boot', 'refused start', 'stood down', 'the restart after teardown']

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

if (process.platform === 'win32') {
  console.log(`${SELF}: the scenarios end daemons with POSIX signals and read a socket file: not run on Windows`)
  process.exit(0)
}
if (!existsSync(join(dist, 'mercury.mjs'))) {
  console.log(`${SELF}: no built product at ${dist} — run \`bun run build.ts\`, or name one with --dist`)
  process.exit(1)
}

const chosen: Scenario[] = SCENARIOS.filter(s => (only !== undefined ? only.includes(s.name) : args.includes('--all') || against !== undefined || write !== undefined ? true : QUICK.includes(s.name)))
const out = mkdtempSync(join(tmpdir(), 'dmr-out-'))
type Take = { name: string; run: number; code: number | null; text: string; seconds: number }

function take(name: string, run: number): Promise<Take> {
  const file = join(out, `${name}.${run}.txt`)
  const started = Date.now()
  return new Promise(done => {
    const child = spawn(process.execPath, [HARNESS, name, '--dist', dist, '--out', file], { cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'inherit'] })
    child.once('exit', code => done({ name, run, code, text: existsSync(file) ? readFileSync(file, 'utf8') : '', seconds: Math.round((Date.now() - started) / 1000) }))
  })
}

async function pooled(jobs: Array<() => Promise<Take>>): Promise<Take[]> {
  const takes: Take[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(atOnce, jobs.length) }, async () => {
      while (next < jobs.length) takes.push(await jobs[next++]!())
    }),
  )
  return takes
}

const firstDifference = (a: string, b: string): string => {
  const left = a.split('\n')
  const right = b.split('\n')
  for (let i = 0; i < Math.max(left.length, right.length); i++) if (left[i] !== right[i]) return `line ${i + 1}: ${JSON.stringify((left[i] ?? '(no line)').slice(0, 220))} against ${JSON.stringify((right[i] ?? '(no line)').slice(0, 220))}`
  return 'no difference'
}

section(`the daemon's run, recorded: ${chosen.length} of ${SCENARIOS.length} scenarios, each ${runs.length === 2 ? 'twice in two processes' : 'once, against the recording kept'}, the build at ${dist}`)
const takes = await pooled(chosen.flatMap(s => runs.map(run => () => take(s.name, run))))
if (write !== undefined) mkdirSync(write, { recursive: true })
for (const scenario of chosen) {
  const [first, second = first] = runs.map(run => takes.find(t => t.name === scenario.name && t.run === run)!)
  const unreached = first!.text.split('\n').filter(line => line.startsWith('! '))
  check(`${scenario.name}: every wait was reached (${runs.length === 2 ? `${first!.seconds}s and ${second!.seconds}s` : `${first!.seconds}s`}; ${first!.text.split('\n').length - 1} lines)`, first!.text !== '' && unreached.length === 0 && first!.code === 0 && second!.code === 0, unreached.join(' | ') || `exit ${first!.code} and ${second!.code}`)
  if (runs.length === 2) check(`${scenario.name}: the two runs give one recording`, first!.text !== '' && first!.text === second!.text, firstDifference(first!.text, second!.text))
  if (against !== undefined) {
    const kept = join(against, `${scenario.name}.txt`)
    const was = existsSync(kept) ? readFileSync(kept, 'utf8') : null
    check(`${scenario.name}: the recording equals the one kept at ${against}`, was !== null && was === first!.text, was === null ? `no recording is kept at ${kept}: write the base's with --write` : `${firstDifference(was, first!.text)} — the daemon behaves otherwise than the kept recording: find the commit that moved it, or, when the change is meant, record again with --write and say what moved`)
  }
  if (write !== undefined && first!.text !== '' && first!.text === second!.text) writeFileSync(join(write, `${scenario.name}.txt`), first!.text)
  else if (write !== undefined) writeFileSync(join(write, `${scenario.name}.differs.txt`), `${first!.text}\n=== the second run ===\n${second!.text}`)
}
if (args.includes('--keep')) console.log(`  both runs of each scenario: ${out}`)
else rmSync(out, { recursive: true, force: true })

section('what the scenarios reach, counted against the verbs, the periodic work and the ways out')
{
  const reached = (of: (s: Scenario) => string[] | undefined): string[] => [...new Set(SCENARIOS.flatMap(s => of(s) ?? []))]
  const verbs = reached(s => s.covers.verbs)
  const periodic = reached(s => s.covers.periodic)
  const waysOut = reached(s => s.covers.waysOut)
  const missing = (all: string[], got: string[]): string[] => all.filter(name => !got.some(g => g === name || g.startsWith(`${name} `)))
  check(`every verb concourseControl answers is sent by a scenario (${VERBS.length - missing(VERBS, verbs).length} of ${VERBS.length})`, missing(VERBS, verbs).length === 0, `not sent: ${missing(VERBS, verbs).join(', ')} — add the verb to a scenario of scripts/daemon/daemonRunScenarios.ts`)
  console.log(`  periodic work reached: ${PERIODIC.length - missing(PERIODIC, periodic).length} of ${PERIODIC.length}${missing(PERIODIC, periodic).length > 0 ? ` (not reached: ${missing(PERIODIC, periodic).join(', ')})` : ''}`)
  console.log(`  ways out reached: ${WAYS_OUT.length - missing(WAYS_OUT, waysOut).length} of ${WAYS_OUT.length}${missing(WAYS_OUT, waysOut).length > 0 ? ` (not reached: ${missing(WAYS_OUT, waysOut).join(', ')})` : ''}`)
  console.log(`  boot roads reached: ${reached(s => s.covers.boot).join(' · ')}`)
}

console.log(`\nprove-daemon-run-recording: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
