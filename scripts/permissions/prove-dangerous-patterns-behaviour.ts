#!/usr/bin/env bun
import { CROSS_PLATFORM_CODE_EXEC, DANGEROUS_BASH_PATTERNS, PROGRAM_WRAPPERS } from '../../src/utils/permissions/dangerousPatterns.ts'

const WHERE = 'src/utils/permissions/dangerousPatterns.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const INTERPRETERS = ['python', 'python3', 'python2', 'node', 'deno', 'tsx', 'ruby', 'perl', 'php', 'lua', 'npx', 'bunx', 'npm run', 'yarn run', 'pnpm run', 'bun run', 'bash', 'sh', 'ssh']
const MORE = ['zsh', 'fish', 'eval', 'exec', 'env', 'xargs', 'sudo']
const WRAPPERS = 'nice timeout nohup command builtin time stdbuf setsid ionice caffeinate taskset chrt doas su flock script watch parallel busybox chronic unbuffer nocache arch strace ltrace chroot find'.split(' ')
const listed = (list: readonly string[]): string => list.join(' | ')

console.log('§1 the programs that run code on any platform')
check('nineteen entries, in this order', listed(CROSS_PLATFORM_CODE_EXEC) === listed(INTERPRETERS) && CROSS_PLATFORM_CODE_EXEC.length === 19, `got ${listed(CROSS_PLATFORM_CODE_EXEC)}; see CROSS_PLATFORM_CODE_EXEC in ${WHERE}`)
check('the four package runners are held as two words each', ['npm run', 'yarn run', 'pnpm run', 'bun run'].every(entry => (CROSS_PLATFORM_CODE_EXEC as readonly string[]).includes(entry)) && !(CROSS_PLATFORM_CODE_EXEC as readonly string[]).includes('npm'))

console.log('§2 the dangerous Bash patterns')
check('they begin with every entry of the first list, in its order, then seven more', listed(DANGEROUS_BASH_PATTERNS) === listed([...INTERPRETERS, ...MORE]) && DANGEROUS_BASH_PATTERNS.length === 26, `got ${listed(DANGEROUS_BASH_PATTERNS)}; see DANGEROUS_BASH_PATTERNS in ${WHERE}`)
check('no entry stands twice', new Set(DANGEROUS_BASH_PATTERNS).size === DANGEROUS_BASH_PATTERNS.length)

console.log('§3 the programs that wrap another program')
check('twenty-seven entries, in this order', listed(PROGRAM_WRAPPERS) === listed(WRAPPERS) && PROGRAM_WRAPPERS.length === 27, `got ${listed(PROGRAM_WRAPPERS)}; see PROGRAM_WRAPPERS in ${WHERE}`)
check('no entry stands twice, and none is also a dangerous pattern', new Set(PROGRAM_WRAPPERS).size === PROGRAM_WRAPPERS.length && PROGRAM_WRAPPERS.every(entry => !DANGEROUS_BASH_PATTERNS.includes(entry)), PROGRAM_WRAPPERS.filter(entry => DANGEROUS_BASH_PATTERNS.includes(entry)).join(','))
check('every entry of the three lists is lower case with no space at either end', [...CROSS_PLATFORM_CODE_EXEC, ...DANGEROUS_BASH_PATTERNS, ...PROGRAM_WRAPPERS].every(entry => entry === entry.toLowerCase() && entry === entry.trim() && entry !== ''))

if (failures > 0) {
  console.error(`\nprove-dangerous-patterns-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-dangerous-patterns-behaviour: all green')
