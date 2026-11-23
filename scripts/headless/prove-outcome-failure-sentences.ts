#!/usr/bin/env bun
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const vocabulary = (await import(join(ROOT, 'src/engine/rows/vocabulary.ts'))) as Record<string, unknown>

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 every terminal reason the query loop can end on has a whole sentence in the vocabulary')
const sentences = (vocabulary.TERMINAL_FAILURE_SENTENCES ?? {}) as Record<string, unknown>
for (const reason of ['image_error', 'prompt_too_long', 'blocking_limit', 'rapid_refill_breaker']) {
  const sentence = sentences[reason]
  check(`${reason}: the sentence says what failed, not only that the turn failed`, typeof sentence === 'string' && sentence.length > 'The turn failed'.length + 12, `${JSON.stringify(sentence)} — add or lengthen the whole sentence for ${reason} in TERMINAL_FAILURE_SENTENCES in src/engine/rows/vocabulary.ts`)
}


console.log('§3 the status derivation of the four failure reasons is unchanged')
const statusOfTerminal = vocabulary.statusOfTerminal as (t: { reason: string }, cut: null) => { status: string; errorClass?: string }
const expected: Record<string, string> = { image_error: 'image', prompt_too_long: 'context_overflow', blocking_limit: 'context_limit', rapid_refill_breaker: 'refill_breaker' }
for (const [reason, errorClass] of Object.entries(expected)) {
  const settled = statusOfTerminal({ reason }, null)
  check(`${reason} → failed / ${errorClass}`, settled.status === 'failed' && settled.errorClass === errorClass, `${JSON.stringify(settled)} — ${reason} must settle as failed with error class ${errorClass}; change statusOfTerminal in src/engine/rows/vocabulary.ts`)
}

console.log(failures === 0 ? 'PASS: every terminal failure reaches the outcome row as a sentence' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
