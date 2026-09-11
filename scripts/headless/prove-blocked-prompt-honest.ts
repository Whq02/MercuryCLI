#!/usr/bin/env bun
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
  const envelope = engine.match(/type: 'result',\s*subtype: 'success',\s*is_error: [^\n]*\n\s*num_turns: [^\n]*\n\s*result: inputResult\.resultText \?\? '',/)?.[0] ?? ''
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
