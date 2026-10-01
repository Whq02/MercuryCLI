#!/usr/bin/env bun
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

writeFileSync(userPath, JSON.stringify({ engine: { model: 'from-user' }, environment: { values: { A: 'user', B: 'user' } } }))
writeFileSync(projPath, JSON.stringify({ environment: { values: { B: 'proj' } }, guardrails: { allow: ['Read(x)'] } }))
_resetSettingsSnapshotForTesting()
resetSettingsCache()

console.log('============================================================')
console.log(' Settings snapshot — immutability · revisions · provenance')
console.log('============================================================')

section('(1) snapshot shape, immutability, and stability')
{
  const snap = getSettingsSnapshot()
  check('first snapshot is revision 1', snap.revision === 1, String(snap.revision))
  check('effective settings present', snap.settings.engine?.model === 'from-user')
  let threw = false
  try {
    ;(snap.settings.engine as { model?: string }).model = 'MUTATED'
  } catch {
    threw = true
  }
  check('snapshot is deep-frozen (mutation throws or is inert)', threw || snap.settings.engine?.model === 'from-user')
  const attempt = (fn: () => void): boolean => {
    try {
      fn()
    } catch {
      return true
    }
    return false
  }
  const env = snap.settings.environment?.values as Record<string, string>
  const envThrew = attempt(() => { env.A = 'MUTATED' })
  check('nested object (environment.values.A) is frozen too — deep, not shallow', Object.isFrozen(env) && (envThrew || env.A === 'user'), j(env))
  const envAddThrew = attempt(() => { env.NEW = 'x' })
  check('nested object refuses a NEW key as well', envAddThrew || !('NEW' in env))
  const allow = (snap.settings.guardrails as { allow: string[] }).allow
  const pushThrew = attempt(() => { allow.push('Write(y)') })
  const idxThrew = attempt(() => { allow[0] = 'MUTATED' })
  check('nested array (guardrails.allow) is frozen — push and index write both refused', Object.isFrozen(allow) && (pushThrew || allow.length === 1) && (idxThrew || allow[0] === 'Read(x)'), j(allow))
  const prov = snap.provenance as Record<string, Record<string, unknown>>
  const provThrew = attempt(() => { prov['engine.model']!.winner = 'MUTATED' })
  check('provenance rows are frozen (the recursion reaches them)', Object.isFrozen(prov) && Object.isFrozen(prov['engine.model']) && (provThrew || prov['engine.model']!.winner === 'userSettings'))
  const shallow = Object.freeze({ engine: { model: 'top' }, environment: { values: { A: 'inner' } }, guardrails: { allow: ['Read(x)'] } })
  ;(shallow.environment.values as Record<string, string>).A = 'MUTATED'
  ;(shallow.guardrails.allow as string[]).push('Write(y)')
  check('negative: a SHALLOW freeze leaves the values and allow mutable — the rows above would red on it', !Object.isFrozen(shallow.environment.values) && shallow.environment.values.A === 'MUTATED' && shallow.guardrails.allow.length === 2)
  const again = getSettingsSnapshot()
  check('same underlying state → the SAME snapshot object (cached)', again === snap)
}

section('(2) provenance — winners, contributors, merge detection')
{
  const { provenance } = getSettingsSnapshot()
  check('scalar from one source: winner=user', provenance['engine.model']?.winner === 'userSettings' && provenance['engine.model']?.merged === false, j(provenance['engine.model']))
  check(
    'nested environment value overridden by project: winner=project, both contribute',
    provenance['environment.values.B']?.winner === 'projectSettings' && j(provenance['environment.values.B']?.contributors) === j(['userSettings', 'projectSettings']),
    j(provenance['environment.values.B']),
  )
  check('nested environment value from user only', provenance['environment.values.A']?.winner === 'userSettings', j(provenance['environment.values.A']))
  check('guardrails.allow provenance present', provenance['guardrails.allow']?.winner === 'projectSettings', j(provenance['guardrails.allow']))
}

section('(3) revisions — monotonic, content-keyed')
{
  const r1 = settingsRevision()
  resetSettingsCache()
  const r2 = settingsRevision()
  check('same-content reload keeps the revision', r2 === r1, `${r1} → ${r2}`)

  writeFileSync(userPath, JSON.stringify({ engine: { model: 'changed' }, environment: { values: { A: 'user', B: 'user' } } }))
  resetSettingsCache()
  const r3 = settingsRevision()
  check('changed content advances the revision', r3 === r1 + 1, `${r1} → ${r3}`)
  check('snapshot reflects the change', getSettingsSnapshot().settings.engine?.model === 'changed')

  updateSettingsForSource('userSettings', { engine: { model: 'written-through' } })
  const r4 = settingsRevision()
  check('a settings WRITE advances the revision without a manual reset', r4 === r3 + 1, `${r3} → ${r4}`)
}

section('(4) atomic persistence — no durable temp orphans beside settings')
{
  updateSettingsForSource('userSettings', { environment: { values: { A: 'atomic' } } })
  const leftovers = readdirSync(HOME).filter(f => f.includes('.tmp') || f.includes('durable'))
  check('no temp/orphan files beside settings.json after writes', leftovers.length === 0, j(leftovers))
  check('write landed', getSettingsSnapshot().settings.environment?.values?.A === 'atomic')
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SETTINGS SNAPSHOT CONTRACT GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SNAPSHOT FAILURE(S)`)
process.exit(1)
