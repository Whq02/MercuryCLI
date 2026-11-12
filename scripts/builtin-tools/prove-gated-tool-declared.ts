#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..')
process.chdir(repoRoot)
const scratch = mkdtempSync(join(tmpdir(), 'gated-tool-declared-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
for (const k of ['MERCURY_BLENDER', 'MERCURY_BLENDER_BIN', 'MERCURY_BLENDER_BRIDGE_ADDON_DIR']) delete process.env[k]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const gates = await import('../../src/utils/blender/bridgeGates.js')
const { buildToolCensus, CAPABILITY_UNITS } = await import('../../src/utils/capability/census.ts')
const { validateToolCapability } = await import('../../src/utils/capability/contract.ts')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')

const bare = join(scratch, 'bare')
mkdirSync(bare, { recursive: true })
const pinned = join(scratch, 'pinned-blender')
writeFileSync(pinned, '#!/bin/sh\n')

console.log('── a gated tool the census does not list by default is declared when it is offered ──')
try {
  gates._resetBlenderBridgeContextCacheForTesting()
  await runWithCwdOverride(bare, async () => {
    const off = buildToolCensus()
    check('lane off: the Blender tool is no census row', !off.rows.some(r => r.name === 'Blender'))
    check('lane off: no census row is undeclared', off.rows.every(r => r.declared !== null), off.rows.filter(r => r.declared === null).map(r => r.name).join(', '))
  })

  process.env.MERCURY_BLENDER = '1'
  process.env.MERCURY_BLENDER_BIN = pinned
  gates._resetBlenderBridgeContextCacheForTesting()
  await runWithCwdOverride(bare, async () => {
    check('armed, a Blender located, no .blend file: the catalogue offers the tool', gates.blenderBridgeToolCatalogEnabled() === true)
    const on = buildToolCensus()
    const row = on.rows.find(r => r.name === 'Blender')
    check('…and it is a census row, in the catalogue now', row !== undefined && row.inCatalogNow === true)
    check('…with a declared capability contract', row?.declared != null)
    check('…that is structurally valid', row?.declared != null && validateToolCapability(row.declared).ok, row?.declared != null ? validateToolCapability(row.declared).problems.join(' · ') : 'no declaration')
    check('…of a class: the census does not read it unclassified', !on.summary.unclassified.includes('Blender'), on.summary.unclassified.join(', '))
    const units = row?.declared?.units ?? []
    check('…its units in the closed vocabulary', units.length > 0 && units.every(u => (CAPABILITY_UNITS as readonly string[]).includes(u)), units.join(', '))
    check('…gated on a flag the registry knows', typeof row?.declared?.gate === 'string' && getFlagSpec(row.declared.gate) !== undefined, String(row?.declared?.gate))
    check('…saying what it waits on and where its proofs run', (row?.declared?.conditions ?? []).length > 0 && typeof row?.declared?.proof === 'string')
    check('…so health\'s census row has nothing undeclared', on.rows.every(r => r.declared !== null), on.rows.filter(r => r.declared === null).map(r => r.name).join(', '))
  })
} finally {
  delete process.env.MERCURY_BLENDER
  delete process.env.MERCURY_BLENDER_BIN
  gates._resetBlenderBridgeContextCacheForTesting()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ prove-gated-tool-declared: ALL GREEN' : `\n❌ prove-gated-tool-declared: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
