import { openPlainCursorWindow, type TerminalResponse } from '../input/interpreter.js'
import type { TerminalQuerier } from './querier.js'

export type WidthProbeClass = 'vs16' | 'skin' | 'zwj' | 'flag' | 'combining' | 'zeroWidth' | 'sextant' | 'ambiguous'
export type TerminalWidthMeasurements = Readonly<Partial<Record<WidthProbeClass, number>>>

export const WIDTH_PROBE_SAMPLES: ReadonlyArray<{ kind: WidthProbeClass; text: string }> = [
  { kind: 'vs16', text: '\u26a0\ufe0f' },
  { kind: 'skin', text: '\u{1f44d}\u{1f3fd}' },
  { kind: 'zwj', text: '\u{1f9d1}\u200d\u{1f4bb}' },
  { kind: 'flag', text: '\u{1f1ec}\u{1f1e7}' },
  { kind: 'combining', text: 'e\u0301' },
  { kind: 'zeroWidth', text: '\u200b' },
  { kind: 'sextant', text: '\u{1fb00}' },
  { kind: 'ambiguous', text: '\u00b7' },
]

const sampledStreams = new WeakSet<object>()
let measurements: TerminalWidthMeasurements = Object.freeze({})

export function readTerminalWidthMeasurements(): TerminalWidthMeasurements {
  return measurements
}

export function queueTerminalWidthProbe(
  querier: TerminalQuerier,
  stdout: NodeJS.WriteStream,
  repaint: () => void,
): (() => void) | null {
  if (sampledStreams.has(stdout)) return null
  if (stdout.isTTY !== true || !Number.isInteger(stdout.rows) || !Number.isInteger(stdout.columns) || stdout.rows < 9 || stdout.columns < 16) return null
  sampledStreams.add(stdout)
  measurements = Object.freeze({})
  const deadline = performance.now() + 250
  const closeWindow = openPlainCursorWindow(WIDTH_PROBE_SAMPLES.map((_, i) => i + 2), deadline)
  const collected: Partial<Record<WidthProbeClass, number>> = {}
  let nextRow = 2
  let active = true
  const close = (): void => {
    if (!active) return
    active = false
    clearTimeout(timer)
    closeWindow()
    repaint()
  }
  const timer = setTimeout(close, 250)
  timer.unref?.()
  for (const [index, sample] of WIDTH_PROBE_SAMPLES.entries()) {
    const row = index + 2
    void querier.send({
      request: `\x1b7\x1b[${row};1H${sample.text}\x1b[6n\x1b[${row};1H\x1b[2K\x1b8`,
      match: (reply): reply is Extract<TerminalResponse, { type: 'cursorPosition' }> =>
        active && performance.now() < deadline && reply.type === 'cursorPosition' && reply.row === row && Number.isSafeInteger(reply.col) && reply.col > 0 && reply.col <= stdout.columns,
    }).then(reply => {
      if (!active || performance.now() >= deadline || reply === undefined) return
      const inOrder = row === nextRow
      nextRow = Math.max(nextRow, row + 1)
      if (!inOrder || (sample.kind !== 'zeroWidth' && reply.col === 1)) return
      collected[sample.kind] = reply.col - 1
      measurements = Object.freeze({ ...collected })
    })
  }
  return close
}
