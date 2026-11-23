#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const WHERE = 'src/screen/renderer/warn.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const CHILD = `
const warn = await import(${JSON.stringify(join(ROOT, 'src', 'screen', 'renderer', 'warn.ts'))})
const { flushDebugLogs } = await import(${JSON.stringify(join(ROOT, 'src', 'platform', 'logs', 'debugLog.ts'))})
const answers = []
answers.push(warn.ifNotInteger(undefined, 'absent'))
answers.push(warn.ifNotInteger(3, 'whole'))
answers.push(warn.ifNotInteger(0, 'zero'))
answers.push(warn.ifNotInteger(-2, 'negative'))
answers.push(warn.ifNotInteger(2.5, 'width'))
answers.push(warn.ifNotInteger(2.5, 'width'))
answers.push(warn.ifNotInteger(-0.75, 'offset'))
answers.push(warn.ifNotInteger(Number.NaN, 'ratio'))
answers.push(warn.ifNotInteger(Number.POSITIVE_INFINITY, 'limit'))
answers.push(warn.once('first message'))
answers.push(warn.once('first message'))
answers.push(warn.once('second message'))
answers.push(warn.once('first message'))
answers.push(warn.once('First message'))
answers.push(warn.once(''))
answers.push(warn.once(''))
await flushDebugLogs()
console.log('OBSERVED ' + JSON.stringify({ answers: answers.map(answer => answer === undefined ? 'nothing' : String(answer)) }))
`

const scratch = mkdtempSync(join(tmpdir(), 'ink-warn-'))
function child(words: string[]): { answers: string[]; lines: string[]; status: number | null; err: string } {
  const file = join(scratch, 'child.mjs')
  writeFileSync(file, CHILD)
  const run = spawnSync(process.execPath, [file, ...words], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: mkdtempSync(join(scratch, 'home-')) } })
  const seen = run.stdout.split('\n').find(text => text.startsWith('OBSERVED '))
  return {
    answers: seen ? (JSON.parse(seen.slice('OBSERVED '.length)) as { answers: string[] }).answers : [],
    lines: run.stderr.split('\n').filter(text => text.includes('[WARN] ')).map(text => text.slice(text.indexOf('[WARN] ') + '[WARN] '.length)),
    status: run.status,
    err: run.stderr,
  }
}

try {
  console.log('§1 with the debug log on stderr')
  const run = child(['--log-stderr'])
  check('the child ran to its end', run.status === 0 && run.answers.length === 16, `exit ${run.status}: ${run.err.split('\n').slice(-4).join(' | ')}`)
  check('neither function answers anything', run.answers.every(answer => answer === 'nothing'), JSON.stringify(run.answers))
  const expected = [
    'width should be an integer, got 2.5',
    'width should be an integer, got 2.5',
    'offset should be an integer, got -0.75',
    'ratio should be an integer, got NaN',
    'limit should be an integer, got Infinity',
    'first message',
    'second message',
    'First message',
    '',
  ]
  check('ifNotInteger says nothing for a missing value or a whole number', !run.lines.some(line => /^(absent|whole|zero|negative) /.test(line)), JSON.stringify(run.lines))
  check('for any other number it logs one warning line each time: the name, "should be an integer, got", the value', run.lines.slice(0, 5).join('\n') === expected.slice(0, 5).join('\n'), `${JSON.stringify(run.lines.slice(0, 5))}; see ifNotInteger in ${WHERE}`)
  check('once logs a message the first time and never again, and tells messages apart by their exact text', run.lines.slice(5).join('\n') === expected.slice(5).join('\n'), `${JSON.stringify(run.lines.slice(5))}; see once in ${WHERE}`)
  check('the lines stand in the order of the calls, nine in all', run.lines.length === expected.length && run.lines.every((line, n) => line === expected[n]), JSON.stringify(run.lines))

  console.log('§2 with no debug log asked for')
  const quiet = child([])
  check('the same calls print nothing', quiet.status === 0 && quiet.answers.length === 16 && !/should be an integer|first message|second message/.test(quiet.err), JSON.stringify(quiet.err.split('\n').slice(0, 3)))
} finally {
  removeScratch(scratch)
}

if (failures > 0) {
  console.error(`\nprove-ink-warn-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-ink-warn-behaviour: all green')
