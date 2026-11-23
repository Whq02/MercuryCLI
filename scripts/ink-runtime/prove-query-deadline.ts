import assert from 'node:assert/strict'
import { TerminalQuerier, decrqm, kittyKeyboard, oscColor, xtversion } from '../../src/screen/renderer/terminal-session/terminalQuerier.ts'

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
assert.equal(completed, true, 'FAIL lost DA1 must release the upgrade batch by its 250 ms deadline; check the batch timer in TerminalQuerier.flush (src/screen/renderer/terminal-session/terminalQuerier.ts)')
assert.equal(querier.settled(), true, 'querier should have no pending queries once the deadline closed the batch; check closeBatch in src/screen/renderer/terminal-session/terminalQuerier.ts')
assert.equal(await version, undefined, 'the unanswered xtversion query should resolve undefined when the batch deadline closes; check closeBatch in src/screen/renderer/terminal-session/terminalQuerier.ts')
assert.deepEqual(await sync, { type: 'decrpm', mode: 2026, status: 2 }, 'the answered decrqm query must keep its response when the batch closes by deadline; check TerminalQuerier.onResponse/closeBatch in src/screen/renderer/terminal-session/terminalQuerier.ts')
assert.deepEqual(await keyboard, { type: 'kittyKeyboard', flags: 1 }, 'the answered kittyKeyboard query must keep its response when the batch closes by deadline; check TerminalQuerier.onResponse/closeBatch in src/screen/renderer/terminal-session/terminalQuerier.ts')
assert.deepEqual(await background, { type: 'osc', code: 11, data: 'rgb:0000/0000/0000' }, 'the answered oscColor query must keep its response when the batch closes by deadline; check TerminalQuerier.onResponse/closeBatch in src/screen/renderer/terminal-session/terminalQuerier.ts')
await batch
console.log('PASS missing DA1 releases every query and retains upgrades already answered')

querier.onResponse({ type: 'da1', params: [1, 2] })
let nextFinished = false
const nextQuery = querier.send(xtversion())
const nextBatch = querier.flush().then(() => { nextFinished = true })
querier.onResponse({ type: 'xtversion', name: 'fixture' })
await Promise.resolve()
assert.equal(nextFinished, false, 'a later batch must wait for its own DA1 fence and not be released by an earlier one; check how TerminalQuerier (src/screen/renderer/terminal-session/terminalQuerier.ts) pairs da1 responses with batches')
querier.onResponse({ type: 'da1', params: [1, 2] })
await nextBatch
assert.equal((await nextQuery)?.name, 'fixture', 'the later batch should deliver its xtversion response; check TerminalQuerier.onResponse in src/screen/renderer/terminal-session/terminalQuerier.ts')
console.log('PASS a later batch still owns its own fence')
console.log('QUERY DEADLINE HOLDS')
