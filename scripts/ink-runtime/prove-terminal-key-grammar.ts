#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { INITIAL_STATE, parseMultipleKeypresses, type ParsedInput } from '../../src/ink/input/input-decoder.ts'
import { interpretKey } from '../../src/ink/input/interpreter.ts'
import { InputEvent } from '../../src/ink/events/input-event.ts'

type Reading = { name: string | undefined; input: string; delete: boolean; meta: boolean; shift: boolean; option: boolean }

function project(seq: string): Reading {
  const key = interpretKey(seq)
  const event = new InputEvent(key)
  return { name: key.name, input: event.input, delete: event.key.delete, meta: event.key.meta, shift: event.key.shift, option: key.option }
}

const CHILD = process.env.KEY_GRAMMAR_CHILD
if (CHILD !== undefined) {
  const caps = await import('../../src/ink/session/capabilities.ts')
  const out: Record<string, unknown> = {
    term: process.env.TERM,
    sniffArmsPush: caps.supportsExtendedKeys(),
    latch: caps.extendedKeysSupportedNow(),
    csiP: project('\x1b[P'),
    csiPShift: project('\x1b[1;2P'),
    csiDelete: project('\x1b[3~'),
  }
  if (CHILD === 'st-then-reply') {
    caps.upgradeExtendedKeysSupport()
    out.csiPAfterReply = project('\x1b[P')
  }
  console.log(JSON.stringify(out))
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function atomsOf(chunk: string): ParsedInput[] {
  return parseMultipleKeypresses(INITIAL_STATE, chunk)[0]
}

function child(term: string, mode: string): Record<string, any> {
  const env: Record<string, string> = { TERM: term, KEY_GRAMMAR_CHILD: mode }
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === 'PATH' || k === 'HOME' || k === 'TMPDIR' || k === 'BROWSER' || k.startsWith('MERCURY_') || k.startsWith('ANTHROPIC_')) env[k] = v
  }
  const run = spawnSync(process.execPath, [import.meta.path], { env, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`the ${term} child failed: ${run.stderr}`)
  const line = run.stdout.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line)
}

console.log('============================================================')
console.log(' terminal key grammar: st, kitty-protocol function keys, rxvt alt+arrows, WezTerm shifted keys')
console.log('============================================================')

console.log('\n CSI P is two keys in two worlds: st\'s Delete where the protocol is not spoken, the kitty protocol\'s F1 where it is')
const st = child('st-256color', 'st')
console.log(`  observed under TERM=st-256color: ${JSON.stringify(st)}`)
check('under st the identity sniff never arms the kitty push', st.sniffArmsPush === false && st.latch === false, JSON.stringify(st))
check('control: ESC [ 3 ~ is Delete under st', st.csiDelete.delete === true)
check('ESC [ P is Delete under st', st.csiP.name === 'delete' && st.csiP.delete === true && st.csiP.input === '', `reading=${JSON.stringify(st.csiP)} (swallowed: nothing acts)`)
const stReply = child('st-256color', 'st-then-reply')
check('a terminal that answers the kitty probe reads CSI P as F1 from that reply on (the latch, never TERM, decides)', stReply.csiP.name === 'delete' && stReply.csiPAfterReply.name === 'f1', JSON.stringify(stReply))
const kitty = child('xterm-kitty', 'kitty')
console.log(`  observed under TERM=xterm-kitty: ${JSON.stringify(kitty)}`)
check('under kitty the sniff arms the push', kitty.sniffArmsPush === true && kitty.latch === true)
check('ESC [ P is f1 where the kitty push is armed', kitty.csiP.name === 'f1' && kitty.csiP.input === '' && kitty.csiP.delete === false, JSON.stringify(kitty.csiP))
check('ESC [ 1;2 P is shift+f1 where the kitty push is armed', kitty.csiPShift.name === 'f1' && kitty.csiPShift.shift === true, JSON.stringify(kitty.csiPShift))
check('control: ESC [ 3 ~ stays Delete under kitty', kitty.csiDelete.delete === true)

console.log('\n kitty keyboard protocol (Mercury pushes CSI > 5 u): F2 = CSI Q, F3 = CSI 13 ~, F4 = CSI S, in every world')
check('control: SS3 P is f1', project('\x1bOP').name === 'f1')
check('control: CSI 13 ~ is f3', project('\x1b[13~').name === 'f3')
for (const [seq, name] of [['\x1b[Q', 'f2'], ['\x1b[S', 'f4'], ['\x1b[1;5Q', 'f2'], ['\x1b[1;2S', 'f4']] as const) {
  const got = project(seq)
  check(`${JSON.stringify(seq)} is ${name} and types nothing`, got.name === name && got.input === '', `name=${JSON.stringify(got.name)} input=${JSON.stringify(got.input)}`)
}
check('CSI 1;5 Q carries ctrl', interpretKey('\x1b[1;5Q').ctrl === true)

console.log('\n rxvt-unicode: alt+arrow arrives as ESC ESC [ A (the meta prefix), one read')
const control = atomsOf('\x1b[1;3A')
check('control: CSI 1;3 A is one atom, up with meta', control.length === 1 && control[0]!.kind === 'key' && control[0]!.name === 'up' && control[0]!.meta)
const rxvt = atomsOf('\x1b\x1b[A')
const rxvtNames = rxvt.map(a => (a.kind === 'key' ? a.name : a.kind))
console.log(`  observed atoms for ESC ESC [ A: ${JSON.stringify(rxvtNames)}`)
check('ESC ESC [ A is one atom, up with meta (never a bare Escape)', rxvt.length === 1 && rxvt[0]!.kind === 'key' && rxvt[0]!.name === 'up' && (rxvt[0]!.meta || rxvt[0]!.option), `atoms=${JSON.stringify(rxvtNames)}`)
check('no atom of ESC ESC [ A is an Escape keypress', !rxvt.some(a => a.kind === 'key' && a.name === 'escape'), 'an Escape atom interrupts the turn')
check('ESC ESC [ A projects as an alt+up key with no text', (() => { const p = project('\x1b\x1b[A'); return p.meta && p.input === '' && p.name === 'up' })())
const rxvtSs3 = atomsOf('\x1b\x1bOA')
check('ESC ESC O A (application cursor keys) is one alt+up atom too', rxvtSs3.length === 1 && rxvtSs3[0]!.kind === 'key' && rxvtSs3[0]!.name === 'up' && rxvtSs3[0]!.option, JSON.stringify(rxvtSs3.map(a => (a.kind === 'key' ? a.name : a.kind))))
const splitRxvt = (() => {
  let state = INITIAL_STATE
  const out: ParsedInput[] = []
  for (const chunk of ['\x1b\x1b', '[A'] as const) {
    const [got, next] = parseMultipleKeypresses(state, chunk)
    out.push(...got)
    state = next
  }
  return out
})()
check('ESC ESC then [ A in the next read still joins into one alt+up', splitRxvt.length === 1 && splitRxvt[0]!.kind === 'key' && splitRxvt[0]!.name === 'up', JSON.stringify(splitRxvt.map(a => (a.kind === 'key' ? a.name : a.kind))))
const doubleEscape = (() => {
  const [first, state] = parseMultipleKeypresses(INITIAL_STATE, '\x1b\x1b')
  const [flushed] = parseMultipleKeypresses(state, null)
  return [...first, ...flushed]
})()
check('a bare ESC ESC still flushes as two Escape keypresses', doubleEscape.length === 2 && doubleEscape.every(a => a.kind === 'key' && a.name === 'escape' && !a.meta), JSON.stringify(doubleEscape.map(a => (a.kind === 'key' ? a.name : a.kind))))
const escThenLetter = atomsOf('\x1b\x1bx')
check('ESC ESC x is still Escape then alt+x', escThenLetter.length === 2 && escThenLetter[0]!.kind === 'key' && escThenLetter[0]!.name === 'escape' && escThenLetter[1]!.kind === 'key' && escThenLetter[1]!.meta, JSON.stringify(escThenLetter.map(a => (a.kind === 'key' ? a.name : a.kind))))

console.log('\n WezTerm with the kitty protocol on: under flag 4 every shifted key is CSI unshifted:shifted;2 u')
check('control: CSI 58;2 u (the shifted code as primary) types a colon', project('\x1b[58;2u').input === ':')
check('control: plain text colon types a colon', project(':').input === ':')
for (const [seq, want] of [['\x1b[59:58;2u', ':'], ['\x1b[49:33;2u', '!'], ['\x1b[97:65;2u', 'A'], ['\x1b[47:63;2u', '?']] as const) {
  const got = project(seq)
  check(`${JSON.stringify(seq)} types ${JSON.stringify(want)}`, got.input === want && got.shift === true, `types ${JSON.stringify(got.input)}`)
}
check('the layout law holds: a chord keeps the base code (ctrl+ф resolves a, never the shifted glyph)', project('\x1b[1092:1060:97;5u').input === 'a')
check('a shift chord with ctrl keeps the base code (ctrl+shift+; is a ; chord)', project('\x1b[59:58;6u').input === ';')
check('the associated text still names the key when it arrives', project('\x1b[97:65;2;65u').input === 'A')
check('an unshifted alternate-keys report types the primary', project('\x1b[97:65;1u').input === 'a')

console.log(failures === 0 ? '\nGREEN: every named key is decoded' : `\nRED: ${failures} check(s) show keys the grammar swallows, splits or unshifts`)
process.exit(failures === 0 ? 0 : 1)
