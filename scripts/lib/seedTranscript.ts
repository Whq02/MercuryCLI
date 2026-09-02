import { entryToRecord } from '../../src/fabric/entryCodec.ts'
import { ordinalOf } from '../../src/fabric/ordinal.ts'

export function encodeSeedTranscript(
  rows: ReadonlyArray<Record<string, unknown>>,
  sessionId: string,
  observedAt = '2026-06-19T12:00:00.000Z',
): string {
  let n = 0
  const ctx = {
    sessionId: sessionId as never,
    nextOrdinal: () => ordinalOf(++n) as never,
    observedAt,
    source: { channel: 'sdk' } as const,
  }
  return rows.map(r => JSON.stringify(entryToRecord(r as never, ctx as never))).join('\n') + '\n'
}
