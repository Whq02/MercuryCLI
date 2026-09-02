#!/usr/bin/env bun
// prove-junk-smoke — the junk-bytes acceptance, in-suite scale.
//
//  The spinner/tool-card demo surface runs ~30s on a REAL pty with an
//  Apple-Terminal-class slow drain (throttled reads, probe withheld, no
//  kitty, no 2026), and the capture parses byte-for-byte clean under the
//  strict grammar: every escape complete, zero stray printables, zero
//  disallowed sequences. The 30-minute acceptance recording is the same
//  drive at duration — this smoke keeps the law in the pool.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPLE_PROFILE_RULES, verifyStream } from './strictVtParse.js'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const root = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'engine-junk-smoke-'))
const rec = join(scratch, 'smoke.raw')

console.log('\n' + '─'.repeat(76) + '\njunk-bytes smoke: 30s demo drive on a slow-drain pty')
const res = spawnSync(
  '/usr/bin/python3',
  [
    join(import.meta.dir, 'ptysmoke.py'),
    '--cols', '80',
    '--rows', '24',
    '--timeout', '45',
    '--drain-bps', '12000',
    '--out', rec,
    '--',
    process.execPath,
    'run',
    join(import.meta.dir, 'demo-surface.ts'),
    '--duration-ms', '30000',
  ],
  { cwd: root, encoding: 'utf8', timeout: 90_000 },
)
check('the recorder ran', res.status === 0, `status ${res.status}: ${(res.stderr ?? '').slice(-200)}`)
check('a capture exists', existsSync(rec))

const bytes = readFileSync(rec)
check('the capture has real weight (>40KB)', bytes.length > 40_000, `${bytes.length} bytes`)

const v = verifyStream(bytes, APPLE_PROFILE_RULES)
console.log(
  `  capture: ${bytes.length} bytes · ${v.tokens} tokens · ${v.csi} csi · ${v.textRuns} text runs`,
)
for (const o of v.offenders) console.log(`  ✗ ${o}`)
check('every escape complete (zero malformed)', v.malformed === 0, String(v.malformed))
check('zero mid-stream truncations', v.truncated === 0, String(v.truncated))
check('zero foreign sequences', v.foreign === 0, String(v.foreign))
check('zero stray C0 bytes', v.strayC0 === 0, String(v.strayC0))
check('zero disallowed sequences (no kitty, no alt, no ED, no regions)', v.disallowedCsi === 0, String(v.disallowedCsi))
check('zero stray printables outside the demo alphabet', v.strayPrintables === 0, String(v.strayPrintables))
check('zero 2026 bytes on the Apple profile', v.sync2026 === 0, String(v.sync2026))
check('the spinner actually spun (braille frames present)', bytes.toString('utf8').includes('⠙'))
check('the verdict is CLEAN', v.clean)

console.log(failures === 0 ? '\nALL LAWS HOLD' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
