#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-settings-snapshot.ts — the owned snapshot layer
//  (core-ownership Phase 2): immutability, monotonic revisions, per-key
//  provenance, and atomic persistence of settings writes.
//
//  Run:  ~/.bun/bin/bun run scripts/settings/prove-settings-snapshot.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'snapshot-proof-home-'))
const PROJ = mkdtempSync(join(tmpdir(), 'snapshot-proof-proj-'))
process.env.MERCURY_CONFIG_DIR = HOME

const state = await import('../../src/bootstrap/state.ts')
state.setOriginalCwd(PROJ)
state.setAllowedSettingSources([
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
])

const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { getSettingsSnapshot, settingsRevision, _resetSettingsSnapshotForTesting } =
  await import('../../src/utils/settings/snapshot.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const userPath = join(HOME, 'settings.json')
const projDir = join(PROJ, '.mercury')
mkdirSync(projDir, { recursive: true })
const projPath = join(projDir, 'settings.json')

writeFileSync(userPath, JSON.stringify({ model: 'from-user', env: { A: 'user', B: 'user' } }))
writeFileSync(projPath, JSON.stringify({ env: { B: 'proj' }, permissions: { allow: ['Read(x)'] } }))
_resetSettingsSnapshotForTesting()
resetSettingsCache()

console.log('============================================================')
console.log(' Settings snapshot — immutability · revisions · provenance')
console.log('============================================================')

// ---------------------------------------------------------------------------
section('(1) snapshot shape, immutability, and stability')
{
  const snap = getSettingsSnapshot()
  check('first snapshot is revision 1', snap.revision === 1, String(snap.revision))
  check('effective settings present', snap.settings.model === 'from-user')
  let threw = false
  try {
    ;(snap.settings as { model?: string }).model = 'MUTATED'
  } catch {
    threw = true
  }
  check('snapshot is deep-frozen (mutation throws or is inert)', threw || snap.settings.model === 'from-user')
  const again = getSettingsSnapshot()
  check('same underlying state → the SAME snapshot object (cached)', again === snap)
}

// ---------------------------------------------------------------------------
section('(2) provenance — winners, contributors, merge detection')
{
  const { provenance } = getSettingsSnapshot()
  check('scalar from one source: winner=user', provenance['model']?.winner === 'userSettings' && provenance['model']?.merged === false, j(provenance['model']))
  check(
    'nested env key overridden by project: winner=project, both contribute',
    provenance['env.B']?.winner === 'projectSettings' && j(provenance['env.B']?.contributors) === j(['userSettings', 'projectSettings']),
    j(provenance['env.B']),
  )
  check('nested env key from user only', provenance['env.A']?.winner === 'userSettings', j(provenance['env.A']))
  check('permissions.allow provenance present', provenance['permissions.allow']?.winner === 'projectSettings', j(provenance['permissions.allow']))
}

// ---------------------------------------------------------------------------
section('(3) revisions — monotonic, content-keyed')
{
  const r1 = settingsRevision()
  // A reload with UNCHANGED content keeps the revision.
  resetSettingsCache()
  const r2 = settingsRevision()
  check('same-content reload keeps the revision', r2 === r1, `${r1} → ${r2}`)

  // A real change advances it.
  writeFileSync(userPath, JSON.stringify({ model: 'changed', env: { A: 'user', B: 'user' } }))
  resetSettingsCache()
  const r3 = settingsRevision()
  check('changed content advances the revision', r3 === r1 + 1, `${r1} → ${r3}`)
  check('snapshot reflects the change', getSettingsSnapshot().settings.model === 'changed')

  // updateSettingsForSource resets the pipeline cache itself.
  updateSettingsForSource('userSettings', { model: 'written-through' })
  const r4 = settingsRevision()
  check('a settings WRITE advances the revision without a manual reset', r4 === r3 + 1, `${r3} → ${r4}`)
}

// ---------------------------------------------------------------------------
section('(4) atomic persistence — no durable temp orphans beside settings')
{
  updateSettingsForSource('userSettings', { env: { A: 'atomic' } })
  const leftovers = readdirSync(HOME).filter(f => f.includes('.tmp') || f.includes('durable'))
  check('no temp/orphan files beside settings.json after writes', leftovers.length === 0, j(leftovers))
  check('write landed', getSettingsSnapshot().settings.env?.A === 'atomic')
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SETTINGS SNAPSHOT CONTRACT GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SNAPSHOT FAILURE(S)`)
process.exit(1)
