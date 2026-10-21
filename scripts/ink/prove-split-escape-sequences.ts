#!/usr/bin/env bun
import {
  INITIAL_STATE,
  type KeyParseState,
  type ParsedInput,
  type ParsedKey,
  parseMultipleKeypresses,
} from '../../src/ink/input/input-decoder.js'
import { openPlainCursorWindow } from '../../src/ink/input/interpreter.js'
import { InputEvent } from '../../src/ink/events/input-event.js'

console.log('============================================================')
console.log(' split escape sequences — the stray `4` law')
console.log(' every reply, report, marker and key Mercury receives, cut at every byte')
console.log(' boundary into two and three reads, with and without the 50 ms flush')
console.log(' between the reads: nothing is typed, the event arrives once. A read')
console.log(' that is a bare ESC alone is the one shape the flush may release as the')
console.log(' Escape key; a lone `[` right behind it is the typed bracket by law.')
console.log('============================================================')

const ESC = '\x1b'
openPlainCursorWindow([4, 24], performance.now() + 60 * 60 * 1000)

type Feed = string | null

type Expect = (atoms: ParsedInput[]) => number

type Event = {
  label: string
  bytes: string
  delivered: Expect
  owns: (atom: ParsedInput) => boolean
}

const isKey = (a: ParsedInput): a is ParsedKey => a.kind === 'key'

const response = (type: string, pick: (r: Record<string, unknown>) => boolean = () => true): Event['owns'] => a =>
  a.kind === 'response' && a.response.type === type && pick(a.response as unknown as Record<string, unknown>)

const keyNamed = (name: string, mods: Partial<Pick<ParsedKey, 'ctrl' | 'shift' | 'meta'>> = {}): Event['owns'] => a =>
  isKey(a) && a.name === name && (mods.ctrl === undefined || a.ctrl === mods.ctrl) && (mods.shift === undefined || a.shift === mods.shift) && (mods.meta === undefined || a.meta === mods.meta)

const keySequence = (sequence: string): Event['owns'] => a => isKey(a) && a.sequence === sequence

const mouse = (button: number, col: number, row: number, action: 'press' | 'release'): Event['owns'] => a =>
  a.kind === 'mouse' && a.button === button && a.col === col && a.row === row && a.action === action

const pasted = (content: string): Event['owns'] => a => isKey(a) && a.isPasted && a.sequence === content

function event(label: string, bytes: string, owns: Event['owns']): Event {
  return { label, bytes, owns, delivered: atoms => atoms.filter(owns).length }
}

const EVENTS: Event[] = [
  event('CPR plain (width probe row 4)', `${ESC}[4;3R`, response('cursorPosition', r => r.row === 4 && r.col === 3)),
  event('CPR plain col 4', `${ESC}[24;4R`, response('cursorPosition', r => r.row === 24 && r.col === 4)),
  event('CPR ?-marked', `${ESC}[?24;4R`, response('cursorPosition', r => r.row === 24 && r.col === 4)),
  event('DA1 Apple Terminal', `${ESC}[?1;2c`, response('da1')),
  event('DA1 iTerm2', `${ESC}[?62;4c`, response('da1')),
  event('DA1 xterm', `${ESC}[?64;1;2;4;6;9;15;18;21;22c`, response('da1')),
  event('DA2', `${ESC}[>1;95;0c`, response('da2')),
  event('DA2 xterm', `${ESC}[>41;354;0c`, response('da2')),
  event('DECRPM 2026 set', `${ESC}[?2026;2$y`, response('decrpm', r => r.mode === 2026)),
  event('DECRPM 2026 permanently reset', `${ESC}[?2026;4$y`, response('decrpm', r => r.mode === 2026 && r.status === 4)),
  event('kitty flags', `${ESC}[?1u`, response('kittyKeyboard')),
  event('kitty flags 4', `${ESC}[?4u`, response('kittyKeyboard', r => r.flags === 4)),
  event('focus in', `${ESC}[I`, keySequence(`${ESC}[I`)),
  event('focus out', `${ESC}[O`, keySequence(`${ESC}[O`)),
  event('bracketed paste', `${ESC}[200~4 stars${ESC}[201~`, pasted('4 stars')),
  event('bracketed paste empty', `${ESC}[200~${ESC}[201~`, pasted('')),
  event('kitty ctrl+a', `${ESC}[97;5u`, keyNamed('a', { ctrl: true })),
  event('kitty shift+enter', `${ESC}[13;2u`, keyNamed('return', { shift: true })),
  event('kitty ctrl+4', `${ESC}[52;5u`, keyNamed('4', { ctrl: true })),
  event('kitty event-typed repeat', `${ESC}[97;5:2u`, keyNamed('a', { ctrl: true })),
  event('modifyOtherKeys ctrl+4', `${ESC}[27;5;52~`, keyNamed('4', { ctrl: true })),
  event('SGR motion', `${ESC}[<35;12;4M`, mouse(35, 12, 4, 'press')),
  event('SGR press', `${ESC}[<0;4;24M`, mouse(0, 4, 24, 'press')),
  event('SGR release', `${ESC}[<0;4;24m`, mouse(0, 4, 24, 'release')),
  event('SGR wheel up', `${ESC}[<64;12;4M`, keyNamed('wheelup')),
  event('SGR wheel down', `${ESC}[<65;140;44M`, keyNamed('wheeldown')),
  event('X10 wheel at col 20 row 20', `${ESC}[M\x6044`, keyNamed('wheelup')),
  event('X10 press', `${ESC}[M\x2044`, keyNamed('mouse')),
  event('X10 motion at col 9 row 20', `${ESC}[MC)4`, keyNamed('mouse')),
  event('ctrl+right', `${ESC}[1;5C`, keyNamed('right', { ctrl: true })),
  event('shift+f3 family (plain CSI 1;2R)', `${ESC}[1;2R`, keySequence(`${ESC}[1;2R`)),
  event('delete', `${ESC}[3~`, keyNamed('delete')),
  event('f12', `${ESC}[24~`, keyNamed('f12')),
  event('up arrow', `${ESC}[A`, keyNamed('up')),
  event('OSC 11 reply (ST)', `${ESC}]11;rgb:1e1e/1e1e/1e1e${ESC}\\`, response('osc', r => r.code === 11)),
  event('OSC 11 reply (BEL)', `${ESC}]11;rgb:4444/4444/4444\x07`, response('osc', r => r.code === 11)),
  event('XTVERSION', `${ESC}P>|iTerm2 3.5.4${ESC}\\`, response('xtversion')),
]

let failures = 0
let checks = 0
const seen = new Map<string, number>()

function fail(label: string, detail: string): void {
  failures++
  const n = (seen.get(label) ?? 0) + 1
  seen.set(label, n)
  if (n <= 3) console.log(`  [FAIL] ${label} — ${detail}`)
}

function drive(feeds: Feed[]): ParsedInput[] {
  let state: KeyParseState = INITIAL_STATE
  const out: ParsedInput[] = []
  for (const feed of feeds) {
    const [atoms, next] = parseMultipleKeypresses(state, feed)
    out.push(...atoms)
    state = next
  }
  return out
}

function leakOf(atom: ParsedInput): string | null {
  if (!isKey(atom)) return `${atom.kind} atom ${JSON.stringify((atom as { sequence?: string }).sequence ?? '')}`
  const ev = new InputEvent(atom)
  if (ev.input !== '') return `typed ${JSON.stringify(ev.input)}`
  if (atom.name) return `key ${JSON.stringify(atom.name)}${atom.ctrl ? '+ctrl' : ''}${atom.meta ? '+meta' : ''}`
  return null
}

function feedsFor(chunks: string[], flushBetween: boolean): Feed[] {
  const feeds: Feed[] = []
  for (const chunk of chunks) {
    feeds.push(chunk)
    if (flushBetween) feeds.push(null)
  }
  if (!flushBetween) feeds.push(null)
  return feeds
}

const ST = ESC + '\\'
const CHORDS = new Set([ESC + ']', ESC + 'P', ESC + '_'])

const sequenceStartsAt = (s: string, k: number): boolean => s.charCodeAt(k) === 0x1b && !(k === s.length - 2 && s.endsWith(ST))

type Shape = { chunks: string[]; flushBetween: boolean; escapes: number; chords: number; skip: string | null }

function shapeOf(s: string, cuts: number[], flushBetween: boolean, pasteBody: [number, number] | null): Shape {
  const chunks: string[] = []
  let prev = 0
  for (const cut of [...cuts, s.length]) {
    chunks.push(s.slice(prev, cut))
    prev = cut
  }
  let escapes = 0
  let chords = 0
  let skip: string | null = null
  if (flushBetween) {
    for (const [n, cut] of cuts.entries()) {
      const chunk = chunks[n]!
      const next = chunks[n + 1]!
      if (chunk === ESC || sequenceStartsAt(s, cut - 1)) {
        escapes++
        if (next.length === 1 && '[]P_'.includes(next)) skip = 'a lone introducer byte behind a released Escape is the typed character by law'
      }
      if (cut >= 2 && sequenceStartsAt(s, cut - 2) && CHORDS.has(chunk.slice(-2))) chords++
      if (pasteBody !== null && cut >= pasteBody[0] && cut <= pasteBody[1]) skip = 'a flush inside an open paste is the paste timeout law, pinned by prove-input-contract'
    }
  }
  return { chunks, flushBetween, escapes, chords, skip }
}

function judge(ev: Event, shape: Shape, expected = 1): void {
  const { chunks, flushBetween } = shape
  const regime = flushBetween ? 'flush between' : 'next read'
  const where = chunks.map(c => c.length).join('+')
  const atoms = drive(feedsFor(chunks, flushBetween))
  checks++
  const count = ev.delivered(atoms)
  if (count !== expected) fail(`${ev.label} · ${regime} · delivered once`, `split ${where}: delivered ${count}× — ${show(atoms)}`)
  checks++
  const leaks: string[] = []
  let escapes = 0
  let chords = 0
  for (const atom of atoms) {
    if (ev.owns(atom)) continue
    if (isKey(atom) && atom.name === 'escape' && atom.sequence === ESC && escapes < shape.escapes) {
      escapes++
      continue
    }
    if (isKey(atom) && !atom.name && CHORDS.has(atom.sequence ?? '') && chords < shape.chords) {
      chords++
      continue
    }
    const leak = leakOf(atom)
    if (leak !== null) leaks.push(leak)
  }
  if (leaks.length > 0) fail(`${ev.label} · ${regime} · nothing typed`, `split ${where}: ${leaks.join(', ')}`)
}

function show(atoms: ParsedInput[]): string {
  return JSON.stringify(atoms.map(a => a.kind === 'key' ? { key: a.name, seq: a.sequence, pasted: a.isPasted || undefined } : a.kind === 'mouse' ? { mouse: [a.button, a.col, a.row, a.action] } : { response: a.response.type }))
}

const skipped = new Map<string, number>()
function judgeEverySplit(ev: Event, pasteBody: [number, number] | null): void {
  const s = ev.bytes
  for (const flushBetween of [false, true]) {
    for (let i = 1; i < s.length; i++) {
      const shapes = [shapeOf(s, [i], flushBetween, pasteBody)]
      for (let j = i + 1; j < s.length; j++) shapes.push(shapeOf(s, [i, j], flushBetween, pasteBody))
      for (const shape of shapes) {
        if (shape.skip !== null) {
          skipped.set(shape.skip, (skipped.get(shape.skip) ?? 0) + 1)
          continue
        }
        judge(ev, shape)
      }
    }
  }
}

const PASTE_OPEN = `${ESC}[200~`.length
for (const ev of EVENTS) {
  const paste = ev.bytes.startsWith(`${ESC}[200~`)
  judgeEverySplit(ev, paste ? [PASTE_OPEN, ev.bytes.length - 1] : null)
}

for (const ev of EVENTS) judge(ev, shapeOf(ev.bytes, [], false, null))

for (const ev of EVENTS) {
  const s = ev.bytes
  if (s.startsWith(`${ESC}[200~`) || s.startsWith(`${ESC}]`) || s.startsWith(`${ESC}P`)) continue
  for (let i = 2; i < s.length; i++) {
    const atoms = drive([s.slice(0, i), null, null, null, s.slice(i), null])
    checks++
    const leaks = atoms.filter(a => !ev.owns(a)).map(leakOf).filter((l): l is string => l !== null)
    const count = ev.delivered(atoms)
    if (leaks.length > 0 || count !== 1) fail(`${ev.label} · let go after the hold window`, `head of ${i}: delivered ${count}×, leaks ${leaks.join(', ') || 'none'} — ${show(atoms)}`)
  }
}

const STREAMS: Array<[string, Event, Event, boolean]> = [
  ['two SGR motions', event('motion 12;4', `${ESC}[<35;12;4M`, mouse(35, 12, 4, 'press')), event('motion 13;4', `${ESC}[<35;13;4M`, mouse(35, 13, 4, 'press')), false],
  ['two X10 motions', event('X10 motion 9;20', `${ESC}[MC)4`, keyNamed('mouse')), event('X10 motion 10;20', `${ESC}[MC*4`, keyNamed('mouse')), true],
  ['CPR behind a motion', event('motion 12;4', `${ESC}[<35;12;4M`, mouse(35, 12, 4, 'press')), event('CPR 24;4', `${ESC}[24;4R`, response('cursorPosition', r => r.row === 24)), false],
  ['DA1 behind a CPR', event('CPR 4;3', `${ESC}[4;3R`, response('cursorPosition', r => r.row === 4)), event('DA1', `${ESC}[?1;2c`, response('da1')), false],
]
for (const [label, first, second, sameShape] of STREAMS) {
  const stream = first.bytes + second.bytes
  const both: Event = {
    label,
    bytes: stream,
    owns: a => first.owns(a) || second.owns(a),
    delivered: atoms =>
      sameShape
        ? (first.delivered(atoms) === 2 ? 1 : 0)
        : (first.delivered(atoms) === 1 && second.delivered(atoms) === 1 ? 1 : 0),
  }
  for (let i = first.bytes.length + 1; i < stream.length; i++) {
    for (const flushBetween of [false, true]) judge(both, shapeOf(stream, [i], flushBetween, null))
  }
}

for (const [why, n] of skipped) console.log(`  (${n} shapes not judged: ${why})`)

const hidden = [...seen.values()].reduce((n, c) => n + Math.max(0, c - 3), 0)
if (hidden > 0) console.log(`  (${hidden} further failing splits of the same labels not listed)`)
console.log(`${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks over ${EVENTS.length} events`)
process.exit(failures === 0 ? 0 : 1)
