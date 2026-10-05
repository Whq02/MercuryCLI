import assert from 'node:assert/strict'
import { InputEvent } from '../../src/ink/events/input-event.ts'
import { INITIAL_STATE, parseMultipleKeypresses, type ParsedInput } from '../../src/ink/input/input-decoder.ts'

export function decode(feeds: Array<string | null>): ParsedInput[] {
  let state = { ...INITIAL_STATE }
  const atoms: ParsedInput[] = []
  for (const feed of feeds) {
    const [next, rest] = parseMultipleKeypresses(state, feed)
    state = rest
    atoms.push(...next)
  }
  return atoms
}

export function expectText(label: string, feeds: Array<string | null>, expected: string): void {
  const atoms = decode(feeds)
  const typed = atoms.flatMap(atom => atom.kind === 'key' ? [new InputEvent(atom).input] : []).join('')
  assert.equal(typed, expected, `${label}: typed ${JSON.stringify(typed)}`)
  console.log(`PASS ${label}`)
}
