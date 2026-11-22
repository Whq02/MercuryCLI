import { openPlainCursorWindow, type TerminalResponse } from '../input/interpreter.js'
import type { TerminalQuerier } from './querier.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'
import { notBuilt } from '../../pi/holes.js'

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
  altScreen: boolean,
): (() => void) | null {
  return notBuilt('src/ink/session/widthProbe.ts:26')
}
