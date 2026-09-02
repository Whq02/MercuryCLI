#!/usr/bin/env bun
// ============================================================================
//  scripts/update-reliability/repro-fixture-provenance.ts — UPD-07's
//  expect-red reproducer: the update-journey fixtures must be built THROUGH
//  the packager's own member-role authority, not hand-authored.
//
//  The journey fixture must be structurally the released archive: the same
//  member set, the same manifest shape, the real launcher templates, real
//  archives. ONE shared authority — scripts/release/payloadContract.mjs —
//  consumed by scripts/release/package.mjs AND the updater provers, plus the
//  machine-readable compat floor (scripts/release/compat-floor.json) that
//  names what the archive ships, makes drift impossible by construction.
//
//  While that authority does not exist (or the packager/journey prover do not
//  consume it) this exits 3 (CHECKS_FAILED_EXIT — "still reproduces");
//  scripts/update-reliability/run-all.sh holds it to UPD-07's recorded status.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')

t.section('§1 — one member-role authority exists')
const contractPath = join(ROOT, 'scripts', 'release', 'payloadContract.mjs')
const floorPath = join(ROOT, 'scripts', 'release', 'compat-floor.json')
t.check('scripts/release/payloadContract.mjs exists', existsSync(contractPath))
t.check('scripts/release/compat-floor.json exists (the machine-readable floor owner)', existsSync(floorPath))

let contract: Record<string, unknown> | null = null
if (existsSync(contractPath)) {
  contract = (await import(new URL('../release/payloadContract.mjs', import.meta.url).href).catch(() => null)) as Record<string, unknown> | null
}
t.check('the contract module loads', contract !== null)
t.check(
  'the contract exports the top-member allowlist derivation (topAllowlist)',
  typeof contract?.topAllowlist === 'function',
)
t.check(
  'the contract exports the deterministic whole-payload digest law (payloadDigestOf)',
  typeof contract?.payloadDigestOf === 'function',
)

t.section('§2 — the floor is one explicit edit')
{
  let floor: { floorVersion?: string; forwarder?: string } = {}
  try {
    floor = JSON.parse(readFileSync(floorPath, 'utf8'))
  } catch {
    // absent — the checks below fail loudly
  }
  t.check('the floor is 1.0.0-beta.1', floor.floorVersion === '1.0.0-beta.1', String(floor.floorVersion))
  t.check("the floor's forwarder field reads none", floor.forwarder === 'none', String(floor.forwarder))
  if (contract && typeof contract.topAllowlist === 'function' && typeof contract.memberRole === 'function') {
    const top = (contract.topAllowlist as (target: string, floor: unknown) => string[])('linux-x64', floor)
    const role = contract.memberRole as (name: string) => string
    t.check('floor-derived allowlist carries mercury.mjs', Array.isArray(top) && top.includes('mercury.mjs'))
    t.check('floor-derived allowlist carries exactly one primary-role member', Array.isArray(top) && top.filter(n => role(n) === 'primary').length === 1)
    t.check('every floor-derived member carries a declared role (no unknown member)', Array.isArray(top) && top.every(n => role(n) !== 'unknown'))
  } else {
    t.check('floor-derived allowlist carries mercury.mjs', false, 'no contract module')
    t.check('floor-derived allowlist carries exactly one primary-role member', false, 'no contract module')
    t.check('every floor-derived member carries a declared role (no unknown member)', false, 'no contract module')
  }
}

t.section('§3 — producer and provers consume the ONE authority')
{
  const packager = readFileSync(join(ROOT, 'scripts', 'release', 'package.mjs'), 'utf8')
  t.check('package.mjs imports payloadContract.mjs', packager.includes('payloadContract.mjs'))
  t.check('package.mjs derives its floor from compat-floor.json', packager.includes('compat-floor.json'))
  const journey = readFileSync(join(ROOT, 'scripts', 'updater', 'prove-update-journey.ts'), 'utf8')
  t.check('prove-update-journey.ts builds fixtures through payloadContract.mjs', journey.includes('payloadContract.mjs'))
}

t.finish('repro-fixture-provenance')
