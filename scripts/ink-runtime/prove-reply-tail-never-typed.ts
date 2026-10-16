#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InputEvent } from '../../src/ink/events/input-event.ts'
import { INITIAL_STATE, parseMultipleKeypresses, type KeyParseState, type ParsedInput } from '../../src/ink/input/input-decoder.ts'
import { openPlainCursorWindow } from '../../src/ink/input/interpreter.ts'
import { da1, decrqm, kittyKeyboard, oscColor, TerminalQuerier, xtversion } from '../../src/ink/session/querier.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const vis = (s: string): string => JSON.stringify(s)

const ESC = '\x1b'
const ST = ESC + '\\'

function composerText(atoms: ParsedInput[]): string {
  let out = ''
  for (const atom of atoms) {
    if (atom.kind !== 'key') continue
    const event = new InputEvent(atom)
    const k = event.key
    if (
      k.ctrl || k.meta || k.return || k.escape || k.tab || k.backspace || k.delete ||
      k.upArrow || k.downArrow || k.leftArrow || k.rightArrow || k.home || k.end ||
      k.pageUp || k.pageDown || k.wheelUp || k.wheelDown
    ) continue
    out += event.input
  }
  return out
}

function decode(feeds: Array<string | null>, owed: () => boolean): { atoms: ParsedInput[]; typed: string; responses: ParsedInput[] } {
  let state: KeyParseState = { ...INITIAL_STATE, stringReplyOwed: owed }
  const atoms: ParsedInput[] = []
  for (const feed of feeds) {
    const [got, next] = parseMultipleKeypresses(state, feed)
    atoms.push(...got)
    state = next
  }
  return { atoms, typed: composerText(atoms), responses: atoms.filter(a => a.kind === 'response') }
}

const OWED = (): boolean => true
const SETTLED = (): boolean => false
const nulls = (n: number): null[] => Array<null>(n).fill(null)

type Shape = { name: string; reply: string; string: boolean }
const SHAPES: Shape[] = [
  { name: 'XTVERSION (iTerm2 3.5.14)', reply: `${ESC}P>|iTerm2 3.5.14${ST}`, string: true },
  { name: 'XTVERSION (kitty)', reply: `${ESC}P>|kitty(0.36.4)${ST}`, string: true },
  { name: 'OSC 11 background, BEL', reply: `${ESC}]11;rgb:1e1e/1e1e/1e1e\x07`, string: true },
  { name: 'OSC 11 background, ST', reply: `${ESC}]11;rgb:1e1e/1e1e/1e1e${ST}`, string: true },
  { name: 'DECRPM 2026', reply: `${ESC}[?2026;2$y`, string: false },
  { name: 'DECRPM 2026 unknown', reply: `${ESC}[?2026;0$y`, string: false },
  { name: 'kitty flags', reply: `${ESC}[?1u`, string: false },
  { name: 'CPR row 2', reply: `${ESC}[2;3R`, string: false },
  { name: 'CPR row 5', reply: `${ESC}[5;4R`, string: false },
  { name: 'CPR row 9', reply: `${ESC}[9;2R`, string: false },
  { name: 'DECXCPR', reply: `${ESC}[?5;4R`, string: false },
  { name: 'DA1 xterm', reply: `${ESC}[?64;1;2;6;9;15;18;21;22c`, string: false },
  { name: 'DA1 iTerm2', reply: `${ESC}[?62;4c`, string: false },
  { name: 'DA1 Terminal.app', reply: `${ESC}[?1;2c`, string: false },
  { name: 'DA2', reply: `${ESC}[>0;95;0c`, string: false },
]

function* splits(reply: string): Generator<{ label: string; feeds: Array<string | null> }> {
  yield { label: 'whole', feeds: [reply, null] }
  yield { label: 'late by one flush', feeds: [null, reply, null] }
  for (let cut = 1; cut < reply.length; cut++) {
    for (let flushes = 0; flushes <= 2; flushes++) {
      yield { label: `split@${cut} flushes=${flushes}`, feeds: [reply.slice(0, cut), ...nulls(flushes), reply.slice(cut), null] }
    }
    if (cut < 2) continue
    for (let cut2 = cut + 1; cut2 < reply.length; cut2++) {
      for (const f1 of [0, 1, 2]) for (const f2 of [0, 1, 2]) {
        yield {
          label: `split@${cut},${cut2} flushes=${f1},${f2}`,
          feeds: [reply.slice(0, cut), ...nulls(f1), reply.slice(cut, cut2), ...nulls(f2), reply.slice(cut2), null],
        }
      }
    }
  }
}

console.log('============================================================')
console.log(' a terminal reply never types into the composer')
console.log(' the five solicited shapes, split at every byte boundary, late by one flush and more,')
console.log(' while the terminal owes a string reply (the probe batch is open)')
console.log('============================================================')

for (const shape of SHAPES) {
  let combos = 0
  let firstLeak = ''
  let lostReplies = 0
  for (const { label, feeds } of splits(shape.reply)) {
    combos++
    const got = decode(feeds, OWED)
    if (got.typed !== '' && firstLeak === '') firstLeak = `${label}: typed ${vis(got.typed)}`
    if (shape.string && got.responses.length !== 1) lostReplies++
  }
  check(`${shape.name}: nothing typed across ${combos} split/flush combinations`, firstLeak === '', firstLeak)
  if (shape.string) check(`${shape.name}: the reply is still recognised in every combination (held, not dropped)`, lostReplies === 0, `${lostReplies} combinations lost the reply`)
}

console.log('\n the owner\'s shape: the version reply dribbles its last digit after two flush windows')
const dribble = [`${ESC}P>|iTerm2 3.5.1`, null, null, '4', null, ST, null]
const held = decode(dribble, OWED)
check('while the reply is owed, the digit is held with its body and nothing is typed', held.typed === '', `typed ${vis(held.typed)}`)
check('the reassembled reply resolves as the xtversion response "iTerm2 3.5.14"', held.responses.length === 1 && held.responses[0]!.kind === 'response' && held.responses[0]!.response.type === 'xtversion' && held.responses[0]!.response.name === 'iTerm2 3.5.14', JSON.stringify(held.responses))
const headless = decode([`${ESC}P>|iTerm2 3.5.1`, null, null, `4${ST}`, null], SETTLED)
check('past the window, a string token that lost its head is dropped at its terminator, never typed', headless.typed === '', `typed ${vis(headless.typed)}`)
const lateDigit = decode(dribble, SETTLED)
check('past the window, a body byte carried alone is never flushed as a keypress (no digit typed)', !/[0-9]/.test(lateDigit.typed), `typed ${vis(lateDigit.typed)}`)
console.log(`  (past the window the lone terminator stays the alt+\\ chord it is today: typed ${vis(lateDigit.typed)})`)

console.log('\n the whole boot reply stream of an iTerm2-shaped terminal, split at every byte boundary with one flush')
const closeWindow = openPlainCursorWindow([2, 3, 4, 5, 6, 7, 8, 9], performance.now() + 60_000)
const cprs = [2, 3, 4, 5, 6, 7, 8, 9].map(row => `${ESC}[${row};3R`).join('')
const stream = `${ESC}P>|iTerm2 3.5.14${ST}${ESC}]11;rgb:1e1e/1e1e/1e1e\x07${ESC}[?2026;2$y${ESC}[?1u${cprs}${ESC}[?64;1;2;6;9;15;18;21;22c`
const wholeStream = decode([stream, null], OWED)
check('the whole stream in one read is 13 responses and no text', wholeStream.responses.length === 13 && wholeStream.typed === '', `${wholeStream.responses.length} responses, typed ${vis(wholeStream.typed)}`)
{
  let leak = ''
  for (let cut = 1; cut < stream.length; cut++) {
    const got = decode([stream.slice(0, cut), null, stream.slice(cut), null], OWED)
    if (got.typed !== '') { leak = `split@${cut}: typed ${vis(got.typed)}`; break }
  }
  check(`no split of the ${stream.length}-byte stream with a flush between the halves types anything`, leak === '', leak)
}
closeWindow()

console.log('\n the laws that stand when no reply is owed')
const chord = decode([`${ESC}]`, null], SETTLED)
check('alt+] alone at the flush is still one ESC-led key (the meta chord)', chord.atoms.length === 1 && chord.atoms[0]!.kind === 'key' && chord.atoms[0]!.sequence === `${ESC}]`, JSON.stringify(chord.atoms))
const sealed = decode([`${ESC}]11;rgb:1e1e/`, null, null, 'ab', null, 'ok'], SETTLED)
check('a sealed string head grounds after its two flushes and the keyboard is heard again', sealed.typed.endsWith('ok') && !sealed.typed.includes('rgb'), `typed ${vis(sealed.typed)}`)
const escape = decode([ESC, null, 'hello'], SETTLED)
check('a lone ESC at the flush is still Escape and the next read is text', escape.atoms[0]?.kind === 'key' && escape.atoms[0].name === 'escape' && escape.typed === 'hello', JSON.stringify(escape.atoms))
const owedThenSettled = (() => {
  let owed = true
  const state0: KeyParseState = { ...INITIAL_STATE, stringReplyOwed: () => owed }
  let state = state0
  const atoms: ParsedInput[] = []
  for (const feed of [`${ESC}]11;rgb:1e1e/`, null, null, null]) {
    const [got, next] = parseMultipleKeypresses(state, feed)
    atoms.push(...got)
    state = next
  }
  owed = false
  for (const feed of [null, null, 'ab', null, 'ok']) {
    const [got, next] = parseMultipleKeypresses(state, feed)
    atoms.push(...got)
    state = next
  }
  return { typed: composerText(atoms), incomplete: state.incomplete }
})()
check('once the owed reply is closed, the seal ends by the standing two-flush law and the keyboard is heard again', owedThenSettled.typed === 'ok' && owedThenSettled.incomplete === '', JSON.stringify(owedThenSettled))
check('INITIAL_STATE stays unmutated', INITIAL_STATE.stringReplyOwed === undefined && INITIAL_STATE.incomplete === '')

console.log('\n the product mark: the querier owes a string reply from the write until its answer or the sentinel')
{
  const writes: string[] = []
  const querier = new TerminalQuerier({ write: (s: string) => { writes.push(s); return true } } as never)
  const owes = (): boolean => typeof (querier as { stringReplyOwed?: () => boolean }).stringReplyOwed === 'function' && querier.stringReplyOwed()
  check('nothing owed before a query is sent', owes() === false)
  const version = querier.send(xtversion())
  check('a query in the open batch (not yet written) is not owed', owes() === false)
  const flushed = querier.flush()
  check('after the write, the string reply is owed', owes() === true)
  querier.onResponse({ type: 'xtversion', name: 'iTerm2 3.5.14' })
  check('the answered string query is no longer owed while the batch still awaits its sentinel', owes() === false)
  querier.onResponse({ type: 'da1', params: [62, 4] })
  await Promise.all([version, flushed])
  check('the sentinel closes the batch', querier.settled() === true)
  const colour = querier.send(oscColor(11))
  const sync = querier.send(decrqm(2026))
  const kitty = querier.send(kittyKeyboard())
  const second = querier.flush()
  check('an OSC colour query owes a string reply', owes() === true)
  querier.onResponse({ type: 'da1', params: [62, 4] })
  await Promise.all([colour, sync, kitty, second])
  check('the DA1 sentinel settles every owed reply', owes() === false && querier.settled() === true)
  const probe = querier.send(decrqm(2026))
  const third = querier.flush()
  check('a batch of CSI-only queries owes no string reply', owes() === false)
  querier.onResponse({ type: 'da1', params: [1, 2] })
  await Promise.all([probe, third])
  const explicit = querier.send(da1())
  const fourth = querier.flush()
  check('an explicit DA1 query owes no string reply', owes() === false)
  querier.onResponse({ type: 'da1', params: [1, 2] })
  querier.onResponse({ type: 'da1', params: [1, 2] })
  await Promise.all([explicit, fourth])
  check('the probe batches reached the wire', writes.length === 4, `${writes.length} writes`)
}

console.log('\n the seam: the app seeds the mark and the decoder hands it to the scanner')
{
  const root = join(import.meta.dir, '..', '..')
  const app = readFileSync(join(root, 'src/ink/components/App.tsx'), 'utf8')
  const decoder = readFileSync(join(root, 'src/ink/input/input-decoder.ts'), 'utf8')
  check('App seeds the parse state with the querier\'s mark', app.includes('stringReplyOwed: () => this.querier.stringReplyOwed()'))
  check('the decoder creates its scanner with the mark', decoder.includes('stringReplyOwed: prevState.stringReplyOwed'))
}

console.log(`\n${checks} checks, ${failures} failed`)
console.log(failures === 0 ? 'GREEN: a terminal reply never types into the composer' : `RED: ${failures} check(s) let a reply reach the composer`)
process.exit(failures === 0 ? 0 : 1)
