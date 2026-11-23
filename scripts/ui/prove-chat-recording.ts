#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinScratchHome, pinSourceRef, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { SCENARIOS, closeStage, mountPart, openStage, recordScenario, renderRecording } from './chatScenarios.ts'

const SELF = 'scripts/ui/prove-chat-recording.ts'
const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}

const one = arg('--scenario')
if (one !== undefined) {
  pinSourceRef()
  const out = arg('--out')
  const recording = await recordScenario(one)
  const text = renderRecording(recording)
  if (out !== undefined) writeFileSync(out, text)
  else process.stdout.write(text)
  process.exit(0)
}

if (process.argv.includes('--part-mount')) {
  const home = pinScratchHome('chat-part-mount')
  const part = await mountPart(() => null)
  part.unmount()
  await releaseScratchHome(home)
  process.exit(part.sunk.join('').includes('\x1b[?1049l') ? 0 : 3)
}

if (process.argv.includes('--first-paint')) {
  pinSourceRef()
  const stage = await openStage('first-paint')
  const ms = await stage.paintedAfter('Type a prompt')
  await closeStage(stage)
  process.stdout.write(`first-paint-ms ${ms.toFixed(1)}\n`)
  process.exit(0)
}

const ROOT = join(import.meta.dir, '..', '..')
const writeTo = arg('--write')
const against = arg('--against')
const sourceRef = arg('--source-ref')
const only = arg('--only')?.split(',')
const jobs = Math.max(1, Number(arg('--jobs') ?? '4'))
const scratch = mkdtempSync(join(tmpdir(), 'chat-recording-'))
const names = SCENARIOS.map(scenario => scenario.name).filter(name => only === undefined || only.includes(name))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

type Run = { name: string; pass: number; file: string; rc: number; log: string; out: string }

function own(name: string, pass: number, file: string, args: string[]): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(ROOT, SELF), ...args], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    let out = ''
    child.stdout.on('data', chunk => {
      out += String(chunk)
      log += String(chunk)
    })
    child.stderr.on('data', chunk => (log += String(chunk)))
    child.on('close', code => resolve({ name, pass, file, rc: code ?? 1, log, out }))
  })
}

function record(name: string, pass: number): Promise<Run> {
  const file = join(scratch, `${name}.${pass}.txt`)
  return own(name, pass, file, ['--scenario', name, '--out', file, ...(sourceRef === undefined ? [] : ['--source-ref', sourceRef])])
}

const wroteToStdout = (run: Run): number => Buffer.byteLength(run.out.replace(/^Rendering product source from [^\n]*\n/, ''))

async function pool<T>(tasks: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, tasks.length) }, async () => {
      for (;;) {
        const at = next++
        if (at >= tasks.length) return
        out[at] = await tasks[at]!()
      }
    }),
  )
  return out
}

function firstDifference(a: string, b: string): string {
  const left = a.split('\n')
  const right = b.split('\n')
  let step = ''
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i]?.startsWith('=== ')) step = left[i]!
    if (left[i] !== right[i]) return `${step || 'the head'} · line ${i + 1}\n        one: ${JSON.stringify(left[i] ?? '(nothing)')}\n        two: ${JSON.stringify(right[i] ?? '(nothing)')}`
  }
  return 'no line differs'
}

console.log(`${names.length} scenarios, each recorded twice in two processes${sourceRef === undefined ? '' : ` from the product source at ${sourceRef}`}, ${jobs} at once`)
const runs = await pool(
  names.flatMap(name => [1, 2].map(pass => () => record(name, pass))),
  jobs,
)

const settledPoints = new Map<string, number>()
for (const name of names) {
  const [first, second] = runs.filter(run => run.name === name)
  const ran = first!.rc === 0 && second!.rc === 0 && existsSync(first!.file) && existsSync(second!.file)
  check(`${name}: the scenario ran to its end in both processes`, ran, ran ? '' : `rc ${first!.rc} and ${second!.rc}\n${(first!.rc !== 0 ? first!.log : second!.log).split('\n').slice(-40).join('\n')}\nrun it alone with --scenario ${name} --out <file> on ${SELF}; the scenario is recorded by recordScenario in scripts/ui/chatScenarios.ts`)
  if (!ran) continue
  const one = readFileSync(first!.file, 'utf8')
  const two = readFileSync(second!.file, 'utf8')
  settledPoints.set(name, (one.match(/^=== /gm) ?? []).length)
  check(`${name}: the two recordings are the same at every settled point (${settledPoints.get(name)})`, one === two, one === two ? '' : `a recording that differs from itself is not a recording yet: ${firstDifference(one, two)} — the step named above draws something that changes between processes; fix that step in scripts/ui/chatScenarios.ts or the part that draws it under src/screens/chat/`)
  if (writeTo !== undefined && one === two) {
    mkdirSync(writeTo, { recursive: true })
    writeFileSync(join(writeTo, `${name}.txt`), one)
  }
  if (against !== undefined) {
    const kept = join(against, `${name}.txt`)
    const stood = existsSync(kept) ? readFileSync(kept, 'utf8') : null
    check(`${name}: the recording equals the one kept in ${against}`, stood === one, stood === null ? `no recording is kept there: record the base first with --write ${against}` : `the screen draws something else than it drew: ${firstDifference(stood, one)} — find the part of src/screens/chat/ whose move or edit changed the frame and put it back`)
  }
}

const WARM_UPS = 'warm-ups, each a stand-in of the harness: the daemon asked for 1 · a runner warmed 1 · the context windows warmed 1'
const started = runs.filter(run => run.rc === 0 && existsSync(run.file)).map(run => ({ run, line: readFileSync(run.file, 'utf8').split('\n')[1] ?? '' })).filter(entry => entry.line !== WARM_UPS)
check(`a mount starts no daemon and no runner: in each of ${runs.length} recordings the screen asked once for the daemon, once for a warm runner in the project and once for the context windows, and every ask reached a stand-in of the harness`, started.length === 0, `${started.slice(0, 3).map(entry => `${entry.run.name} pass ${entry.run.pass}: ${JSON.stringify(entry.line)}`).join(' · ')} — the first effect of the boot part (src/screen/chat/Chat.tsx, recordBootInteractive) asks for each once after a tick; a count that is not 1 says the effect ran again, lost an arm, or reached the real module past the stand-ins of openStage in scripts/ui/chatScenarios.ts`)
const loud = runs.filter(run => wroteToStdout(run) > 0)
check(`no scenario's process wrote a byte to the terminal it ran in (the stdout of ${runs.length} processes)`, loud.length === 0, `${loud.slice(0, 3).map(run => `${run.name} pass ${run.pass}: ${wroteToStdout(run)} bytes ${JSON.stringify(run.out.slice(0, 80))}`).join(' · ')} — a mount of the stage wrote past its own terminal: mount it through mountSunk in scripts/ui/chatScenarios.ts, which keeps the reset sequences in the harness's sink`)
const partMount = await own('part-mount', 1, '', ['--part-mount'])
check('a part mounted and closed in a process of its own wrote 0 bytes to that process\'s stdout and its reset sequences to the sink', partMount.rc === 0 && wroteToStdout(partMount) === 0, `rc ${partMount.rc} (3: the sink does not hold the alternate screen left) · ${wroteToStdout(partMount)} bytes ${JSON.stringify(partMount.out.slice(0, 80))} — mountPart in scripts/ui/chatScenarios.ts mounts through mountSunk`)

const covered = new Map<string, string[]>()
for (const scenario of SCENARIOS) for (const part of scenario.covers) covered.set(part, [...(covered.get(part) ?? []), scenario.name])
const PARTS = ['submit', 'search', 'selector', 'boot', 'asks', 'dialogs', 'title', 'keys', 'scroll', 'draft', 'status', 'session']
check(`every part of the screen is reached by a scenario (${PARTS.length} parts)`, PARTS.every(part => (covered.get(part) ?? []).length > 0), `${PARTS.filter(part => (covered.get(part) ?? []).length === 0).join(', ')} — add the part to the covers list of a scenario in SCENARIOS, scripts/ui/chatScenarios.ts`)
console.log(`\n  settled points: ${[...settledPoints].map(([name, count]) => `${name} ${count}`).join(' · ')}`)
console.log(`  parts: ${PARTS.map(part => `${part} ${(covered.get(part) ?? []).length}`).join(' · ')}`)
if (writeTo !== undefined) console.log(`  recordings written to ${writeTo}`)
if (failures === 0) rmSync(scratch, { recursive: true, force: true })
else console.log(`  the recordings of this run are kept in ${scratch}`)
console.log(`\n${failures === 0 ? 'prove-chat-recording: ALL PASS' : `prove-chat-recording: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
