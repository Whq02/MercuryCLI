#!/usr/bin/env bun
import { join } from 'node:path'
import {
  CRITTERS,
  SQUARE_DOCK_ART_LINES,
  critterDefForKey,
  squareDockArtFor,
} from '../../src/screen/cockpit/critterData.js'
import { ALL_CRITTERS } from '../../src/screen/widgets/sessionAccent.js'


let fail = 0
const t = (name: string, ok: boolean, detail = '', hint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
  if (!ok) fail = 1
}

const ALL = [...CRITTERS]
const lines = (d: { squareDock: string[] }) => Math.ceil(d.squareDock.length / 2)
t('SQUARE_DOCK_ART_LINES = tallest dock grid (half-block lines)', SQUARE_DOCK_ART_LINES === Math.max(...ALL.map(lines)), `const=${SQUARE_DOCK_ART_LINES} max=${Math.max(...ALL.map(lines))}`, 'SQUARE_DOCK_ART_LINES in src/screen/cockpit/critterData.ts must equal the tallest squareDock grid over CRITTERS, in half-block lines (ceil of rows / 2)')
t('SQUARE_DOCK_ART_LINES positive', SQUARE_DOCK_ART_LINES > 0, '', 'CRITTERS in src/screen/cockpit/critterData.ts is empty or every squareDock grid has no rows, so SQUARE_DOCK_ART_LINES is 0')
t('no grid exceeds the slot', ALL.every(d => lines(d) <= SQUARE_DOCK_ART_LINES), '', 'a squareDock grid in CRITTERS (src/screen/cockpit/critterData.ts) is taller than SQUARE_DOCK_ART_LINES; shorten that grid')

const poolKeys = ALL_CRITTERS.map(c => c.key)
t('pool carries the four morph targets', ['crab', 'octopus', 'jellyfish', 'clam'].every(k => poolKeys.includes(k)), '', 'ALL_CRITTERS in src/screen/widgets/sessionAccent.ts must list crab, octopus, jellyfish and clam')
const grids = poolKeys.map(k => squareDockArtFor(k).join('\n'))
t('every pool key resolves a DISTINCT authored grid', new Set(grids).size === poolKeys.length, '', 'two keys of ALL_CRITTERS (src/screen/widgets/sessionAccent.ts) resolve the same squareDock grid in squareDockArtFor (src/screen/cockpit/critterData.ts); give each critter its own grid')
t('unknown key falls back to the pool default (never blank art)', squareDockArtFor('custom').length > 0, '', 'squareDockArtFor in src/screen/cockpit/critterData.ts must return the pool default grid for an unknown key')


console.log(fail ? '❌ PERSISTENT-HERO RED' : '✅ PERSISTENT-HERO GREEN')
process.exit(fail)
