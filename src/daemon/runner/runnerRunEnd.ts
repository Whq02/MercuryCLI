import type { RunnerPorts } from './runnerPorts.js'
import { peekProject } from '../../sessions/transcripts/writer.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { isOutcome } from '../../engine/rows/read.js'
import { type Unstamped, noticeRow, outcomeRow } from '../../engine/rows/project.js'
import { type OutcomeRow, OUTCOME_SENTENCES, exitCodeOf } from '../../engine/rows/vocabulary.js'
import { isBrokenPipeError } from './structuredIO.js'
import { getSessionId, getTotalAPIDuration } from '../../boot/process-state/processState.js'
import { randomUUID } from 'node:crypto'
import { EMPTY_USAGE } from '../../engine/request-parts/emptyUsage.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import { caretEscape } from './caretEscape.js'
import { logHeadlessProfilerTurn } from '../../platform/logs/headlessProfiler.js'
import { noteRunPhase, runPhaseReport } from '../../platform/logs/runPhases.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { jsonStringify } from '../../platform/logs/slowOperations.js'
import { gracefulShutdownSync } from '../../platform/processes/gracefulShutdown.js'

const recordFlushFailure = (): Promise<string | null> => Promise.resolve(peekProject()?.flush()).then(() => null, (error: unknown) => errorMessage(error))

export async function pumpOutbound(ports: RunnerPorts): Promise<string | null> {
  const { io, routeOutbound } = ports
  let unwrittenRecord: string | null = null
  for await (const outboundMessage of io.outbound) {
    if (isOutcome(outboundMessage)) {
      unwrittenRecord = await recordFlushFailure()
      if (unwrittenRecord !== null) {
        const ended = outboundMessage as Unstamped<OutcomeRow>
        const unwritten = { level: 'error' as const, text: unwrittenRecord }
        const told: Unstamped<OutcomeRow> = { ...ended, notices: [...(ended.notices ?? []), unwritten] }
        routeOutbound(noticeRow({ session_id: ended.session_id, turn: ended.turn }, unwritten.level, unwritten.text))
        routeOutbound(told)
        continue
      }
    }
    routeOutbound(outboundMessage)
  }
  return unwrittenRecord
}

export async function finishPrintRun(unwritten: string | null, ports: RunnerPorts): Promise<void> {
  let unwrittenRecord = unwritten
  const { io, live, options } = ports
  const flushWrite = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
    new Promise((resolve, reject) => {
      stream.write(text, error => {
        if (error) {
          if (isBrokenPipeError(error)) {
            if (stream === process.stdout) io.markStdoutPipeBroken()
            else process.exitCode = 1
            return resolve()
          }
          return reject(error)
        }
        resolve()
      })
    })
  await live.lastOutcomeWritten
  const last: OutcomeRow =
    live.lastOutcome ??
    (io.rows.stamp(
      outcomeRow(
        { session_id: getSessionId(), turn: Math.max(1, live.turnsRun) },
        {
          turnId: live.currentTurnId ?? randomUUID(),
          status: 'failed',
          steps: 0,
          wallMs: 0,
          usage: EMPTY_USAGE,
          models: {},
          denials: [],
          error: { message: 'The run produced no outcome', class: 'internal' },
        },
      ),
    ) as OutcomeRow)
  if (options.outputFormat === 'json') {
    await flushWrite(process.stdout, `${ndjsonSafeStringify(last)}\n`)
  } else if (options.outputFormat !== 'rows') {
    if (last.status === 'completed') {
      const text = caretEscape(last.answer ?? '')
      await flushWrite(process.stdout, text.endsWith('\n') ? text : `${text}\n`)
    } else {
      if ((last.status === 'blocked' || last.status === 'turn_limit') && last.answer) await flushWrite(process.stdout, caretEscape(last.answer).replace(/\n?$/, '\n'))
      const sentence =
        last.status === 'refused' || last.status === 'failed'
          ? (last.error?.message ?? (last.status === 'refused' ? 'The request was refused' : 'The turn failed'))
          : OUTCOME_SENTENCES[last.status]({ maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, maxTimeMs: options.maxTimeMs, message: last.error?.message })
      await flushWrite(process.stderr, `${sentence}\n`)
    }
  }

  if (unwrittenRecord !== null) unwrittenRecord = await recordFlushFailure()
  if (unwrittenRecord !== null) await flushWrite(process.stderr, `Error: ${unwrittenRecord}\n`)

  logHeadlessProfilerTurn()
  noteRunPhase('flush_exit')
  logForDebugging(`[run-phases] ${jsonStringify(runPhaseReport(getTotalAPIDuration()))}`)
  gracefulShutdownSync(io.stdoutPipeBroken ? 1 : (live.signalCode ?? (unwrittenRecord !== null ? 1 : exitCodeOf(last.status))))
}
