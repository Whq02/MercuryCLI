#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'
import { declaredToolchain } from '../gate/ledger.ts'

const t = checker()

t.section('declaredToolchain(HEAD) names the real pins')
{
  const tc = declaredToolchain('HEAD')

  const nodePin = readFileSync('.node-version', 'utf8').trim()
  const gate = readFileSync('.github/workflows/gate.yml', 'utf8')
  const bunLines = gate
    .split('\n')
    .filter(l => /^\s*bun-version:\s*\S+/.test(l))
    .map(l => l.replace(/^\s*bun-version:\s*/, '').trim())

  t.check('gate.yml declares at least one bun-version pin', bunLines.length > 0, `${bunLines.length} found`)
  const uniquePins = [...new Set(bunLines)]
  t.check('every setup-bun step pins the SAME version', uniquePins.length === 1, uniquePins.join(', '))

  t.check('node is resolved (not unknown)', tc.node !== 'unknown', tc.node)
  t.check('node matches .node-version', tc.node === nodePin, `${tc.node} vs ${nodePin}`)
  t.check('bun is resolved (not unknown)', tc.bun !== 'unknown', tc.bun)
  t.check('bun matches the setup-bun pin', tc.bun === uniquePins[0], `${tc.bun} vs ${uniquePins[0]}`)
}

t.finish('prove-gate-toolchain-pin')
