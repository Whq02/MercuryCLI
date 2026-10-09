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
  const branch = pui.slice(pui.indexOf('if (started.answer.block !== undefined)'), pui.indexOf('if (started.answer.stop !== undefined)'))
  check('the blocking branch MARKS the result (call-shaped)', /hookBlocked: true/.test(branch), branch.slice(0, 100).replace(/\s+/g, ' '))
  check('and carries the reason as resultText', /resultText/.test(branch))
}

section('§2 THE OUTCOME')
{
  const engine = src('src/rows/turn.ts')
  check(
    'a blocked prompt settles refused beside a refused command',
    /const refused = inputResult\.commandRefused === true \|\| inputResult\.hookBlocked === true/.test(engine) && /endTurn\(refused \? 'refused' : 'completed'/.test(engine),
  )
  check("and the hook's reason rides the error with class hook", /class: inputResult\.hookBlocked === true \? 'hook' : 'command'/.test(engine))
}

section('§3 THE PRINT ROAD (the existing groove, pinned)')
{
  const print = src('src/cli/run.ts')
  check(
    'a non-completed outcome answers its sentence on stderr',
    /if \(last\.status === 'completed'\) \{[\s\S]{0,600}?await flushWrite\(process\.stderr, `\$\{sentence\}/.test(print),
  )
  check('and the exit code derives from the status alone', /exitCodeOf\(last\.status\)/.test(print))
}

if (failures > 0) {
  console.error(`\nprove-blocked-prompt-honest: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-blocked-prompt-honest: all green')
