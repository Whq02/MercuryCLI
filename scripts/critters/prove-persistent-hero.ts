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
t('SQUARE_DOCK_ART_LINES = tallest dock grid (half-block lines)', SQUARE_DOCK_ART_LINES === Math.max(...ALL.map(lines)), `const=${SQUARE_DOCK_ART_LINES} max=${Math.max(...ALL.map(lines))}`)
t('SQUARE_DOCK_ART_LINES positive', SQUARE_DOCK_ART_LINES > 0)
t('no grid exceeds the slot', ALL.every(d => lines(d) <= SQUARE_DOCK_ART_LINES))

const poolKeys = ALL_CRITTERS.map(c => c.key)
t('pool carries the four morph targets', ['crab', 'octopus', 'jellyfish', 'clam'].every(k => poolKeys.includes(k)))
const grids = poolKeys.map(k => squareDockArtFor(k).join('\n'))
t('every pool key resolves a DISTINCT authored grid', new Set(grids).size === poolKeys.length)
t('unknown key falls back to the pool default (never blank art)', squareDockArtFor('custom').length > 0)


console.log(fail ? '❌ PERSISTENT-HERO RED' : '✅ PERSISTENT-HERO GREEN')
process.exit(fail)
