#!/usr/bin/env bun
// ============================================================================
//  scripts/health/prove-preflight-estate-gate.ts — the boot preflight rides
//  the path owner's bare-boot law.
//
//  Laws pinned (scratch state roots; the summary itself always returns):
//    · VIRGIN project ⇒ runAndRecordPreflight persists NOTHING — no
//      `.mercury/` is born by a bare boot (the operator's invisible-artifact
//      finding).
//    · ESTABLISHED estate ⇒ the same call persists last-preflight.json into
//      `.mercury/doctor/` as before.
//
//  Run: ~/.bun/bin/bun run scripts/health/prove-preflight-estate-gate.ts
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'pfgate-home-'))
process.env.MERCURY_EVOLUTION_LEDGER = '0'
const virginRoot = mkdtempSync(join(tmpdir(), 'pfgate-virgin-'))
process.env.MERCURY_DOCTOR_STATE_DIR = virginRoot

const repo = join(import.meta.dir, '..', '..')
const { enableConfigs } = await import(`${repo}/src/utils/config/globalConfig.js`)
enableConfigs()
const { runAndRecordPreflight } = await import(`${repo}/src/utils/healthPreflight.js`)

let failures = 0
const check = (cond: boolean, msg: string, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('virgin project — the bare boot creates nothing')
const summary1 = await runAndRecordPreflight()
check(
  typeof summary1.verdict === 'string' && summary1.via === 'preflight',
  'the summary still returns (the boot notice is fed)',
  JSON.stringify({ verdict: summary1.verdict, via: summary1.via }),
)
check(
  !existsSync(join(virginRoot, '.mercury')),
  'no `.mercury/` born on a virgin project',
  readdirSync(virginRoot).join(','),
)
check(readdirSync(virginRoot).length === 0, 'the virgin state root is byte-untouched')

console.log('established estate — the artifact persists as before')
mkdirSync(join(virginRoot, '.mercury'))
const summary2 = await runAndRecordPreflight()
check(typeof summary2.verdict === 'string', 'second run returns a summary')
check(
  existsSync(join(virginRoot, '.mercury', 'doctor', 'last-preflight.json')),
  'last-preflight.json lands inside the established estate',
)

console.log(failures === 0 ? '\nPREFLIGHT GATE HOLDS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
