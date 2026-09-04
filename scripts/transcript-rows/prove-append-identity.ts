#!/usr/bin/env bun
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

{
  const src = readFileSync(join(import.meta.dir, '../../src/screens/REPL.tsx'), 'utf8')
  const connector = readFileSync(join(import.meta.dir, '../../src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check(
    'the face holds no settle append (no setMessages append, no stream handler)',
    !src.includes('setMessages(prev => [...prev, message])') && !src.includes('const handleStreamMessage'),
  )
  check(
    'the connector rebuilds the records from the reader-handed tail through the 1:1 deserialize',
    connector.includes('deserializeLiveMessages(tail),') &&
      connector.includes('this.rawRecords = merge.records'),
  )
}

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
