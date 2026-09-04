#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOME = mkdtempSync(join(tmpdir(), 'pfgate-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_EVOLUTION_LEDGER = '0'
const virginRoot = mkdtempSync(join(tmpdir(), 'pfgate-virgin-'))
process.env.MERCURY_DOCTOR_STATE_DIR = virginRoot

const repo = join(import.meta.dir, '..', '..')
const { enableConfigs } = await import(`${repo}/src/utils/config/globalConfig.js`)
enableConfigs()
const { runAndRecordPreflight, _resetBootPreflightForTesting, lastPreflightPath } = await import(`${repo}/src/utils/healthPreflight.js`)
const { sanitizePath } = await import(`${repo}/src/utils/sessionStoragePortable.js`)

let failures = 0
const check = (cond: boolean, msg: string, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}
const artifact = join(HOME, 'doctor', sanitizePath(virginRoot), 'last-preflight.json')

console.log('virgin project — the bare boot creates nothing in it')
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
check(lastPreflightPath() === artifact, 'the artifact path is the config home doctor store keyed by the state root', lastPreflightPath())
check(existsSync(artifact), 'the summary landed under the config home', artifact)

console.log('once per boot — a second ask in the same boot is the same preflight, and writes nothing')
mkdirSync(join(virginRoot, '.mercury'))
const summaryAgain = await runAndRecordPreflight()
check(summaryAgain === summary1, 'the boot runs ONE preflight (the second ask answers the same summary)')
check(
  !existsSync(join(virginRoot, '.mercury', 'doctor')),
  'the estate born after the preflight gets no late artifact from it',
)
console.log('established estate — the next boot still writes nothing into it')
_resetBootPreflightForTesting()
const summary2 = await runAndRecordPreflight()
check(typeof summary2.verdict === 'string', 'the next boot returns a summary')
check(
  !existsSync(join(virginRoot, '.mercury', 'doctor')) && readdirSync(join(virginRoot, '.mercury')).length === 0,
  'the established estate stays byte-untouched (no doctor/ inside it)',
  readdirSync(join(virginRoot, '.mercury')).join(','),
)
check(existsSync(artifact), 'the artifact still lives under the config home')

console.log(failures === 0 ? '\nPREFLIGHT GATE HOLDS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
