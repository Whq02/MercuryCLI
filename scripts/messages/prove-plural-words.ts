#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { plural } = await import('../../src/utils/stringUtils.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 a count of one keeps the word')
{
  check("1 memory", plural(1, 'memory') === 'memory', plural(1, 'memory'))
  check("1 directory", plural(1, 'directory') === 'directory', plural(1, 'directory'))
  check("1 line", plural(1, 'line') === 'line', plural(1, 'line'))
  check("1 match with its own plural", plural(1, 'match', 'matches') === 'match', plural(1, 'match', 'matches'))
}

section('§2 the screen says memories and directories')
{
  check("2 memories", plural(2, 'memory') === 'memories', plural(2, 'memory'))
  check("0 memories", plural(0, 'memory') === 'memories', plural(0, 'memory'))
  check("3 directories", plural(3, 'directory') === 'directories', plural(3, 'directory'))
  check("a capital keeps its case: Memories", plural(2, 'Memory') === 'Memories', plural(2, 'Memory'))
  check("a phrase ending in the word: 2 memory updates", plural(2, 'memory update') === 'memory updates', plural(2, 'memory update'))
}

section('§3 a vowel before the y keeps the s; every other word takes an s')
{
  check("2 keys", plural(2, 'key') === 'keys', plural(2, 'key'))
  check("2 days", plural(2, 'day') === 'days', plural(2, 'day'))
  check("2 lines", plural(2, 'line') === 'lines', plural(2, 'line'))
  check("2 files", plural(2, 'file') === 'files', plural(2, 'file'))
  check("2 tool uses", plural(2, 'tool use') === 'tool uses', plural(2, 'tool use'))
}

section('§4 a given plural always wins')
{
  check("2 matches", plural(2, 'match', 'matches') === 'matches', plural(2, 'match', 'matches'))
  check("2 searches", plural(2, 'search', 'searches') === 'searches', plural(2, 'search', 'searches'))
  check("a given plural beats the rule", plural(2, 'memory', 'recollections') === 'recollections', plural(2, 'memory', 'recollections'))
}

if (failures) {
  console.log(`\n❌ ${failures} plural check(s) failed`)
  process.exit(1)
}
console.log('\n✅ ALL PLURAL PROOFS PASS')
