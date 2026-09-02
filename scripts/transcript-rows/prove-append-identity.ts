#!/usr/bin/env bun
// ============================================================================
//  scripts/transcript-rows/prove-append-identity.ts — the ROW-IDENTITY
//  APPEND law (operator live-drive block C: doubled turns, byte-identical,
//  same second).
//
//  Locks:
//   (1) appendRowWithIdentity — one uuid one row: a double-emit REPLACES in
//       place (position kept, newest reference wins); distinct uuids append
//       in order; byte-identical content under DIFFERENT uuids stays two
//       rows (content never keys identity);
//   (2) the REPL's settle append routes through the owner (structural — the
//       bare [...prev, message] spelling must not return);
//   (3) the invariant composes with normalization: a replaced multi-block
//       message still normalizes to the same derived-uuid rows, never a
//       duplicate pair.
//
//  Run: ~/.bun/bin/bun run scripts/transcript-rows/prove-append-identity.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as unknown as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { appendRowWithIdentity } = await import('../../src/utils/messages/appendRow.ts')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('── row-identity append law ──')

// ── (1) the pure law ────────────────────────────────────────────────────────
{
  type Row = { uuid: string; note: string }
  const a1 = { uuid: 'a', note: 'first' }
  const b = { uuid: 'b', note: 'second' }
  const rows = appendRowWithIdentity(appendRowWithIdentity([] as Row[], a1), b)
  check('distinct uuids append in order', rows.length === 2 && rows[0] === a1 && rows[1] === b)

  const a2 = { uuid: 'a', note: 'settled-late' }
  const replaced = appendRowWithIdentity(rows, a2)
  check('a double-emit REPLACES in place (no growth)', replaced.length === 2)
  check('position kept, newest reference wins', replaced[0] === a2 && replaced[1] === b)
  check('the input array is never mutated', rows[0] === a1 && rows.length === 2)

  const twin = { uuid: 'c', note: 'second' }
  const twins = appendRowWithIdentity(replaced, twin)
  check(
    'byte-identical content under a DIFFERENT uuid stays a second row',
    twins.length === 3 && twins[2] === twin,
  )
}

// ── (2) the face appends nothing — the connector rebuilds from the file ────
// The session's runner records its transcript; the focused chat's
// connector rebuilds its records WHOLE from that file on every reload
// (identity is the writer's uuid law), so no append path exists on the
// screen for a double-emit to grow.
{
  const src = readFileSync(join(import.meta.dir, '../../src/screens/REPL.tsx'), 'utf8')
  const connector = readFileSync(join(import.meta.dir, '../../src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check(
    'the face holds no settle append (no setMessages append, no stream handler)',
    !src.includes('setMessages(prev => [...prev, message])') && !src.includes('const handleStreamMessage'),
  )
  // Re-cut to the content-keyed merge seam: the rebuild still starts from
  // the WHOLE file through the 1:1 deserialize; the merge only preserves
  // object identity for byte-identical rows (the row memo bails) — changed
  // bytes always take the fresh object.
  check(
    'the connector rebuilds the records whole from the transcript file',
    connector.includes('deserializeLiveMessages(raw),') &&
      connector.includes('this.rawRecords = merge.records'),
  )
}

// ── (3) composition with normalization ──────────────────────────────────────
{
  const mk = (uuid: string, text: string) => ({
    type: 'assistant' as const,
    uuid,
    timestamp: '2026-08-24T02:00:00.000Z',
    message: {
      id: 'm_1',
      role: 'assistant',
      type: 'message',
      model: 'gpt-5.6-sol',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: null,
      stop_sequence: null,
      usage: {},
      container: null,
      context_management: null,
    },
  })
  const first = mk('u1', 'the settled sentence')
  const double = mk('u1', 'the settled sentence')
  const held = appendRowWithIdentity(appendRowWithIdentity([], first as never), double as never)
  const normalized = normalizeMessages(held as never)
  check(
    'a replayed settle normalizes to ONE row',
    normalized.length === 1 && normalized[0]!.uuid === 'u1',
    `${normalized.length}`,
  )
}

console.log(failures === 0 ? '✅ append-identity GREEN' : `❌ append-identity RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
