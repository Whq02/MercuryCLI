import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { basename, join } from 'node:path'

const home = process.env.MERCURY_CONFIG_DIR
assert(home, 'run with a scratch MERCURY_CONFIG_DIR')
type Hear = (event: string, file: string | null) => void
const platformWatch = fs.watch
const heard: string[] = []
let platform = true
let report: Hear = () => {}
let stir = (): void => {}
mock.module('node:fs', () => ({
  ...fs,
  watch: (root: string, options: fs.WatchOptions, listener: Hear) => {
    if (!platform) { report = listener; return { close() { report = () => {} } } }
    return platformWatch(root, options, (event, file) => { listener(event, file === null ? null : String(file)); heard.push(String(file)); stir() })
  },
}))
const { open } = await import('../../src/crew/board/store.ts')
const storeUrl = new URL('../../src/crew/board/store.ts', import.meta.url).href
const path = join(home, 'tail-signal.sqlite')
const db = basename(path)
const seat = { author: { sessionId: 'tail-signal', agentId: 'a', executionId: 'run' }, name: 'Alpha' }
const board = open(path, 'tail-signal')
board.enroll(seat)
let serial = 0
const commitElsewhere = (): string => {
  const text = `Another process committed row ${++serial}.`
  const source = `import { open } from ${JSON.stringify(storeUrl)}; const b = open(${JSON.stringify(path)}, 'tail-signal'); const r = b.post(${JSON.stringify(seat)}, { clientOpId: ${JSON.stringify(`elsewhere-${serial}`)}, kind: 'result', text: ${JSON.stringify(text)} }); b.close(); if (!r.ok) process.exit(1);`
  const child = spawnSync(process.execPath, ['-e', source], { stdio: 'ignore', env: process.env })
  assert.equal(child.status, 0, `the writing process exited ${child.status}; it opens the board with open from src/crew/board/store.ts and post must return ok`)
  return text
}
const when = (met: () => boolean, ms: number, what: () => string): Promise<void> => new Promise((resolve, reject) => {
  const deadline = setTimeout(() => { stir = () => {}; reject(new Error(what())) }, ms)
  stir = () => { if (!met()) return; clearTimeout(deadline); stir = () => {}; resolve() }
  stir()
})
const names = (): string => JSON.stringify([...new Set(heard.filter(name => name.startsWith(`${db}.`) && name.endsWith('.notify')).map(name => name.replace(/\.[0-9a-f-]{36}\.notify$/, '.<id>.notify')))].sort())
const tail = open(path, 'tail-signal', Date.now, true)
let wakes = 0
const stop = tail.subscribe(() => { wakes++; stir() })
const first = commitElsewhere()
await when(() => wakes > 0, 5000, () => `a commit by another process did not wake the read-only tail; its watcher reported ${names()}; the read-only tail must emit on the commit signal file in the watcher callback at the top of src/crew/board/store.ts`)
assert.equal(tail.view().events.at(-1)!.text, first, 'after the wake the read-only tail view must end with the row another process committed; see view in src/crew/board/store.ts')
let drained = false
for (let attempt = 0; attempt < 20 && !drained; attempt++) {
  const marker = `drained-${attempt}`
  fs.writeFileSync(join(home, marker), '')
  drained = await when(() => heard.includes(marker), 250, () => marker).then(() => true, () => false)
}
assert(drained, `the watcher never reported a file made after the commit; it reported ${names()}; this runtime may not deliver the watcher events the test needs`)
assert.equal(wakes, 1, `one commit woke the tail ${wakes} times; its watcher reported ${names()}; emit once per commit in the watcher callback and the subscribe in src/crew/board/store.ts`)
console.log(`PASS on this runtime one commit by another process wakes the read-only tail once, whichever names its watcher reports: ${names()}`)
stop()
platform = false
let calls = 0
const unsubscribe = tail.subscribe(() => calls++)
const signal = (): string => `${db}.${randomUUID()}.notify`
report('change', `${db}-wal`)
assert.equal(calls, 0, 'a WAL event ahead of the commit woke the tail; the watcher callback in src/crew/board/store.ts must not wake a subscriber before the commit is readable')
const second = commitElsewhere()
report('rename', signal())
assert.equal(calls, 1, 'the signal reported under its first name alone did not wake the tail; the watcher callback in src/crew/board/store.ts must emit for a file named the board file, a dot, an id and .notify')
assert.equal(tail.view().events.at(-1)!.text, second, 'after the signal the tail view must end with the second committed row; see view in src/crew/board/store.ts')
console.log('PASS the signal wakes the tail under its first name alone, after a WAL event that came before the commit was readable')
const third = commitElsewhere()
const made = signal()
for (const name of [made, made, `${db}.notify`, `${db}.notify`, `${db}-wal`]) report('rename', name)
assert.equal(calls, 2, `one commit reported under every name woke the tail ${calls - 1} times; the names of one commit must wake a subscriber once, see the watcher callback and subscribe in src/crew/board/store.ts`)
assert.equal(tail.view().events.at(-1)!.text, third, 'after the signals the tail view must end with the third committed row; see view in src/crew/board/store.ts')
console.log('PASS one commit reported under its first name and its settled name wakes the tail once')
const fourth = commitElsewhere()
for (const name of [`${db}-shm`, `other.sqlite.${randomUUID()}.notify`, 'other.sqlite.notify', `${db}.notify.part`, `x${db}.notify`]) report('rename', name)
assert.equal(calls, 2, 'a file that is not this board\'s signal woke the tail; the name test in the watcher callback at the top of src/crew/board/store.ts is too loose')
report('rename', `${db}.notify`)
assert.equal(calls, 3, 'the settled name of this board signal did not wake the tail; the watcher callback in src/crew/board/store.ts must accept it')
assert.equal(tail.view().events.at(-1)!.text, fourth, 'after the settled signal the tail view must end with the fourth committed row; see view in src/crew/board/store.ts')
console.log('PASS no other file in the board\'s directory wakes the tail')
const fifth = commitElsewhere()
const told = calls
await new Promise(resolve => setTimeout(resolve, 2500))
assert.equal(calls, told + 1, `a commit the watcher said nothing of woke the tail ${calls - told} times in 2.5 s: a subscribed tail compares the board's version every 2 s, BOARD_WAKE_FLOOR_MS in src/crew/board/store.ts`)
assert.equal(tail.view().events.at(-1)!.text, fifth, 'after the floor wake the tail view must end with the fifth committed row; see view in src/crew/board/store.ts')
report('rename', `${db}.notify`)
assert.equal(calls, told + 1, 'the watcher\'s late word of a commit the tail had read woke it again; a wake must only fire when the board version changed, see the emit path in src/crew/board/store.ts')
console.log('PASS a commit the watcher says nothing of wakes the tail within 2 s, once, and the watcher\'s late word wakes nobody')
unsubscribe()
tail.close(); board.close()
