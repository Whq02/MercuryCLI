#!/usr/bin/env bun
import { join } from 'node:path'
import {
  CRITTERS,
  SQUARE_DOCK_ART_LINES,
  critterDefForKey,
  squareDockArtFor,
} from '../../src/utils/cockpit/critterData.js'
import { ALL_CRITTERS } from '../../src/components/mercury-ui/sessionAccent.js'


let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const ALL = [...CRITTERS]
const lines = (d: { squareDock: string[] }) => Math.ceil(d.squareDock.length / 2)
t('SQUARE_DOCK_ART_LINES = tallest dock grid (half-block lines)', SQUARE_DOCK_ART_LINES === Math.max(...ALL.map(lines)), `const=${SQUARE_DOCK_ART_LINES} max=${Math.max(...ALL.map(lines))} | SQUARE_DOCK_ART_LINES in src/utils/cockpit/critterData.ts must be the largest ceil(squareDock.length / 2) over CRITTERS`)
t('SQUARE_DOCK_ART_LINES positive', SQUARE_DOCK_ART_LINES > 0, 'every CritterDef in src/utils/cockpit/critterData.ts needs a non-empty squareDock grid')
t('no grid exceeds the slot', ALL.every(d => lines(d) <= SQUARE_DOCK_ART_LINES), `a squareDock grid in src/utils/cockpit/critterData.ts is taller than SQUARE_DOCK_ART_LINES; tallest per critter: ${ALL.map(d => `${d.name}=${lines(d)}`).join(' ')}`)

const poolKeys = ALL_CRITTERS.map(c => c.key)
t('pool carries the four morph targets', ['crab', 'octopus', 'jellyfish', 'clam'].every(k => poolKeys.includes(k)), `pool keys: ${poolKeys.join(',')} | ALL_CRITTERS in src/components/mercury-ui/sessionAccent.ts must list crab, octopus, jellyfish and clam`)
const grids = poolKeys.map(k => squareDockArtFor(k).join('\n'))
t('every pool key resolves a DISTINCT authored grid', new Set(grids).size === poolKeys.length, `${new Set(grids).size} distinct grids for ${poolKeys.length} keys | give each pool key its own squareDock grid in src/utils/cockpit/critterData.ts (see squareDockArtFor)`)
t('unknown key falls back to the pool default (never blank art)', squareDockArtFor('custom').length > 0, 'squareDockArtFor in src/utils/cockpit/critterData.ts must fall back to DEFAULT_CRITTER_KEY for a key outside the pool')


console.log(fail ? '❌ PERSISTENT-HERO RED' : '✅ PERSISTENT-HERO GREEN')
process.exit(fail)
