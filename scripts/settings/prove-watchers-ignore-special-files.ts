#!/usr/bin/env bun
import { join } from 'node:path'
import type { Stats } from 'node:fs'

const REPO = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ' — ' + (detail ? detail + ' — ' : '') + 'change ignoringSpecialFiles in src/platform/processes/watchRoot.ts so a fifo, socket or device stat is ignored before the rule is asked and every other stat defers to the rule' : ''}`)
  if (!cond) failures++
}

console.log('§1 the predicate: a stat-known named pipe, socket or device is never watched; everything else is the watcher\'s own rule')
const { ignoringSpecialFiles } = await import('../../src/platform/processes/watchRoot.ts')
const statOf = (kind: 'file' | 'dir' | 'fifo' | 'socket' | 'char' | 'block'): Stats =>
  ({
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isFIFO: () => kind === 'fifo',
    isSocket: () => kind === 'socket',
    isCharacterDevice: () => kind === 'char',
    isBlockDevice: () => kind === 'block',
    isSymbolicLink: () => false,
  }) as unknown as Stats
const asked: string[] = []
const byPath = ignoringSpecialFiles((candidatePath: string) => {
  asked.push(candidatePath)
  return candidatePath.endsWith('.git')
})
for (const kind of ['fifo', 'socket', 'char', 'block'] as const) {
  check(`a ${kind} stat is ignored before the rule is asked`, byPath('/h/settings.json', statOf(kind)) === true && !asked.includes('/h/settings.json'))
}
check('a file stat defers to the rule (kept)', byPath('/h/keep.json', statOf('file')) === false && asked.includes('/h/keep.json'))
check('a file stat defers to the rule (ignored by path)', byPath('/h/.git', statOf('file')) === true)
check('a directory stat defers to the rule', byPath('/h/dir', statOf('dir')) === false)
check('no stat defers to the rule', byPath('/h/nostat.git', undefined) === true && byPath('/h/nostat', undefined) === false)
const bare = ignoringSpecialFiles()
check('with no rule of its own, only a special file is ignored', bare('/h/x', statOf('fifo')) === true && bare('/h/x', statOf('file')) === false && bare('/h/x', undefined) === false)


if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
