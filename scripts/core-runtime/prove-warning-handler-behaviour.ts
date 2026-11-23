#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const WHERE = 'initializeWarningHandler in src/boot/warningHandler.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const CHILD = `
const { initializeWarningHandler } = await import(${JSON.stringify(join(ROOT, 'src', 'boot', 'warningHandler.ts'))})
const { flushDebugLogs } = await import(${JSON.stringify(join(ROOT, 'src', 'platform', 'logs', 'debugLog.ts'))})
const told = []
const first = warning => told.push('first:' + warning.name)
const second = warning => told.push('second:' + warning.name)
process.on('warning', first)
process.on('warning', second)
const before = process.listeners('warning').length
initializeWarningHandler()
const after = process.listeners('warning').length
const keptForeign = process.listeners('warning').includes(first) && process.listeners('warning').includes(second)
initializeWarningHandler()
const again = process.listeners('warning').length
let restored = -1
if (process.env.PROBE_REMOVE === '1') {
  process.removeAllListeners('warning')
  initializeWarningHandler()
  restored = process.listeners('warning').length
}
process.emitWarning('probe words', 'ProbeWarning')
process.emitWarning('Possible AbortSignal memory leak detected. 11 abort listeners added', 'MaxListenersExceededWarning')
process.emitWarning('Possible EventTarget memory leak detected. 11 probe listeners added', 'MaxListenersExceededWarning')
process.emitWarning('Possible EventEmitter memory leak detected. 11 probe listeners added', 'MaxListenersExceededWarning')
await new Promise(resolve => setImmediate(resolve))
await new Promise(resolve => setImmediate(resolve))
await flushDebugLogs()
console.log('OBSERVED ' + JSON.stringify({ before, after, again, restored, keptForeign, told }))
`

type Seen = { before: number; after: number; again: number; restored: number; keptForeign: boolean; told: string[] }
const scratch = mkdtempSync(join(tmpdir(), 'warning-handler-'))
function child(words: string[], env: Record<string, string> = {}): { seen: Seen | null; err: string[]; status: number | null } {
  const home = mkdtempSync(join(scratch, 'home-'))
  const file = join(scratch, 'child.mjs')
  writeFileSync(file, CHILD)
  mkdirSync(home, { recursive: true })
  const { NODE_ENV: _dropped, ...inherited } = process.env
  const run = spawnSync(process.execPath, [file, ...words], { encoding: 'utf8', env: { ...inherited, MERCURY_CONFIG_DIR: home, ...env } })
  const line = run.stdout.split('\n').find(text => text.startsWith('OBSERVED '))
  return { seen: line ? (JSON.parse(line.slice('OBSERVED '.length)) as Seen) : null, err: run.stderr.split('\n').filter(text => text.trim() !== ''), status: run.status }
}
const FOUR = ['ProbeWarning', 'MaxListenersExceededWarning', 'MaxListenersExceededWarning', 'MaxListenersExceededWarning']

try {
  section('§1 an ordinary run: the handler is the only listener, and warnings go to the debug log')
  {
    const run = child(['--log-stderr'])
    const seen = run.seen
    check('the child ran to its end', run.status === 0 && seen !== null, `exit ${run.status}: ${run.err.slice(-4).join(' | ')}`)
    if (seen !== null) {
      check('after it, one warning listener is left where there were several', seen.before >= 2 && seen.after === 1 && !seen.keptForeign, `${seen.before} before, ${seen.after} after; outside development ${WHERE} takes every other warning listener off`)
      check('a second call adds no second listener', seen.again === 1, String(seen.again))
      check('the listeners it took off are told about no warning', seen.told.length === 0, JSON.stringify(seen.told))
      const probe = run.err.filter(text => text.includes('ProbeWarning: probe words'))
      check('a warning becomes one debug line: level WARN, the mark [warning], then its name and message', probe.length === 1 && probe[0]!.includes('[WARN] [warning] ProbeWarning: probe words'), JSON.stringify(probe))
      check('the runtime no longer prints the warning itself', !run.err.some(text => text.includes('probe words') && !text.includes('[warning]')), JSON.stringify(run.err.filter(text => text.includes('probe words'))))
      const leak = (word: string): string[] => run.err.filter(text => text.includes(`Possible ${word} memory leak detected`))
      check('a listener-limit warning about AbortSignal is marked [internal warning]', leak('AbortSignal').length === 1 && leak('AbortSignal')[0]!.includes('[WARN] [internal warning] MaxListenersExceededWarning: Possible AbortSignal memory leak detected. 11 abort listeners added'), JSON.stringify(leak('AbortSignal')))
      check('one about EventTarget is marked [internal warning] too', leak('EventTarget').length === 1 && leak('EventTarget')[0]!.includes('[WARN] [internal warning] MaxListenersExceededWarning: Possible EventTarget memory leak detected'), JSON.stringify(leak('EventTarget')))
      check('one about anything else is a plain [warning]', leak('EventEmitter').length === 1 && leak('EventEmitter')[0]!.includes('[WARN] [warning] MaxListenersExceededWarning: Possible EventEmitter memory leak detected'), JSON.stringify(leak('EventEmitter')))
      const order = run.err.filter(text => text.includes('warning] ')).map(text => (text.includes('probe words') ? 'probe' : text.includes('AbortSignal') ? 'abort' : text.includes('EventTarget') ? 'target' : text.includes('EventEmitter') ? 'emitter' : '?'))
      check('the debug lines stand in the order the warnings were raised', order.join(',') === 'probe,abort,target,emitter', order.join(','))
    }
  }

  section('§2 with no debug log asked for, a warning prints nothing')
  {
    const run = child([])
    check('the child ran to its end with one listener', run.status === 0 && run.seen?.after === 1, `exit ${run.status}, ${JSON.stringify(run.seen)}`)
    check('nothing about any of the four warnings reaches stderr', !run.err.some(text => text.includes('probe words') || text.includes('memory leak detected')), JSON.stringify(run.err.slice(0, 4)))
  }

  section('§3 the handler comes back if its listener was taken off')
  {
    const run = child(['--log-stderr'], { PROBE_REMOVE: '1' })
    check('after every warning listener was removed, a new call leaves one again', run.status === 0 && run.seen?.restored === 1, `exit ${run.status}, ${JSON.stringify(run.seen)}`)
    check('and warnings are still logged once each', run.err.filter(text => text.includes('ProbeWarning: probe words')).length === 1, JSON.stringify(run.err.filter(text => text.includes('probe words'))))
  }

  section('§4 a development run keeps the other listeners')
  {
    const run = child(['--log-stderr'], { NODE_ENV: 'development' })
    const seen = run.seen
    check('the child ran to its end', run.status === 0 && seen !== null, `exit ${run.status}: ${run.err.slice(-4).join(' | ')}`)
    if (seen !== null) {
      check('the handler is added and no listener is taken off', seen.after === seen.before + 1 && seen.keptForeign && seen.again === seen.after, `${seen.before} before, ${seen.after} after, ${seen.again} after a second call; under NODE_ENV=development ${WHERE} removes nothing`)
      check('the listeners that were there are told every warning, each in the order raised', seen.told.filter(text => text.startsWith('first:')).map(text => text.slice(6)).join(',') === FOUR.join(',') && seen.told.filter(text => text.startsWith('second:')).map(text => text.slice(7)).join(',') === FOUR.join(','), JSON.stringify(seen.told))
      check('and the handler logs them as before', run.err.some(text => text.includes('[WARN] [warning] ProbeWarning: probe words')) && run.err.some(text => text.includes('[WARN] [internal warning] MaxListenersExceededWarning: Possible AbortSignal')), JSON.stringify(run.err.filter(text => text.includes('[WARN]')).slice(0, 4)))
    }
  }
} finally {
  removeScratch(scratch)
}

if (failures > 0) {
  console.error(`\nprove-warning-handler-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-warning-handler-behaviour: all green')
