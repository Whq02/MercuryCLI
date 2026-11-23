#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'pfgate-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_EVOLUTION_LEDGER = '0'
const virginRoot = mkdtempSync(join(tmpdir(), 'pfgate-virgin-'))
process.env.MERCURY_HEALTH_STATE_DIR = virginRoot

const repo = join(import.meta.dir, '..', '..')
const { enableConfigs } = await import(`${repo}/src/platform/config/globalConfig.js`)
enableConfigs()
const { runAndRecordPreflight, _resetBootPreflightForTesting, lastPreflightPath } = await import(`${repo}/src/platform/health/healthPreflight.js`)
const { sanitizePath } = await import(`${repo}/src/sessions/transcripts/sessionStoragePortable.js`)

let failures = 0
const check = (cond: boolean, msg: string, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}
const artifact = join(HOME, 'health', sanitizePath(virginRoot), 'last-preflight.json')

console.log('virgin project — the bare boot creates nothing in it')
const summary1 = await runAndRecordPreflight()
check(
  typeof summary1.verdict === 'string' && summary1.via === 'preflight',
  'the summary still returns (the boot notice is fed)',
  JSON.stringify({ verdict: summary1.verdict, via: summary1.via }) + ' (runAndRecordPreflight in src/platform/health/healthPreflight.ts must return the runPreflight summary with via preflight)',
)
check(
  !existsSync(join(virginRoot, '.mercury')),
  'no `.mercury/` born on a virgin project',
  readdirSync(virginRoot).join(',') + ' (the boot preflight must not create folders under the project state root; its only write is publishAtomic of lastPreflightPath in src/platform/health/healthPreflight.ts)',
)
check(readdirSync(virginRoot).length === 0, 'the virgin state root is byte-untouched', readdirSync(virginRoot).join(',') + ' (found in the virgin state root; the boot preflight in src/platform/health/healthPreflight.ts must write only under the config home)')
check(lastPreflightPath() === artifact, 'the artifact path is the config home health store keyed by the state root', lastPreflightPath() + ' (expected ' + artifact + '; fix lastPreflightPath in src/platform/health/healthPreflight.ts)')
check(existsSync(artifact), 'the summary landed under the config home', artifact + ' (missing; runAndRecordPreflight in src/platform/health/healthPreflight.ts must publishAtomic to lastPreflightPath, check logError output for a save failure)')

console.log('once per boot — a second ask in the same boot is the same preflight, and writes nothing')
mkdirSync(join(virginRoot, '.mercury'))
const summaryAgain = await runAndRecordPreflight()
check(summaryAgain === summary1, 'the boot runs ONE preflight (the second ask answers the same summary)', 'runAndRecordPreflight in src/platform/health/healthPreflight.ts must return the cached bootPreflight promise on a second call')
check(
  !existsSync(join(virginRoot, '.mercury', 'health')),
  'the estate born after the preflight gets no late artifact from it',
  'a preflight write landed in the project state root after the first call; runAndRecordPreflight in src/platform/health/healthPreflight.ts must write only to lastPreflightPath under the config home',
)
console.log('established estate — the next boot still writes nothing into it')
_resetBootPreflightForTesting()
const summary2 = await runAndRecordPreflight()
check(typeof summary2.verdict === 'string', 'the next boot returns a summary', 'runAndRecordPreflight in src/platform/health/healthPreflight.ts must return a summary with a string verdict after _resetBootPreflightForTesting')
check(
  !existsSync(join(virginRoot, '.mercury', 'health')) && readdirSync(join(virginRoot, '.mercury')).length === 0,
  'the established estate stays byte-untouched (no health/ inside it)',
  readdirSync(join(virginRoot, '.mercury')).join(',') + ' (the boot preflight in src/platform/health/healthPreflight.ts must not write into an established project estate)',
)
check(existsSync(artifact), 'the artifact still lives under the config home', artifact + ' (missing; runAndRecordPreflight in src/platform/health/healthPreflight.ts must keep its summary at lastPreflightPath)')

console.log(failures === 0 ? '\nPREFLIGHT GATE HOLDS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
