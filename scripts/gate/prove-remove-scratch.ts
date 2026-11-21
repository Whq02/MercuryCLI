#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOVE_RETRY_CODES, removeScratch } from '../lib/removeScratch.ts'

const world = mkdtempSync(join(tmpdir(), 'remove-scratch-'))
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: fixture`), { code })
const failing = (codes: string[]): { remove: (target: string) => void; attempts: () => number } => {
  let attempts = 0
  return {
    remove: () => {
      attempts++
      const code = codes[attempts - 1]
      if (code !== undefined) throw errno(code)
    },
    attempts: () => attempts,
  }
}
const thrown = (run: () => void): string => {
  try {
    run()
    return ''
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown'
  }
}

try {
  const tree = join(world, 'tree')
  mkdirSync(join(tree, 'nested', 'deeper'), { recursive: true })
  writeFileSync(join(tree, 'nested', 'deeper', 'file.txt'), 'x')
  removeScratch(tree)
  check('a real scratch tree is removed', !existsSync(tree))
  check('a path that is already gone is a quiet success', thrown(() => removeScratch(join(world, 'never-made'))) === '')
  check('the retried class is the handle-lock class: EBUSY, EPERM, ENOTEMPTY and the descriptor limits', ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].every(code => REMOVE_RETRY_CODES.has(code)) && !REMOVE_RETRY_CODES.has('EACCES'))

  const busyTwice = failing(['EBUSY', 'EPERM'])
  const started = Date.now()
  check('two locked attempts are retried and the third removal lands', thrown(() => removeScratch(join(world, 'busy'), { remove: busyTwice.remove, retryDelayMs: 5 })) === '' && busyTwice.attempts() === 3, `attempts=${busyTwice.attempts()}`)
  check('the retries waited with a growing delay (5 ms then 10 ms)', Date.now() - started >= 14, `${Date.now() - started} ms`)

  const stuck = failing(Array.from({ length: 20 }, () => 'EBUSY'))
  check('a lock that never clears throws its last EBUSY after maxRetries more attempts', thrown(() => removeScratch(join(world, 'stuck'), { remove: stuck.remove, maxRetries: 3, retryDelayMs: 1 })) === 'EBUSY' && stuck.attempts() === 4, `attempts=${stuck.attempts()}`)

  const refused = failing(['EACCES'])
  check('a code outside the class is thrown at once', thrown(() => removeScratch(join(world, 'refused'), { remove: refused.remove, retryDelayMs: 1 })) === 'EACCES' && refused.attempts() === 1, `attempts=${refused.attempts()}`)

  const racing = join(world, 'racing')
  mkdirSync(racing)
  const raced = failing(['ENOENT'])
  check('ENOENT while the path still stands is a race, retried once more', thrown(() => removeScratch(racing, { remove: raced.remove, retryDelayMs: 1 })) === '' && raced.attempts() === 2, `attempts=${raced.attempts()}`)
  const vanished = failing(['ENOENT'])
  check('ENOENT once the path is gone is the success it reports', thrown(() => removeScratch(join(world, 'vanished'), { remove: vanished.remove, retryDelayMs: 1 })) === '' && vanished.attempts() === 1, `attempts=${vanished.attempts()}`)
  const occupied = join(world, 'occupied', 'deep')
  mkdirSync(occupied, { recursive: true })
  const before = process.cwd()
  process.chdir(occupied)
  check('a scratch tree the process sits in is left first, then removed', thrown(() => removeScratch(join(world, 'occupied'))) === '' && !existsSync(join(world, 'occupied')) && !process.cwd().startsWith(join(world, 'occupied')), process.cwd())
  process.chdir(before)
} finally {
  removeScratch(world)
}
check('the proof removed its own world', !existsSync(world))
console.log(failures === 0 ? 'REMOVE SCRATCH: ALL PASS' : `REMOVE SCRATCH: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
