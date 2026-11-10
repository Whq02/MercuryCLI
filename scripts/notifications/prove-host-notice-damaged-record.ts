#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const home = mkdtempSync(join(tmpdir(), 'host-notice-damaged-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.argv.push('--log-stderr')
const debugLines: string[] = []
const stderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: string | Uint8Array): boolean => {
  debugLines.push(String(chunk))
  return true
}) as typeof process.stderr.write

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)

const { hostNotice, deliverHostNotices, watchHostNotices } = await import('../../src/services/host/notices.ts')
const { getCommandQueue, dequeue } = await import('../../src/input-core/command-queue.ts')

const dir = join(home, 'host', 'notices')
const record = { id: 'damaged-pod', generation: 'g1', sessionId: 'S', name: 'Damaged pod', recipe: 'fixture', price: 0, startedAt: new Date().toISOString(), status: 'RUNNING' }
hostNotice(record as never, 'ready', 'The model is ready')
hostNotice({ ...record, generation: 'g2' } as never, 'failed', 'The setup failed')
hostNotice({ ...record, id: 'other-pod', sessionId: 'T' } as never, 'ready', 'Another session is ready')
const valid = readdirSync(dir).filter(name => name.endsWith('.json'))
mkdirSync(dir, { recursive: true })
const DAMAGED: Record<string, string> = {
  '0000-cut.json': '{ "id": "x", "sessionId": "S", "words": "<task-notif',
  '5555-null.json': 'null',
  '8888-list.json': '["S"]',
  'aaaa-wordless.json': JSON.stringify({ id: 'x', sessionId: 'S' }),
  'ffff-numbered.json': JSON.stringify({ id: 'x', sessionId: 7, words: 'w' }),
  'zzzz-empty.json': '',
}
for (const [name, text] of Object.entries(DAMAGED)) writeFileSync(join(dir, name), text)
const wordsOf = (): string[] => getCommandQueue().map(command => String(command.value))
const noticeLines = (): string[] => debugLines.filter(line => line.includes('Host notice'))

section('§1 a notice file that cannot be read is passed over; the valid ones of the session are still queued')
{
  check('the scene holds three valid notices (two for S, one for T) among six damaged files', valid.length === 3 && readdirSync(dir).filter(name => name.endsWith('.json')).length === 9, readdirSync(dir).join(' '))
  let thrown = ''
  try {
    deliverHostNotices('S')
  } catch (error) {
    thrown = `${(error as Error).name}: ${(error as Error).message}`
  }
  check('the delivery does not throw on a damaged record', thrown === '', thrown)
  const queued = wordsOf()
  check('both of the session\'s notices are queued, whatever the directory order', queued.length === 2 && queued.some(w => w.includes('The model is ready')) && queued.some(w => w.includes('The setup failed')), JSON.stringify(queued.map(w => w.slice(0, 60))))
  check('another session\'s notice is not', !queued.some(w => w.includes('Another session')))
  try {
    deliverHostNotices('S')
  } catch {}
  check('a second pass queues nothing twice', wordsOf().length === 2, String(wordsOf().length))
}

section('§2 the damaged files are named once each in the debug log and left as they are')
{
  const lines = noticeLines()
  check('each damaged file is named once, with why it was skipped', Object.keys(DAMAGED).every(name => lines.filter(line => line.includes(join(dir, name)) && line.includes('skipped:')).length === 1), lines.join(' | '))
  check('a file that parses but is not a notice says so', lines.some(line => line.includes('aaaa-wordless.json') && line.includes('not a notice record')) && lines.some(line => line.includes('5555-null.json') && line.includes('not a notice record')), lines.join(' | '))
  check('no valid notice is named', valid.every(name => !lines.some(line => line.includes(name))))
  check('the damaged files keep their bytes and gain no delivered mark', Object.entries(DAMAGED).every(([name, text]) => readFileSync(join(dir, name), 'utf8') === text && !existsSync(join(dir, `${name}.delivered`))))
}

section('§3 consumption still acknowledges; the watcher delivers past the damage')
{
  dequeue()
  const marks = readdirSync(dir).filter(name => name.endsWith('.delivered'))
  check('a consumed notice gains its delivered mark', marks.length === 1 && valid.includes(marks[0]!.replace(/\.delivered$/, '')), marks.join(' '))
  const before = wordsOf().length
  const stop = watchHostNotices(() => 'T')
  stop()
  const after = wordsOf()
  check('the watcher\'s first tick queues the other session\'s notice past the same damaged files', after.length === before + 1 && after.some(w => w.includes('Another session is ready')), JSON.stringify(after.map(w => w.slice(0, 50))))
  check('…and names no damaged file a second time', noticeLines().length === Object.keys(DAMAGED).length, String(noticeLines().length))
}

process.stderr.write = stderrWrite
removeScratch(home)
console.log(failures === 0 ? '\nprove-host-notice-damaged-record: ALL LAWS HOLD' : `\nprove-host-notice-damaged-record: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
