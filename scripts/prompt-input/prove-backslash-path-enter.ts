#!/usr/bin/env bun
import { isBackslashContinuation } from '../../src/screen/composer/input-core/backslashContinuation.ts'

let failures = 0
function check(label: string, cond: boolean, detail = 'change isBackslashContinuation in src/screen/composer/input-core/backslashContinuation.ts so a trailing backslash after prose continues and a drive, UNC or separator-bearing path word submits'): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const continues = (draft: string): boolean => isBackslashContinuation(draft, draft.length)

console.log('============================================================')
console.log(' backslash + ↵ — continuation for prose, a submit for paths')
console.log('============================================================')

console.log('\n── the idiom keeps working ──')
check('a trailing backslash after prose continues', continues('first line\\'))
check('a trailing backslash after a space continues (shell style)', continues('first line \\'))
check('a bare backslash continues', continues('\\'))
check('a second line of a draft continues too', continues('one\ntwo\\'))
check('no trailing backslash ⇒ no continuation', !continues('C:\\Users'))
check('an offset before the backslash ⇒ no continuation', !isBackslashContinuation('ab\\', 2))

console.log('\n── Windows paths submit with their separator intact ──')
check('a drive path: C:\\Users\\', !continues('C:\\Users\\'))
check('a drive root alone: C:\\', !continues('C:\\'))
check('a lower-case drive: d:\\work\\', !continues('open d:\\work\\'))
check('a UNC path: \\\\server\\share\\', !continues('\\\\server\\share\\'))
check('a relative Windows path: .\\build\\', !continues('run .\\build\\'))
check('a word with an earlier separator: src\\lib\\', !continues('list src\\lib\\'))
check('the path is judged on its own line of a multi-line draft', !continues('first\nC:\\Users\\'))
check('a path earlier in the line does not change a prose continuation', continues('see C:\\Users then\\'))


console.log(failures === 0 ? '\n✅ backslash + ↵ tells a path from a continuation' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
