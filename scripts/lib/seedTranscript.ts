// ============================================================================
//  scripts/lib/seedTranscript.ts — the ONE way a proof seeds a session file
//  the product will open.
//
//  Mercury's session files hold RECORD lines (src/fabric/entryCodec); the
//  vNext decoder refuses a file whose first parseable line is not a record
//  ("this session file uses a retired format and cannot be opened"). A proof
//  that lays down raw legacy entries therefore seeds a session no --resume
//  boot can open: the cockpit never reaches its composer and every scripted
//  send goes undelivered — a blank grid that reads like a boot fault. Proofs
//  describe their rows in the legacy entry shape (the shape the decoder
//  projects records back to) and encode them HERE, through the real codec,
//  exactly as the writer does.
// ============================================================================
import { entryToRecord } from '../../src/fabric/entryCodec.ts'
import { ordinalOf } from '../../src/fabric/ordinal.ts'

/** Encode legacy-shaped entry rows as the record lines of ONE session file. */
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
