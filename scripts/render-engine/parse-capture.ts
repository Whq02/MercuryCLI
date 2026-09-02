#!/usr/bin/env bun
// parse-capture — the junk-bytes verdict over one .rec capture.
//
//   bun scripts/render-engine/parse-capture.ts <capture.rec> [--allow-2026]
//
// Exit 0 = byte-for-byte clean under the Apple-profile strict rules; every
// escape complete, zero stray printables (sheet bug #2's acceptance form).

import { readFileSync } from 'node:fs'
import { APPLE_PROFILE_RULES, readCapture, verifyStream } from './strictVtParse.js'

const path = process.argv[2]
if (!path) {
  console.error('usage: parse-capture.ts <capture.rec> [--allow-2026]')
  process.exit(2)
}
const rules = { ...APPLE_PROFILE_RULES, allow2026: process.argv.includes('--allow-2026') }
const cap = readCapture(readFileSync(path))
const v = verifyStream(cap.out, rules)

console.log(`capture: ${path}`)
console.log(
  `  frames ${cap.frames} (out ${cap.outFrames}) · ${(Number(cap.durationNs) / 1e9 / 60).toFixed(1)} min · ${v.totalBytes} bytes`,
)
console.log(
  `  tokens ${v.tokens} · text runs ${v.textRuns} · csi ${v.csi} · 2026 ${v.sync2026}`,
)
console.log(
  `  malformed ${v.malformed} · truncated ${v.truncated} · foreign ${v.foreign} · strayC0 ${v.strayC0} · disallowedCSI ${v.disallowedCsi} · strayPrintables ${v.strayPrintables}`,
)
for (const o of v.offenders) console.log(`  ✗ ${o}`)
console.log(v.clean ? '  VERDICT: CLEAN' : '  VERDICT: JUNK FOUND')
process.exit(v.clean ? 0 : 1)
