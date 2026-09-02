#!/usr/bin/env bun
// prove-blocked-prompt-honest — a hook-blocked -p run must not report clean
// success (field card FC-019). A UserPromptSubmit hook blocking under the
// documented exit-2 contract produced subtype success, is_error false, exit
// 0, result "" — the block reason reached no stream, so a script behind a
// policy hook could not tell "the model answered" from "the policy stopped
// it". The block now rides the SAME groove as the typed command refusal
// (the house shape at QueryEngine's no-query envelope): hookBlocked marks
// the input result, the envelope carries is_error true with the reason as
// result text, and the print road already answers is_error with the
// sentence on stderr and a nonzero exit.
//
//   §1 the blocked branch marks the result and carries the reason
//      (call-shaped pins on processUserInput).
//   §2 the envelope folds hookBlocked into is_error beside commandRefused.
//   §3 the print road's is_error handling is the stderr+exit-1 road (the
//      existing groove, pinned so it cannot silently regress).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

section('§1 THE BLOCKED BRANCH')
{
  const pui = src('src/utils/processUserInput/processUserInput.ts')
  check('the result type declares hookBlocked', /hookBlocked\?: true/.test(pui))
  const branch = pui.slice(pui.indexOf('if (result.blockingError)'), pui.indexOf('if (result.preventContinuation)'))
  check('the blocking branch MARKS the result (call-shaped)', /hookBlocked: true/.test(branch), branch.slice(0, 100).replace(/\s+/g, ' '))
  check('and carries the reason as resultText', /resultText/.test(branch))
}

section('§2 THE ENVELOPE')
{
  const engine = src('src/QueryEngine.ts')
  const envelope = engine.slice(engine.indexOf('A typed command refusal'), engine.indexOf('A typed command refusal') + 700)
  check(
    'is_error folds hookBlocked beside commandRefused',
    /is_error:\s*inputResult\.commandRefused === true \|\| inputResult\.hookBlocked === true/.test(envelope),
    envelope.match(/is_error[^\n]*/)?.[0],
  )
}

section('§3 THE PRINT ROAD (the existing groove, pinned)')
{
  const print = src('src/cli/print.ts')
  check(
    'an is_error success frame answers on stderr',
    /if \(last\.is_error\) \{\s*\n\s*await flushWrite\(process\.stderr/.test(print),
  )
  check('and the exit code derives from is_error', /const failed = Boolean\(last && last\.type === 'result' && last\.is_error\)/.test(print))
}

if (failures > 0) {
  console.error(`\nprove-blocked-prompt-honest: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-blocked-prompt-honest: all green')
