import assert from 'node:assert/strict'
import { INITIAL_STATE, parseMultipleKeypresses, type ParsedInput } from '../../src/ink/input/input-decoder.ts'
import { InputEvent } from '../../src/ink/events/input-event.ts'
import { interpretResponse } from '../../src/ink/input/interpreter.ts'
import { TerminalQuerier, decrqm, kittyKeyboard, xtversion } from '../../src/ink/session/querier.ts'

function typed(atoms: ParsedInput[]): string {
  return atoms.flatMap(atom => atom.kind === 'key' ? [new InputEvent(atom).input] : []).join('')
}
const decode = (s: string): ParsedInput[] => parseMultipleKeypresses({ ...INITIAL_STATE }, s)[0]
assert.equal(typed(decode('\x1b[52;5R')), '', 'FAIL a late plain cursor-position reply must never type into the composer')
assert.equal(interpretResponse('\x1b[52;5R'), null)
const f3 = decode('\x1b[1;2R')[0]
assert.equal(f3?.kind, 'key')
assert.equal(f3?.kind === 'key' && f3.shift, true)
console.log('PASS late CPR is not input and the row-1 modified F3 key remains a key')

const { queueTerminalWidthProbe, readTerminalWidthMeasurements, WIDTH_PROBE_SAMPLES } = await import('../../src/ink/session/widthProbe.ts')
let written = ''
const stdout = { isTTY: true, rows: 40, columns: 120, write: (s: string) => { written += s; return true } } as unknown as NodeJS.WriteStream
let inlineWritten = ''
const inlineOut = { isTTY: true, rows: 40, columns: 120, write: (s: string) => { inlineWritten += s; return true } } as unknown as NodeJS.WriteStream
const inlineQuerier = new TerminalQuerier(inlineOut)
const inlineClose = queueTerminalWidthProbe(inlineQuerier, inlineOut, () => { throw new Error('an inline arm must never repaint for the probe') }, false)
assert.equal(inlineClose, null)
assert.equal(inlineWritten, '', 'FAIL an inline arm must send no sample bytes')
assert.deepEqual(readTerminalWidthMeasurements(), {})
void inlineQuerier.flush()
await new Promise(resolve => setTimeout(resolve, 20))
assert.equal((inlineWritten.match(/\x1b\[6n/g) ?? []).length, 0, 'FAIL no CPR sample rode the inline arm')
assert.ok(!inlineWritten.includes('\x1b7'), 'FAIL no sample touched the primary screen')
assert.equal(interpretResponse('\x1b[2;5R'), null)
console.log('PASS an inline (primary-screen) arm sends no sample bytes, repaints nothing and leaves the fallbacks standing')
const lateAlt = queueTerminalWidthProbe(inlineQuerier, inlineOut, () => {}, true)
assert.ok(lateAlt, 'FAIL a later arm on the alternate screen must still measure once')
const inlineSix = inlineWritten
void inlineQuerier.flush()
await new Promise(resolve => setTimeout(resolve, 20))
assert.equal((inlineWritten.slice(inlineSix.length).match(/\x1b\[6n/g) ?? []).length, 8, 'the later alt-screen arm rides its own batch with all eight samples')
lateAlt()
const querier = new TerminalQuerier(stdout)
let redraws = 0
const version = querier.send(xtversion())
const sync = querier.send(decrqm(2026))
const keyboard = querier.send(kittyKeyboard())
const finish = queueTerminalWidthProbe(querier, stdout, () => { redraws++ }, true)
assert.ok(finish)
assert.deepEqual(decode('\x1b[1;2R')[0], f3)
assert.equal(interpretResponse('\x1b[52;5R'), null)
assert.equal(typed(decode('\x1b[52;5R')), '')
console.log('PASS row-1 F3 stays a key inside the window and an unwritten row is ignored')
const batch = querier.flush()
assert.ok(written.startsWith('\x1b[>0q\x1b[?2026$p\x1b[?u'))
assert.equal((written.match(/\x1b\[6n/g) ?? []).length, 8)
assert.equal((written.match(/\x1b\[c/g) ?? []).length, 1)
assert.equal(written.includes('\x1b[?6n'), false)
assert.ok(written.endsWith('\x1b[c'))
console.log('PASS all eight samples ride one DA1-fenced batch alongside the upgrades')

const widths = [1, 4, 5, 2, 1, 0, 1, 2]
let parseState = { ...INITIAL_STATE }
for (const [index, sample] of WIDTH_PROBE_SAMPLES.entries()) {
  const reply = `\x1b[${index + 2};${widths[index]! + 1}R`
  for (const bytes of [reply.slice(0, 4), reply.slice(4)]) {
    const [atoms, next] = parseMultipleKeypresses(parseState, bytes)
    parseState = next
    assert.equal(typed(atoms), '')
    for (const atom of atoms) if (atom.kind === 'response') querier.onResponse(atom.response)
  }
  await Promise.resolve()
  assert.equal(readTerminalWidthMeasurements()[sample.kind], widths[index])
}
assert.equal(Object.keys(readTerminalWidthMeasurements()).length, 8)
assert.equal(Object.isFrozen(readTerminalWidthMeasurements()), true)
querier.onResponse({ type: 'decrpm', mode: 2026, status: 2 })
querier.onResponse({ type: 'kittyKeyboard', flags: 1 })
querier.onResponse({ type: 'da1', params: [1, 2] })
await batch
finish()
finish()
assert.equal(redraws, 1)
assert.equal(await version, undefined)
assert.equal((await sync)?.status, 2)
assert.equal((await keyboard)?.flags, 1)
assert.equal(interpretResponse('\x1b[2;2R'), null)
assert.equal(typed(decode('\x1b[2;2Rok')), 'ok')
assert.equal(queueTerminalWidthProbe(querier, stdout, () => { redraws++ }, true), null)
assert.equal((written.match(/\x1b\[6n/g) ?? []).length, 8)
console.log('PASS complete samples publish by class, close once and never re-probe the same stream')

const silentOut = { isTTY: true, rows: 40, columns: 120, write: () => true } as unknown as NodeJS.WriteStream
const silent = new TerminalQuerier(silentOut)
let silentRedraws = 0
const closeSilent = queueTerminalWidthProbe(silent, silentOut, () => { silentRedraws++ }, true)
assert.ok(closeSilent)
void silent.flush()
await new Promise(resolve => setTimeout(resolve, 300))
assert.equal(silentRedraws, 1)
assert.equal(interpretResponse('\x1b[2;5R'), null)
assert.equal(typed(decode('\x1b[2;5R')), '')
assert.deepEqual(readTerminalWidthMeasurements(), {})
closeSilent()
assert.equal(silentRedraws, 1)
console.log('PASS a missing fence closes the plain-CPR window and repaints once by its deadline')

const unorderedOut = { isTTY: true, rows: 40, columns: 120, write: () => true } as unknown as NodeJS.WriteStream
const unordered = new TerminalQuerier(unorderedOut)
const closeUnordered = queueTerminalWidthProbe(unordered, unorderedOut, () => {}, true)!
void unordered.flush()
unordered.onResponse({ type: 'cursorPosition', row: 3, col: 5 })
unordered.onResponse({ type: 'cursorPosition', row: 2, col: 2 })
await Promise.resolve()
assert.deepEqual(readTerminalWidthMeasurements(), {})
unordered.onResponse({ type: 'da1', params: [1, 2] })
closeUnordered()
console.log('PASS out-of-order or absent samples leave their classes unmeasured')

const smallOut = { isTTY: true, rows: 5, columns: 10, write: () => { throw new Error('small terminals must not be painted by the probe') } } as unknown as NodeJS.WriteStream
assert.equal(queueTerminalWidthProbe(new TerminalQuerier(smallOut), smallOut, () => {}, true), null)
console.log('PASS a viewport that cannot hold the samples stays unmeasured and unmodified')
console.log('WIDTH PROBE WIRE HOLDS')
