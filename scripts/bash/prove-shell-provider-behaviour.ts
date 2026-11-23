#!/usr/bin/env bun
import { HookEntrySchema } from '../../src/integrations/event-hook-schemas/hooks.ts'
import { SHELL_TYPES } from '../../src/platform/shell/shellProvider.ts'

const WHERE = 'SHELL_TYPES in src/platform/shell/shellProvider.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('§1 the list itself')
check('the shells are bash and powershell, in that order, and no third', Array.isArray(SHELL_TYPES) && JSON.stringify(SHELL_TYPES) === '["bash","powershell"]', `${JSON.stringify(SHELL_TYPES)}; ${WHERE} is an ordered list and bash stands first`)

console.log('§2 what a hook may name as its shell')
{
  const accepted = SHELL_TYPES.map(shell => HookEntrySchema().safeParse({ run: 'echo ok', shell }))
  check('a run hook may name each shell of the list', accepted.every(answer => answer.success), `${JSON.stringify(accepted.map(answer => answer.success))}; the hook entry schema in src/integrations/event-hook-schemas/hooks.ts takes its shells from ${WHERE}`)
  check('a run hook with no shell named is accepted too', HookEntrySchema().safeParse({ run: 'echo ok' }).success)
  for (const stranger of ['zsh', 'sh', 'cmd', 'pwsh', 'BASH', 'Bash', 'PowerShell', '']) {
    const answer = HookEntrySchema().safeParse({ run: 'echo ok', shell: stranger })
    const said = answer.success ? '' : answer.error.issues.map(issue => [...issue.path, issue.message].join(': ')).join(' | ')
    check(`${JSON.stringify(stranger)} is refused with one fault, at the shell field, naming the two shells in the list's order`, !answer.success && said.startsWith('shell: ') && said.includes('"bash"|"powershell"') && !said.includes(' | '), `${said || 'it was accepted'}; ${WHERE} must hold exactly the two names, in lower case, bash first`)
  }
}

if (failures > 0) {
  console.error(`\nprove-shell-provider-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-shell-provider-behaviour: all green')
