import assert from 'node:assert/strict'
import { TerminalQuerier, decrqm, kittyKeyboard, oscColor, xtversion } from '../../src/ink/session/querier.ts'

const stdout = { write: () => true } as unknown as NodeJS.WriteStream
const querier = new TerminalQuerier(stdout)
const version = querier.send(xtversion())
const sync = querier.send(decrqm(2026))
const keyboard = querier.send(kittyKeyboard())
const background = querier.send(oscColor(11))
let completed = false
const batch = querier.flush().then(() => { completed = true })
querier.onResponse({ type: 'decrpm', mode: 2026, status: 2 })
querier.onResponse({ type: 'kittyKeyboard', flags: 1 })
querier.onResponse({ type: 'osc', code: 11, data: 'rgb:0000/0000/0000' })
await new Promise(resolve => setTimeout(resolve, 300))
assert.equal(completed, true, 'FAIL lost DA1 must release the upgrade batch by its 250 ms deadline')
assert.equal(querier.settled(), true)
assert.equal(await version, undefined)
assert.deepEqual(await sync, { type: 'decrpm', mode: 2026, status: 2 })
assert.deepEqual(await keyboard, { type: 'kittyKeyboard', flags: 1 })
assert.deepEqual(await background, { type: 'osc', code: 11, data: 'rgb:0000/0000/0000' })
await batch
console.log('PASS missing DA1 releases every query and retains upgrades already answered')

querier.onResponse({ type: 'da1', params: [1, 2] })
let nextFinished = false
const nextQuery = querier.send(xtversion())
const nextBatch = querier.flush().then(() => { nextFinished = true })
querier.onResponse({ type: 'xtversion', name: 'fixture' })
await Promise.resolve()
assert.equal(nextFinished, false)
querier.onResponse({ type: 'da1', params: [1, 2] })
await nextBatch
assert.equal((await nextQuery)?.name, 'fixture')
console.log('PASS a later batch still owns its own fence')
console.log('QUERY DEADLINE HOLDS')
