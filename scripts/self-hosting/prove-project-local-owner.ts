#!/usr/bin/env bun
// ============================================================================
//  scripts/self-hosting/prove-project-local-owner.ts — the `.mercury/`
//  project-local path owner.
//
//  Laws pinned:
//    · ONE OWNER — Apollo's spec home and the doctor artifacts resolve
//      through services/projectLocal/paths.ts (routing equalities).
//    · RESOLUTION IS PURE — deriving every owned path on a virgin project
//      creates nothing on disk.
//    · ESTATE-EXISTS — false on a virgin project; true under either
//      project-config home (`.mercury`).
//
//  Run: ~/.bun/bin/bun run scripts/self-hosting/prove-project-local-owner.ts
// ============================================================================
import { mkdtempSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'plo-home-'))
process.env.MERCURY_EVOLUTION_LEDGER = '0'
// Pin the doctor state root at a scratch project BEFORE the health modules load.
const stateRoot = mkdtempSync(join(tmpdir(), 'plo-state-'))
process.env.MERCURY_DOCTOR_STATE_DIR = stateRoot

const repo = join(import.meta.dir, '..', '..')
const { enableConfigs } = await import(`${repo}/src/utils/config/globalConfig.js`)
enableConfigs()
const owner = await import(`${repo}/src/services/projectLocal/paths.js`)
const { apolloSpecDirectory } = await import(`${repo}/src/prompt/apolloMode.js`)
const { lastCertPath } = await import(`${repo}/src/utils/healthReport.js`)
const { lastPreflightPath } = await import(`${repo}/src/utils/healthPreflight.js`)

let failures = 0
const check = (cond: boolean, msg: string, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('routing: the named sub-estates resolve through the owner')
const root = mkdtempSync(join(tmpdir(), 'plo-root-'))
check(
  apolloSpecDirectory(root) === owner.projectLocalPath(root, 'apollo'),
  'Apollo spec home = projectLocalPath(root, "apollo")',
)
check(
  apolloSpecDirectory(root) === join(root, '.mercury', 'apollo'),
  'and that is `<root>/.mercury/apollo`',
)
check(
  lastCertPath() === join(owner.adoptiveProjectLocalPath(stateRoot, 'doctor'), 'last-cert.json'),
  'doctor last-cert routes through the owner at the pinned state root',
)
check(
  lastPreflightPath() ===
    join(owner.adoptiveProjectLocalPath(stateRoot, 'doctor'), 'last-preflight.json'),
  'doctor last-preflight routes through the owner at the pinned state root',
)
check(
  lastPreflightPath() === join(stateRoot, '.mercury', 'doctor', 'last-preflight.json'),
  'and that is `<state-root>/.mercury/doctor/last-preflight.json`',
)

console.log('resolution is pure — deriving creates nothing')
owner.projectLocalDir(root)
owner.projectLocalPath(root, 'apollo')
owner.adoptiveProjectLocalPath(root, 'doctor')
lastCertPath()
lastPreflightPath()
check(readdirSync(root).length === 0, 'virgin project root untouched after every derivation')
check(readdirSync(stateRoot).length === 0, 'virgin state root untouched after every derivation')

console.log('estate-exists — the bare-boot gate')
check(owner.projectLocalEstateExists(root) === false, 'false on a virgin project')
const withMercury = mkdtempSync(join(tmpdir(), 'plo-m-'))
mkdirSync(join(withMercury, '.mercury'))
check(owner.projectLocalEstateExists(withMercury) === true, 'true under `.mercury/`')
const withExternal = mkdtempSync(join(tmpdir(), 'plo-c-'))
mkdirSync(join(withExternal, '.claude'))
check(owner.projectLocalEstateExists(withExternal) === false, 'false under an external .claude/ dir (never a home)')

console.log(failures === 0 ? '\nOWNER LAWS HOLD' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
