#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import React from 'react'
import { InputEvent } from '../../src/ink/events/input-event.ts'
import { INITIAL_STATE, parseMultipleKeypresses, type KeyParseState, type ParsedInput } from '../../src/ink/input/input-decoder.ts'
import Text from '../../src/ink/components/Text.tsx'
import useInput from '../../src/ink/hooks/use-input.ts'
import Ink from '../../src/ink/ink.tsx'

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
const BEL = '\x07'

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

type Decoded = { atoms: ParsedInput[]; typed: string; responses: ParsedInput[]; keys: string[]; incomplete: string }
function decode(feeds: Array<string | null>, owed: () => boolean = SETTLED): Decoded {
  let state: KeyParseState = { ...INITIAL_STATE, stringReplyOwed: owed }
  const atoms: ParsedInput[] = []
  for (const feed of feeds) {
    const [got, next] = parseMultipleKeypresses(state, feed)
    atoms.push(...got)
    state = next
  }
  const keys = atoms.flatMap(a => {
    if (a.kind !== 'key') return []
    if (a.sequence === ST) return ['ST-key']
    if (a.sequence === BEL) return ['ctrl+g']
    const k = new InputEvent(a).key
    return [`${k.ctrl ? 'ctrl+' : ''}${k.meta ? 'alt+' : ''}${a.name || a.sequence}`]
  })
  return { atoms, typed: composerText(atoms), responses: atoms.filter(a => a.kind === 'response'), keys, incomplete: state.incomplete }
}
const SETTLED = (): boolean => false
const nulls = (n: number): null[] => Array<null>(n).fill(null)
const oneResponse = (d: Decoded, type: string): boolean => d.responses.length === 1 && d.responses[0]!.kind === 'response' && d.responses[0]!.response.type === type

console.log('============================================================')
console.log(' a terminal reply that arrives late is held to its terminator, however late')
console.log(' (the probe batch closed 250 ms after its write; the terminal answered later, in pieces)')
console.log('============================================================')

console.log('\n the owner\'s shape: the version reply dribbles in three reads with a flush window between each, after the batch closed')
const owner = decode([`${ESC}P>|iTerm2 3.5.`, null, '1', null, '4', null, ST, null])
check('nothing is typed into the composer', owner.typed === '', `typed ${vis(owner.typed)}`)
check('the reassembled reply resolves as the xtversion response "iTerm2 3.5.14"', oneResponse(owner, 'xtversion') && (owner.responses[0] as { response: { name?: string } }).response.name === 'iTerm2 3.5.14', JSON.stringify(owner.responses))
check('the terminator is the reply\'s own, never a key (today a lone ST types a backslash)', !owner.keys.includes('ST-key'), JSON.stringify(owner.keys))

console.log('\n the colour reply with a BEL terminator, dribbling the same way: its BEL is never the ctrl+g key (the external editor)')
const colour = decode([`${ESC}]11;rgb:1e1e/`, null, '1e1e', null, '/1e1e', null, BEL, null])
check('nothing is typed', colour.typed === '', `typed ${vis(colour.typed)}`)
check('the reply resolves as the OSC 11 response', oneResponse(colour, 'osc'), JSON.stringify(colour.responses))
check('no ctrl+g keypress is ever produced', !colour.keys.some(k => k === 'ctrl+g'), JSON.stringify(colour.keys))

console.log('\n every solicited string reply, split into three reads with one or two flush windows between each, after the batch closed')
console.log(' (the one split outside the law: a lone ESC, then a lone introducer letter, each at its own flush — two keystrokes by construction)')
const SHAPES = [
  { name: 'XTVERSION (iTerm2 3.5.14)', reply: `${ESC}P>|iTerm2 3.5.14${ST}`, type: 'xtversion', head: 4 },
  { name: 'XTVERSION (kitty)', reply: `${ESC}P>|kitty(0.36.4)${ST}`, type: 'xtversion', head: 4 },
  { name: 'OSC 11 background, BEL', reply: `${ESC}]11;rgb:1e1e/1e1e/1e1e${BEL}`, type: 'osc', head: 6 },
  { name: 'OSC 11 background, ST', reply: `${ESC}]11;rgb:1e1e/1e1e/1e1e${ST}`, type: 'osc', head: 6 },
  { name: 'OSC 10 foreground, ST', reply: `${ESC}]10;rgb:ffff/ffff/ffff${ST}`, type: 'osc', head: 6 },
]
function headArrivesWithinAWindow(head: number, cut: number, cut2: number, f1: number, f2: number): boolean {
  if (cut >= head) return true
  if (cut <= 2) return cut2 >= head || f2 === 1
  if (f1 === 2) return false
  return cut2 >= head || f2 === 1
}
for (const shape of SHAPES) {
  let combos = 0
  let firstLeak = ''
  let lost = 0
  let chords = 0
  let deaf = 0
  let held = 0
  for (let cut = 1; cut < shape.reply.length; cut++) {
    for (let cut2 = cut + 1; cut2 < shape.reply.length; cut2++) {
      for (const f1 of [1, 2]) for (const f2 of [1, 2]) {
        if (cut === 1 && cut2 === 2) continue
        combos++
        const label = `split@${cut},${cut2} flushes=${f1},${f2}`
        const got = decode([shape.reply.slice(0, cut), ...nulls(f1), shape.reply.slice(cut, cut2), ...nulls(f2), shape.reply.slice(cut2), null])
        if (got.typed !== '' && firstLeak === '') firstLeak = `${label}: typed ${vis(got.typed)}`
        if (got.keys.some(k => k === 'ctrl+g' || k === 'ST-key')) chords++
        if (headArrivesWithinAWindow(shape.head, cut, cut2, f1, f2)) {
          held++
          if (!oneResponse(got, shape.type)) lost++
        }
        if (got.incomplete !== '') deaf++
      }
    }
  }
  check(`${shape.name}: nothing typed across ${combos} three-way splits`, firstLeak === '', firstLeak)
  check(`${shape.name}: no split turns the terminator into a key (ctrl+g, or the ST typed as a backslash)`, chords === 0, `${chords} splits produced a key`)
  check(`${shape.name}: every split whose head lands within a flush window of its start is recognised, however late the body (${held} splits)`, lost === 0, `${lost} splits lost the reply`)
  check(`${shape.name}: the decoder ends every split with an empty carry (nothing left to swallow the next keystroke)`, deaf === 0, `${deaf} splits left a carry`)
}

console.log('\n the body-less head flushed first, the body dribbling later')
const headFirst = decode([`${ESC}P`, null, '>|iTerm2 3.5.1', null, '4', null, ST, null])
check('nothing typed when the head alone met the first flush', headFirst.typed === '', `typed ${vis(headFirst.typed)}`)
check('the reply still resolves once the body rejoined its head', oneResponse(headFirst, 'xtversion'), JSON.stringify(headFirst.responses))
const headDigits = decode([`${ESC}]1`, null, '1;rgb:1e1e/', null, '1e1e/1e1e', null, BEL, null])
check('a head cut inside its number is held once the number closes, and the colour reply resolves', headDigits.typed === '' && oneResponse(headDigits, 'osc') && !headDigits.keys.includes('ctrl+g'), `typed ${vis(headDigits.typed)} keys ${JSON.stringify(headDigits.keys)} responses ${headDigits.responses.length}`)

console.log('\n the hold has no clock: ten bare flush windows pass and the body is still whole')
const tenFlushes = decode([`${ESC}P>|iTerm2 3.5.1`, ...nulls(10), '4', ...nulls(10), ST, null])
check('after twenty flush windows the reply still resolves and nothing typed', tenFlushes.typed === '' && oneResponse(tenFlushes, 'xtversion'), `typed ${vis(tenFlushes.typed)} responses ${tenFlushes.responses.length}`)

console.log('\n the laws that stand')
const chord = decode([`${ESC}]`, null])
check('alt+] alone at the flush is still one ESC-led key (the meta chord)', chord.atoms.length === 1 && chord.atoms[0]!.kind === 'key' && chord.atoms[0]!.sequence === `${ESC}]`, JSON.stringify(chord.atoms))
const altBackslash = decode([ST, null])
check('ESC \\ typed on its own is still the key it is today', altBackslash.keys.length === 1 && altBackslash.keys[0] === 'ST-key', JSON.stringify(altBackslash.keys))
const ctrlG = decode([BEL])
check('ctrl+g typed on its own is still the key', ctrlG.keys.length === 1 && ctrlG.keys[0] === 'ctrl+g', JSON.stringify(ctrlG.keys))
const escape = decode([ESC, null, 'hello'])
check('a lone ESC at the flush is still Escape and the next read is text', escape.atoms[0]?.kind === 'key' && escape.atoms[0].name === 'escape' && escape.typed === 'hello', JSON.stringify(escape.atoms))
const metaTyping = decode([`${ESC}]abc`, null, null, 'de', null, 'ok'])
check('a meta chord followed by typing (no reply shape) still grounds by the two-flush law and the keyboard is heard again', metaTyping.typed.endsWith('ok') && !metaTyping.typed.includes('abc'), `typed ${vis(metaTyping.typed)}`)
const metaDcs = decode([`${ESC}Pxyz`, null, null, 'de', null, 'ok'])
check('the same for a DCS-shaped chord that is not a version reply', metaDcs.typed.endsWith('ok') && !metaDcs.typed.includes('xyz'), `typed ${vis(metaDcs.typed)}`)

console.log('\n a held reply body never deafens the loop for good: a control byte is not a reply byte and ends the hold')
const enter = decode([`${ESC}]11;rgb:1e1e/`, null, null, 'ab', null, '\r', 'ok', null])
check('Enter inside a held body is heard as Enter and the keyboard is live again', enter.keys.includes('return') && enter.typed.endsWith('ok'), `keys ${JSON.stringify(enter.keys)} typed ${vis(enter.typed)}`)
check('the swallowed body bytes stay dropped (never typed)', !enter.typed.includes('rgb') && !enter.typed.includes('ab'), `typed ${vis(enter.typed)}`)
const arrow = decode([`${ESC}P>|iTerm2 3.`, null, null, `${ESC}[A`, 'ok', null])
check('an arrow key inside a held body is decoded as the arrow and the keyboard is live again', arrow.keys.includes('up') && arrow.typed === 'ok', `keys ${JSON.stringify(arrow.keys)} typed ${vis(arrow.typed)}`)
const pasted = decode([`${ESC}[200~`, `${ESC}]11;pasted bytes`, `${ESC}[201~`, 'ok', null])
check('a pasted reply-shaped head ends at the paste\'s own end mark, the paste lands and typing follows', pasted.atoms.some(a => a.kind === 'key' && a.isPasted === true) && pasted.typed.endsWith('ok') && pasted.incomplete === '', `atoms ${JSON.stringify(pasted.atoms.map(a => a.kind === 'key' ? (a.isPasted ? 'paste' : a.name || a.sequence) : a.kind))} typed ${vis(pasted.typed)} carry ${vis(pasted.incomplete)}`)
const strayBel = decode([`${ESC}]11;rgb:1e1e/`, null, '\r', null, `1e1e/1e1e${BEL}`, null])
check('the terminator of a body a keystroke cut short is never the ctrl+g key', !strayBel.keys.includes('ctrl+g'), JSON.stringify(strayBel.keys))
const strayST = decode([`${ESC}P>|iTerm2 3.5.1`, null, '\r', null, `4${ST}`, null])
check('the terminator of a version body a keystroke cut short is never a key', !strayST.keys.includes('ST-key'), JSON.stringify(strayST.keys))
const laterChord = decode([`${ESC}P>|iTerm2 3.5.1`, null, '\r', null, `${ESC}[A`, null, ST, null])
check('once another key followed the cut, ESC \\ is a key again (the debt is paid or forgotten, never kept)', laterChord.keys.includes('ST-key'), JSON.stringify(laterChord.keys))
check('INITIAL_STATE stays unmutated', INITIAL_STATE.stringReplyOwed === undefined && INITIAL_STATE.incomplete === '')

console.log('\n the sender: the identity probe (version, colour, sync, kitty) leaves once per session, at the first raw-mode arm — a later arm of the input owner never sends it again')
{
  class Output extends EventEmitter {
    isTTY = true
    columns = 120
    rows = 40
    writes: string[] = []
    write(value: string): boolean { this.writes.push(value); return true }
  }
  class Input extends EventEmitter {
    isTTY = true
    isRaw = false
    readableLength = 0
    setEncoding(): this { return this }
    setRawMode(value: boolean): this { this.isRaw = value; return this }
    ref(): this { return this }
    unref(): this { return this }
    read(): null { return null }
  }
  function SceneA(): React.ReactElement {
    useInput(() => {})
    return React.createElement(Text, null, 'scene A')
  }
  function SceneB(): React.ReactElement {
    useInput(() => {})
    return React.createElement(Text, null, 'scene B')
  }
  function Host({ which }: { which: 'a' | 'b' | 'none' }): React.ReactElement {
    return React.createElement(Text, null, which === 'a' ? React.createElement(SceneA) : which === 'b' ? React.createElement(SceneB) : 'no input owner')
  }
  const stdout = new Output()
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, patchConsole: false, exitOnCtrlC: false })
  const versionQueries = (): number => stdout.writes.join('').split(`${ESC}[>0q`).length - 1
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))
  ink.render(React.createElement(Host, { which: 'a' }))
  await settle()
  check('the first raw-mode arm sends the version query once', versionQueries() === 1, `${versionQueries()} queries`)
  check('raw mode is on with the first input owner', stdin.isRaw === true)
  ink.render(React.createElement(Host, { which: 'b' }))
  await settle()
  check('swapping the input owner (raw mode released and re-armed in one commit) sends no second version query', versionQueries() === 1, `${versionQueries()} queries`)
  check('raw mode is still on after the swap', stdin.isRaw === true)
  ink.render(React.createElement(Host, { which: 'none' }))
  await settle()
  check('with no input owner raw mode is released', stdin.isRaw === false)
  ink.render(React.createElement(Host, { which: 'a' }))
  await settle()
  check('a later re-arm after a release sends no third version query', versionQueries() === 1, `${versionQueries()} queries`)
  check('raw mode is on again', stdin.isRaw === true)
  const exited = ink.waitUntilExit()
  ink.unmount()
  await exited
}

console.log(`\n${checks} checks, ${failures} failed`)
console.log(failures === 0 ? 'GREEN: a late terminal reply is held to its terminator and typed never' : `RED: ${failures} check(s) let a late reply reach the composer or the keys`)
process.exit(failures === 0 ? 0 : 1)
