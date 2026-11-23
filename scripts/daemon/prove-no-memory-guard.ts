#!/usr/bin/env bun
export {}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
section('§2 no memory-limit flag in the registry')
check('MERCURY_CHILD_RSS_LIMIT_MB is not a row', !FLAG_REGISTRY.some(flag => flag.env === 'MERCURY_CHILD_RSS_LIMIT_MB'))
const memoryRows = FLAG_REGISTRY.filter(flag => /RSS|MEMORY_LIMIT|MEM_LIMIT/.test(flag.env) || /memory limit|memory guard|resident set/i.test(`${flag.summary} ${flag.off}`))
check('no row names a memory limit, a memory guard or a resident set', memoryRows.length === 0, memoryRows.map(flag => flag.env).join(', '))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
