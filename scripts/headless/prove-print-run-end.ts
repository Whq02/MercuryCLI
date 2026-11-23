#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const at = (rel: string): string => join(ROOT, rel)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (value: unknown): string => JSON.stringify(value)
const UNSETTLED = Symbol('unsettled')
const within = <T,>(work: Promise<T> | T, ms = 3_000): Promise<T | typeof UNSETTLED> => Promise.race([Promise.resolve(work), new Promise<typeof UNSETTLED>(done => setTimeout(() => done(UNSETTLED), ms))])
setTimeout(() => {
  console.log('  [FAIL] the proof ended within its two minutes — a step never settled; look at finishPrintRun and pumpOutbound in src/daemon/runner/runnerRunEnd.ts for an await that never resolves')
  process.exit(1)
}, 120_000).unref()

type Call = { name: string; args: unknown[]; phases?: string[] }
const seen: Call[] = []
const answers = new Map<string, (...args: unknown[]) => unknown>()
const said = (name: string): Call[] => seen.filter(call => call.name === name)

async function spied(rel: string, names: string[]): Promise<void> {
  const real = (await import(at(rel))) as Record<string, unknown>
  const wrapped = Object.fromEntries(
    names.map(name => [
      name,
      (...args: unknown[]): unknown => {
        seen.push({ name, args, phases: stamped() })
        return answers.get(name)?.(...args)
      },
    ]),
  )
  mock.module(at(rel), () => ({ ...real, ...wrapped }))
}

const phases = await import('../../src/platform/logs/runPhases.ts')
const stamped = (): string[] => phases.runPhaseReport(0).phases.map(entry => entry.phase)
await spied('src/platform/processes/gracefulShutdown.ts', ['gracefulShutdownSync'])
await spied('src/sessions/transcripts/writer.ts', ['peekProject'])
await spied('src/platform/logs/debugLog.ts', ['logForDebugging'])
await spied('src/platform/logs/headlessProfiler.ts', ['logHeadlessProfilerTurn'])
await spied('src/boot/process-state/processState.ts', ['getTotalAPIDuration'])

const { finishPrintRun, pumpOutbound } = await import('../../src/daemon/runner/runnerRunEnd.ts')
const { createRunnerState } = await import('../../src/daemon/runner/runnerPorts.ts')
const { exitCodeOf, OUTCOME_SENTENCES } = await import('../../src/engine/rows/vocabulary.ts')
const { ndjsonSafeStringify } = await import('../../src/daemon/runner/ndjsonSafeStringify.ts')
const { getSessionId, setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
const API_MS = 4_321
answers.set('getTotalAPIDuration', () => API_MS)

type Ports = Parameters<typeof finishPrintRun>[1]
type Fault = { stream: 'stdout' | 'stderr'; code: string }
type Ended = { out: string; err: string; exit: unknown; shutdowns: number; broken: boolean; marked: number; threw: string | null; settled: boolean; exitCode: unknown; debug: string[]; shutdownPhases: string[] }

async function end(given: { last?: Record<string, unknown> | null; format?: string; unwritten?: string | null; fault?: Fault; live?: (live: Ports['live']) => void; options?: Record<string, unknown>; broken?: boolean }): Promise<Ended> {
  seen.length = 0
  const live = createRunnerState()
  live.lastOutcome = (given.last === undefined ? null : given.last) as never
  given.live?.(live)
  const io = {
    stdoutPipeBroken: given.broken === true,
    marked: 0,
    markStdoutPipeBroken(): void {
      this.marked++
      this.stdoutPipeBroken = true
    },
    rows: { stamp: (row: Record<string, unknown>) => ({ ...row, seq: 7, timestamp: 'stamped' }) },
  }
  const ports = { live, io, options: { outputFormat: given.format, ...(given.options ?? {}) } } as unknown as Ports
  const written = { out: '', err: '' }
  const real = { out: process.stdout.write, err: process.stderr.write }
  const taking = (stream: 'stdout' | 'stderr') =>
    ((text: string, done?: (error?: Error | null) => void): boolean => {
      if (given.fault?.stream === stream) done?.(Object.assign(new Error(`the ${stream} is gone`), { code: given.fault.code }))
      else {
        written[stream === 'stdout' ? 'out' : 'err'] += text
        done?.()
      }
      return true
    }) as never
  const exitBefore = process.exitCode
  let threw: string | null = null
  process.stdout.write = taking('stdout')
  process.stderr.write = taking('stderr')
  let settled: unknown
  try {
    settled = await within(finishPrintRun(given.unwritten ?? null, ports).catch((error: unknown) => void (threw = error instanceof Error ? error.message : String(error))))
  } finally {
    process.stdout.write = real.out
    process.stderr.write = real.err
  }
  const exitCode = process.exitCode
  process.exitCode = exitBefore
  const shutdown = said('gracefulShutdownSync')
  return { out: written.out, err: written.err, exit: shutdown[0]?.args[0], shutdowns: shutdown.length, broken: io.stdoutPipeBroken, marked: io.marked, threw, settled: settled !== UNSETTLED, exitCode, debug: said('logForDebugging').map(call => String(call.args[0])), shutdownPhases: shutdown[0]?.phases ?? [] }
}

const outcome = (status: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'outcome', status, session_id: 'the-session', turn: 3, turn_id: 'the-turn', ...more })
setIsInteractive(false)

section('§1 the pump: the record is flushed before an outcome row is routed, and a record that did not flush is told on the row')
{
  const run = async (rows: Array<Record<string, unknown>>, flush: () => Promise<void>, order: string[] = []): Promise<{ order: string[]; routed: Array<Record<string, unknown>>; unwritten: unknown }> => {
    seen.length = 0
    const routed: Array<Record<string, unknown>> = []
    answers.set('peekProject', () => ({ flush: () => (order.push('flush'), flush()) }))
    const io = {
      outbound: {
        async *[Symbol.asyncIterator]() {
          for (const row of rows) yield row
        },
      },
    }
    const ports = { io, routeOutbound: (row: Record<string, unknown>) => void (order.push(`route:${String(row.type)}`), routed.push(row)) } as unknown as Ports
    const unwritten = await within(pumpOutbound(ports))
    answers.delete('peekProject')
    return { order, routed, unwritten }
  }
  const text = { type: 'text', text: 'words' }
  const clean = await run([text, outcome('completed'), text, outcome('failed')], async () => {})
  check('the run pump awaits the transcript flush on an outcome row BEFORE routing it (the turn-boundary flush)', j(clean.order) === j(['route:text', 'flush', 'route:outcome', 'route:text', 'flush', 'route:outcome']) && clean.unwritten === null, `pumpOutbound in src/daemon/runner/runnerRunEnd.ts must flush the record before routing each outcome row: ${j(clean.order)} · ${String(clean.unwritten)}`)
  let slow!: () => void
  const held = new Promise<void>(done => (slow = done))
  const live: string[] = []
  const waiting = run([outcome('completed')], () => held, live)
  await new Promise(done => setTimeout(done, 40))
  const before = [...live]
  slow()
  const waited = await waiting
  check('…the outcome row waits for the flush itself, not for its start', j(before) === j(['flush']) && j(waited.order) === j(['flush', 'route:outcome']) && waited.routed.length === 1, `pumpOutbound in src/daemon/runner/runnerRunEnd.ts must await the flush promise before routing the outcome: ${j(before)} · ${j(waited.order)}`)
  const lost = await run([outcome('completed', { notices: [{ level: 'warning', text: 'an earlier notice' }] })], async () => Promise.reject(new Error('the record could not be written: the disk is full')))
  const told = lost.routed[1] as { notices?: Array<{ level: string; text: string }>; status?: string }
  check(
    'a record that did not flush is told: a notice row at error level under the same turn, then the outcome row carrying that notice after its own, and the pump answers the sentence',
    j(lost.order) === j(['flush', 'route:notice', 'route:outcome']) && lost.unwritten === 'the record could not be written: the disk is full' && lost.routed[0]!.level === 'error' && lost.routed[0]!.text === lost.unwritten && lost.routed[0]!.turn === 3 && lost.routed[0]!.session_id === 'the-session' && j(told.notices) === j([{ level: 'warning', text: 'an earlier notice' }, { level: 'error', text: lost.unwritten }]) && told.status === 'completed',
    `pumpOutbound in src/daemon/runner/runnerRunEnd.ts must route an error notice, then the outcome carrying it, and return the failure sentence: ${j(lost.order)} · ${j(lost.routed)}`,
  )
  let calls = 0
  const mended = await run([outcome('completed'), outcome('completed')], async () => (++calls === 1 ? Promise.reject(new Error('once')) : undefined))
  check('the pump answers for the last outcome: a later flush that lands clears the sentence', mended.unwritten === null && j(mended.order) === j(['flush', 'route:notice', 'route:outcome', 'flush', 'route:outcome']), `pumpOutbound in src/daemon/runner/runnerRunEnd.ts must answer for the last outcome only: ${String(mended.unwritten)} · ${j(mended.order)}`)
}

section('§2 the end of a print run: what stdout and stderr carry in each format, and the exit code of the status')
{
  const done = await end({ last: outcome('completed', { answer: 'DONE.' }) })
  const lined = await end({ last: outcome('completed', { answer: 'DONE.\n' }) })
  check('a completed run prints its answer on stdout with one line end, nothing on stderr, and exits by its status', done.out === 'DONE.\n' && lined.out === 'DONE.\n' && done.err === '' && done.exit === exitCodeOf('completed') && done.exit === 0 && done.shutdowns === 1, `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must print the answer on stdout, nothing on stderr, and exit by the status: ${j(done)}`)
  const last = outcome('failed', { error: { message: 'the fixture says no', class: 'model' } })
  const asJson = await end({ last, format: 'json' })
  const asRows = await end({ last, format: 'rows' })
  check('--format json prints the outcome row as one line, --format rows prints nothing more, and both exit by the status', asJson.out === `${ndjsonSafeStringify(last)}\n` && asJson.err === '' && asRows.out === '' && asRows.err === '' && asJson.exit === 1 && asRows.exit === 1, `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must print the outcome row for json, nothing for rows, and exit 1 for failed: ${j(asJson.out)} · ${j(asRows)}`)
  const failed = await end({ last })
  const refusedPlain = await end({ last: outcome('refused') })
  check('a refused or failed run says its sentence on stderr, the error\'s own words when it has them', failed.out === '' && failed.err === 'the fixture says no\n' && failed.exit === 1 && refusedPlain.err === 'The request was refused\n', `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must write the error message, or the status sentence from OUTCOME_SENTENCES in src/engine/rows/vocabulary.ts, to stderr: ${j(failed.err)} · ${j(refusedPlain.err)}`)
  const limited = await end({ last: outcome('turn_limit', { answer: 'as far as it got' }), options: { maxTurns: 4 } })
  const blocked = await end({ last: outcome('blocked', { error: { message: 'an ask nobody answered' } }) })
  check('a run cut at a limit prints what it had on stdout and the limit\'s sentence, with the limit, on stderr', limited.out === 'as far as it got\n' && limited.err === `${OUTCOME_SENTENCES.turn_limit({ maxTurns: 4 })}\n` && limited.exit === exitCodeOf('turn_limit') && blocked.out === '' && blocked.err === 'an ask nobody answered\n', `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must print the answer on stdout and the OUTCOME_SENTENCES (src/engine/rows/vocabulary.ts) sentence on stderr: ${j(limited)} · ${j(blocked.err)}`)
  const none = await end({ last: null, format: 'json', live: live => void ((live.turnsRun = 0), (live.currentTurnId = 'the-open-turn')) })
  const row = JSON.parse(none.out || '{}') as Record<string, unknown> & { error?: { message?: string; class?: string } }
  check('a run that produced no outcome ends as a failed turn of its own: the sentence, the internal class, the open turn\'s id, turn 1 at least, stamped, exit 1', row.status === 'failed' && row.error?.message === 'The run produced no outcome' && row.error.class === 'internal' && row.turn_id === 'the-open-turn' && row.turn === 1 && row.session_id === getSessionId() && row.seq === 7 && none.exit === 1, `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must build a stamped failed outcome when none was produced: ${none.out}`)
  let landed = false
  const racing = await end({ last: null, live: live => void (live.lastOutcomeWritten = new Promise<void>(written => setTimeout(() => ((live.lastOutcome = outcome('completed', { answer: 'late' }) as never), (landed = true), written()), 60))) })
  check('the end waits for the last outcome row to be written before it reads it', landed && racing.out === 'late\n' && racing.exit === 0, `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must await live.lastOutcomeWritten before reading the last outcome: ${j(racing)}`)
}

section('§3 the broken pipe, the signal and the unwritten record decide the exit code over the status')
{
  const piped = await end({ last: outcome('completed', { answer: 'DONE.' }), fault: { stream: 'stdout', code: 'EPIPE' } })
  check('flushWrite folds broken pipes into the latch', piped.settled && piped.threw === null && piped.marked === 1 && piped.broken && piped.out === '', `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must mark a broken stdout pipe and not throw: ${j(piped)}`)
  check('the settle honors the latch over a clean turn', piped.exit === 1 && piped.shutdowns === 1 && (await end({ last: outcome('completed', { answer: 'DONE.' }), broken: true })).exit === 1, `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must exit 1 when the stdout pipe is broken: ${j(piped.exit)}`)
  const errPiped = await end({ last: outcome('failed', { error: { message: 'no' } }), fault: { stream: 'stderr', code: 'EPIPE' } })
  check('a broken stderr is no latch of stdout: the process exit code is set to 1 and the end still settles', errPiped.settled && errPiped.threw === null && errPiped.marked === 0 && errPiped.exitCode === 1 && errPiped.shutdowns === 1, `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must set exit code 1 on a broken stderr without marking stdout: ${j(errPiped)}`)
  const other = await end({ last: outcome('completed', { answer: 'DONE.' }), fault: { stream: 'stdout', code: 'ENOSPC' } })
  check('a write that fails for another reason is not folded: the end throws it and stamps no exit', other.threw === 'the stdout is gone' && other.marked === 0 && other.shutdowns === 0, `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must rethrow a write error that is not a broken pipe: ${j(other)}`)
  const signalled = await end({ last: outcome('completed', { answer: 'DONE.' }), live: live => void (live.signalCode = 130) })
  const both = await end({ last: outcome('completed', { answer: 'DONE.' }), live: live => void (live.signalCode = 130), broken: true })
  check('a signal\'s code is the exit code over a completed turn, and the broken pipe over the signal', signalled.exit === 130 && both.exit === 1, `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must pick the exit code: broken pipe over signal over status: ${String(signalled.exit)} · ${String(both.exit)}`)
  answers.set('peekProject', () => ({ flush: async () => Promise.reject(new Error('the record could not be written: still full')) }))
  const unwritten = await end({ last: outcome('completed', { answer: 'DONE.' }), unwritten: 'the record could not be written: the disk is full' })
  answers.set('peekProject', () => ({ flush: async () => {} }))
  const mended = await end({ last: outcome('completed', { answer: 'DONE.' }), unwritten: 'the record could not be written: the disk is full' })
  answers.delete('peekProject')
  check('a record the pump could not flush is flushed once more at the end: still unwritten it is said on stderr and the run exits 1, written it is not said and the status decides', unwritten.err === 'Error: the record could not be written: still full\n' && unwritten.exit === 1 && unwritten.out === 'DONE.\n' && mended.err === '' && mended.exit === 0, `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must flush the record again at the end and report it on stderr only while it stays unwritten: ${j(unwritten)} · ${j(mended)}`)
}

section('§4 the run-phase report ships at the flush boundary, before the exit')
{
  phases._resetRunPhasesForTesting()
  const ended = await end({ last: outcome('completed', { answer: 'DONE.' }) })
  const report = ended.debug.find(line => line.startsWith('[run-phases] '))
  const shipped = report === undefined ? null : (JSON.parse(report.slice('[run-phases] '.length)) as { phases: Array<{ phase: string }>; providerApiMs: number })
  check('the print run\'s end stamps flush_exit', stamped().includes('flush_exit') && shipped !== null && shipped.phases.some(entry => entry.phase === 'flush_exit'), `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must stamp the flush_exit phase: ${j(stamped())}`)
  check('F02 wiring: the report ships at the print run\'s flush boundary with the api-duration ledger figure', shipped !== null && shipped.providerApiMs === API_MS && ended.debug.filter(line => line.startsWith('[run-phases] ')).length === 1, `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must log one [run-phases] report with the API duration: ${String(report)}`)
  check('F10: exit durability unchanged — the flush stamp precedes gracefulShutdownSync, and the profiler\'s turn is logged before the stamp', ended.shutdownPhases.includes('flush_exit') && said('logHeadlessProfilerTurn').length === 1 && !(said('logHeadlessProfilerTurn')[0]!.phases ?? []).includes('flush_exit') && seen.at(-1)?.name === 'gracefulShutdownSync', `finishPrintRun in src/daemon/runner/runnerRunEnd.ts must stamp flush_exit before gracefulShutdownSync and log the profiler turn before the stamp: ${j(ended.shutdownPhases)} · ${j(seen.map(call => call.name))}`)
}

console.log(failures === 0 ? '\nprove-print-run-end: green' : `\nprove-print-run-end: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
