#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { StylePool, HyperlinkPool } = await import(join(SRC, 'ink/cell-grid.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
type Code = { type: 'ansi'; code: string; endCode: string }
const sgr = (open: number, close: number): Code => ({ type: 'ansi', code: `\x1b[${open}m`, endCode: `\x1b[${close}m` })
const red = sgr(31, 39)
const blue = sgr(44, 49)
const bold = sgr(1, 22)
const underline = sgr(4, 24)
const inverse = sgr(7, 27)
const ends = (pool: InstanceType<typeof StylePool>, id: number) => pool.get(id).map((c: Code) => c.endCode).join(' ')

const pool = new StylePool()
const coloured = pool.intern([red, blue, bold])
const match = pool.withCurrentMatch(coloured)
check('the current-match style drops both colours, adds yellow, inverse and underline, and keeps the base bold once', ends(pool, match) === '\x1b[22m \x1b[39m \x1b[27m \x1b[24m' && pool.get(match)[1].code === '\x1b[33m', ends(pool, match))
check('the current-match derivation is memoised per base', pool.withCurrentMatch(coloured) === match)
const dressed = pool.intern([inverse, underline])
check('a base already inverse and underlined gains only yellow and bold', ends(pool, pool.withCurrentMatch(dressed)) === '\x1b[27m \x1b[24m \x1b[39m \x1b[22m', ends(pool, pool.withCurrentMatch(dressed)))

check('without a selection background the selection style is the inverse of the base', pool.withSelectionBg(coloured) === pool.withInverse(coloured))
const selectionBg = sgr(104, 49)
pool.setSelectionBg(selectionBg)
const selected = pool.withSelectionBg(pool.intern([red, blue, inverse, bold]))
check('with a selection background the base loses its background and inverse and gains the selection background', ends(pool, selected) === '\x1b[39m \x1b[22m \x1b[49m' && pool.get(selected).at(-1)?.code === '\x1b[104m', ends(pool, selected))
check('the selection derivation is memoised per base', pool.withSelectionBg(pool.intern([red, blue, inverse, bold])) === selected)
pool.setSelectionBg({ type: 'ansi', code: '\x1b[104m', endCode: '\x1b[49m' })
check('setting the same selection code again keeps the derived styles', pool.withSelectionBg(pool.intern([red, blue, inverse, bold])) === selected)
pool.setSelectionBg(sgr(105, 49))
const reselected = pool.withSelectionBg(pool.intern([red, blue, inverse, bold]))
check('a new selection code re-derives the selection styles', reselected !== selected && pool.get(reselected).at(-1)?.code === '\x1b[105m')
pool.setSelectionBg(null)
check('clearing the selection background returns to the inverse fallback', pool.withSelectionBg(coloured) === pool.withInverse(coloured))

const a = pool.intern([red])
const b = pool.intern([blue])
check('a transition between equal styles is empty', pool.transition(a, a) === '')
check('a transition is memoised and ordered pairs differ', pool.transition(a, b) === pool.transition(a, b) && pool.transition(a, b) !== pool.transition(b, a) && pool.transition(a, b).length > 0)

const links = new HyperlinkPool()
check('no link is id 0 and reads back as undefined', links.intern(undefined) === 0 && links.intern('') === 0 && links.get(0) === undefined)
const first = links.intern('https://m.example/one')
const second = links.intern('https://m.example/two')
check('new links take dense ids from 1 and read back', first === 1 && second === 2 && links.get(1) === 'https://m.example/one' && links.get(2) === 'https://m.example/two')
check('a known link keeps its id', links.intern('https://m.example/one') === first && links.intern('https://m.example/three') === 3)

console.log(failures ? `FAIL style overlays: ${failures} failures` : 'PASS style overlays')
process.exit(failures ? 1 : 0)
