#!/usr/bin/env bun
import { INITIAL_STATE, parseMultipleKeypresses, type KeyParseState, type ParsedInput } from '../../src/ink/input/input-decoder.ts'
import { InputEvent } from '../../src/ink/events/input-event.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function typedText(atoms: ParsedInput[]): string[] {
  const out: string[] = []
  for (const atom of atoms) {
    if (atom.kind !== 'key') continue
    const event = new InputEvent(atom)
    if (event.input !== '') out.push(event.input)
  }
  return out
}

function feedAll(chunks: Array<string | null>): { atoms: ParsedInput[]; responses: number } {
  let state: KeyParseState = INITIAL_STATE
  const atoms: ParsedInput[] = []
  for (const chunk of chunks) {
    const [got, next] = parseMultipleKeypresses(state, chunk)
    atoms.push(...got)
    state = next
  }
  return { atoms, responses: atoms.filter(a => a.kind === 'response').length }
}

console.log('============================================================')
console.log(' terminal replies split by the flush timer: what reaches the composer')
console.log(' (a slow link answers CSI c in two reads with the flush between them)')
console.log('============================================================')

const DA1 = '\x1b[?64;1;2;6;9;15;18;21;22c'
const whole = feedAll([DA1])
check('control: the whole DA1 reply in one read is one response atom and no text', whole.responses === 1 && typedText(whole.atoms).length === 0, JSON.stringify(typedText(whole.atoms)))

const split = feedAll(['\x1b[?64;1;2;6;9;15;18;21;', null, '22c'])
const leaked = typedText(split.atoms)
console.log(`  observed after the split: ${split.responses} response atom(s); text that would be typed: ${JSON.stringify(leaked)}`)
check('the split DA1 reply still resolves as a response (no reply is lost)', split.responses === 1)
check('nothing from the split reply is typed into the composer', leaked.length === 0, `typed ${JSON.stringify(leaked)}`)

const DA2 = '\x1b[>0;95;0c'
const splitDa2 = feedAll(['\x1b[>0;95;', null, '0c'])
const leakedDa2 = typedText(splitDa2.atoms)
check('control: the whole DA2 reply is one response atom', feedAll([DA2]).responses === 1)
check('nothing from a split DA2 reply is typed', leakedDa2.length === 0, `typed ${JSON.stringify(leakedDa2)}`)

const OSC11 = '\x1b]11;rgb:1e1e/1e1e/1e1e\x07'
const splitOsc = feedAll(['\x1b]11;rgb:1e1e/', null, '1e1e/1e1e\x07'])
check('a split OSC colour reply types nothing (the sealed tail must not surface as text)', typedText(splitOsc.atoms).length === 0, JSON.stringify(typedText(splitOsc.atoms)))
check('control: the whole OSC colour reply is one response atom', feedAll([OSC11]).responses === 1)

const XTV = '\x1bP>|kitty(0.36.4)\x1b\\'
const splitXtv = feedAll(['\x1bP>|kitty(0.', null, '36.4)\x1b\\'])
check('a split XTVERSION reply types nothing (the sealed tail must not surface as text)', typedText(splitXtv.atoms).length === 0, JSON.stringify(typedText(splitXtv.atoms)))
check('the split OSC and XTVERSION replies resolve as responses (the head rides the seal)', splitOsc.responses === 1 && splitXtv.responses === 1, `osc=${splitOsc.responses} xtversion=${splitXtv.responses}`)
check('control: the whole XTVERSION reply is one response atom', feedAll([XTV]).responses === 1)

console.log('\n the deadline: a head no tail ever follows is let go after two flushes, and the loop hears the keyboard')
const dead = feedAll(['\x1b[?64;1;2;', null, null, 'q'])
const deadTyped = typedText(dead.atoms)
check('a response head with no tail types nothing at the deadline', !deadTyped.some(t => t !== 'q'), `typed ${JSON.stringify(deadTyped)}`)
check('the keystroke after the deadline is heard', deadTyped.includes('q') && dead.atoms.some(a => a.kind === 'key' && a.name === 'q'), JSON.stringify(deadTyped))
const deadDecrpm = feedAll(['\x1b[?2026;1$', null, null])
check('a DECRPM head with its intermediate types nothing at the deadline', typedText(deadDecrpm.atoms).length === 0, JSON.stringify(typedText(deadDecrpm.atoms)))
const heldState = (() => {
  const [, afterHead] = parseMultipleKeypresses(INITIAL_STATE, '\x1b[?64;1;2;')
  const [, afterFlush] = parseMultipleKeypresses(afterHead, null)
  const [, afterSecond] = parseMultipleKeypresses(afterFlush, null)
  return { held: afterFlush.incomplete, released: afterSecond.incomplete }
})()
check('the held head stays in the carry across the first flush (the loop re-arms its timer on it)', heldState.held === '\x1b[?64;1;2;', JSON.stringify(heldState))
check('the second flush lets it go (the carry is empty, the machine is on ground)', heldState.released === '', JSON.stringify(heldState))
const lateTail = feedAll(['\x1b[?64;1;2;', null, '6;9;15;', '22c'])
check('a tail spread over two later reads still completes the reply', lateTail.responses === 1 && typedText(lateTail.atoms).length === 0, JSON.stringify(typedText(lateTail.atoms)))

console.log('\n the string seal: a bare second flush drops the head and keeps the seal; a keystroke then a flush grounds it')
const sealed = feedAll(['\x1b]11;rgb:1e1e/', null, null, 'ab', null, 'ok'])
const sealedTyped = typedText(sealed.atoms)
check('nothing of the sealed head is ever typed', !sealedTyped.some(t => t.includes('rgb') || t.includes(']11')), JSON.stringify(sealedTyped))
check('the loop hears the keyboard again after the seal grounds', sealedTyped.includes('ok'), JSON.stringify(sealedTyped))

console.log('\n keys split at the flush keep their shape')
const splitKey = feedAll(['\x1b[1;', null, '5C', null])
check('a split ctrl+right still force-emits its head silently (the flush-split sink) and the tail is text', splitKey.atoms.length >= 1 && !typedText(splitKey.atoms).some(t => t.startsWith('[')), JSON.stringify(typedText(splitKey.atoms)))
const mouseHead = feedAll(['\x1b[<64;1', null, '0;5M', null])
check('a split SGR mouse head is still dropped and its tail swallowed', typedText(mouseHead.atoms).length === 0 && mouseHead.responses === 0, JSON.stringify(typedText(mouseHead.atoms)))
const loneEsc = feedAll(['\x1b', null])
check('a lone ESC still flushes as one Escape keypress', loneEsc.atoms.length === 1 && loneEsc.atoms[0]!.kind === 'key' && loneEsc.atoms[0]!.name === 'escape')

console.log(failures === 0 ? '\nGREEN: split replies never reach the composer' : `\nRED: ${failures} check(s) show a split reply typed into the composer`)
process.exit(failures === 0 ? 0 : 1)
