#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const vocabulary = (await import(join(ROOT, 'src/rows/vocabulary.ts'))) as Record<string, unknown>
const turnSource = readFileSync(join(ROOT, 'src/rows/turn.ts'), 'utf8')
const transitionsSource = readFileSync(join(ROOT, 'src/query/transitions.ts'), 'utf8')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 every terminal reason the query loop can end on has a whole sentence in the vocabulary')
const terminalBlock = transitionsSource.slice(transitionsSource.indexOf('export type Terminal ='), transitionsSource.indexOf('export type', transitionsSource.indexOf('export type Terminal =') + 1))
const reasons = [...terminalBlock.matchAll(/^\s*\|\s*\{\s*reason:\s*'([a-z_]+)'/gm)].map(m => m[1]!)
check('the Terminal union is read from src/query/transitions.ts (at least the four failure reasons)', ['image_error', 'prompt_too_long', 'blocking_limit', 'rapid_refill_breaker'].every(r => reasons.includes(r)), reasons.join(','))
const sentences = (vocabulary.TERMINAL_FAILURE_SENTENCES ?? {}) as Record<string, unknown>
for (const reason of reasons) {
  const sentence = sentences[reason]
  const spaced = reason.replace(/_/g, ' ')
  check(`${reason}: a sentence exists`, typeof sentence === 'string' && sentence.length > 0, JSON.stringify(sentence))
  if (typeof sentence !== 'string') continue
  check(`${reason}: the sentence is words, not the code`, !sentence.includes(reason) && !sentence.toLowerCase().includes(`(${spaced})`) && !/_/.test(sentence) && /^[A-Z]/.test(sentence), sentence)
}
for (const reason of ['image_error', 'prompt_too_long', 'blocking_limit', 'rapid_refill_breaker']) {
  const sentence = sentences[reason]
  check(`${reason}: the sentence says what failed, not only that the turn failed`, typeof sentence === 'string' && sentence.length > 'The turn failed'.length + 12, JSON.stringify(sentence))
}

console.log('§2 the outcome row builder never prints a reason code with its underscores swapped for spaces')
check("turn.ts carries no `reason.replace(/_/g, ' ')`", !/reason\.replace\(\/_\/g/.test(turnSource))
check('turn.ts reads the failure sentence from the vocabulary', turnSource.includes('TERMINAL_FAILURE_SENTENCES[terminal.reason]'))

console.log('§3 the status derivation of the four failure reasons is unchanged')
const statusOfTerminal = vocabulary.statusOfTerminal as (t: { reason: string }, cut: null) => { status: string; errorClass?: string }
const expected: Record<string, string> = { image_error: 'image', prompt_too_long: 'context_overflow', blocking_limit: 'context_limit', rapid_refill_breaker: 'refill_breaker' }
for (const [reason, errorClass] of Object.entries(expected)) {
  const settled = statusOfTerminal({ reason }, null)
  check(`${reason} → failed / ${errorClass}`, settled.status === 'failed' && settled.errorClass === errorClass, JSON.stringify(settled))
}

console.log(failures === 0 ? 'PASS: every terminal failure reaches the outcome row as a sentence' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
