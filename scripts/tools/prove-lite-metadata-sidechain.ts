#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const _ssDir = join(import.meta.dir, '..', '..', 'src', 'utils', 'sessionStorage')
const storage = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'sessionStorage.ts'), 'utf-8') + readdirSync(_ssDir).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(_ssDir, f), 'utf-8')).join('\n')

console.log('============================================================')
console.log(' lite-metadata sidechain — first-line scoped (HB-0108)')
console.log('============================================================')

section('source: isSidechain reads the FIRST parsed message field (firstMessageField)')
check(
  'firstMessageField helper parses each candidate line and tests `field in o`',
  /function firstMessageField\(head: string, field: string\): unknown \{[\s\S]{0,520}JSON\.parse\(line\)[\s\S]{0,160}field in o\) return o\[field\]/.test(
    storage,
  ),
)
check(
  'isSidechain = firstMessageField(head, "isSidechain") === true (NOT a whole-head substring)',
  /const isSidechain = firstMessageField\(head, 'isSidechain'\) === true/.test(storage),
)
check('the old unscoped head.includes("isSidechain") is gone', !/head\.includes\('"isSidechain":true'\)/.test(storage))

section('behavioural mirror: field-boundary-aware parsed scan classifies correctly')
const firstMessageField = (head: string, field: string): unknown => {
  const needle = `"${field}"`
  let start = 0
  for (let scanned = 0; scanned < 80 && start <= head.length; scanned++) {
    const nl = head.indexOf('\n', start)
    const line = nl === -1 ? head.slice(start) : head.slice(start, nl)
    if (line.includes(needle)) {
      try {
        const o = JSON.parse(line) as Record<string, unknown>
        if (o && typeof o === 'object' && field in o) return o[field]
      } catch {
      }
    }
    if (nl === -1) break
    start = nl + 1
  }
  return undefined
}
const classify = (head: string): boolean => firstMessageField(head, 'isSidechain') === true
const realSidechain = '{"parentUuid":null,"isSidechain":true,"uuid":"x"}\n{"type":"text","text":"hi"}'
const foregroundQuoting = '{"parentUuid":null,"isSidechain":false,"uuid":"y"}\n{"type":"text","text":"set \\"isSidechain\\":true to mark a sidechain"}'
const foregroundNoFlag = '{"parentUuid":null,"uuid":"z"}\n{"type":"text","text":"normal turn"}'
const singleLineSidechain = '{"parentUuid":null,"isSidechain":true,"uuid":"w"}'
const preambleThenSidechain =
  '{"type":"queue-operation","op":"x"}\n{"type":"file-history-snapshot"}\n{"parentUuid":null,"isSidechain":true,"uuid":"r"}'
const foregroundWithSubSidechain =
  '{"isSidechain":false,"uuid":"a"}\n{"isSidechain":true,"uuid":"sub"}'
check('a REAL sidechain (first message has the parsed flag) ⇒ true', classify(realSidechain) === true)
check('a foreground QUOTING the literal in escaped content ⇒ false (anti-spoof)', classify(foregroundQuoting) === false)
check('a foreground with no flag ⇒ false', classify(foregroundNoFlag) === false)
check('a complete single-line sidechain head ⇒ true', classify(singleLineSidechain) === true)
check('stamp past the preamble (line ~3) ⇒ true (fixes the false-negative)', classify(preambleThenSidechain) === true)
check('foreground whose first message is false + a later sidechain sub ⇒ false (first field wins)', classify(foregroundWithSubSidechain) === false)
check('a line merely mentioning "isSidechain" inside a string (no top-level key) ⇒ false', classify('{"x":1}\n{"note":"mentions isSidechain:true here"}') === false)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL LITE-METADATA-SIDECHAIN PROOFS PASS')
else console.log(`❌ ${failures} LITE-METADATA-SIDECHAIN PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
