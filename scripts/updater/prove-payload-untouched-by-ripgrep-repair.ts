#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyPayloadDir } from '../../src/services/privateChannel/artifactVerify.js'
import { payloadDigestOf } from '../../src/services/privateChannel/installLayout.js'
import {
  buildSignedPayloadWithLinkerSignedRg,
  codesignFlags,
  flipOneByte,
  isLinkerSigned,
  sha256Of,
} from '../lib/signedRipgrepPayload.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail.slice(0, 500)}`}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

if (process.platform !== 'darwin') {
  console.log('prove-payload-untouched-by-ripgrep-repair: SKIPPED — the ad-hoc re-sign exists on macOS only; elsewhere the payload is never written by construction')
  process.exit(0)
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'payload-rg-repair-'))
const HOME = join(SCRATCH, 'home')
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME

const ripgrep = await import('../../src/utils/ripgrep.ts')
const prepareSignedCopy = (ripgrep as { prepareSignedCopy?: (source: string) => Promise<string | null> }).prepareSignedCopy

try {
  section('§1 a signed payload whose vendored rg is linker-signed, as the release archive ships it')
  const fixture = buildSignedPayloadWithLinkerSignedRg(join(SCRATCH, 'payload'))
  check('the fixture rg is linker-signed', isLinkerSigned(fixture.rgPath), codesignFlags(fixture.rgPath))
  const before = verifyPayloadDir(fixture.dir, { depth: 'deep', roster: fixture.roster })
  check('deep verification of the untouched payload reads signed', before.verdict.state === 'signed', JSON.stringify(before.verdict))
  const digestBefore = payloadDigestOf(fixture.dir)

  section('§2 the first search prepares a re-signed copy OUTSIDE the payload and leaves the payload bytes alone')
  check('the product exports the prepared-copy road (prepareSignedCopy)', typeof prepareSignedCopy === 'function')
  const prepared = typeof prepareSignedCopy === 'function' ? await prepareSignedCopy(fixture.rgPath) : null
  check('a prepared path came back', prepared !== null, String(prepared))
  check('the prepared copy lives under the config home, not in the payload', prepared !== null && prepared.startsWith(join(HOME, 'cache', 'ripgrep')) && !prepared.startsWith(fixture.dir), String(prepared))
  check('the prepared copy is keyed by the payload file\'s own digest', prepared !== null && prepared.includes(fixture.rgSha256.slice(0, 16)), String(prepared))
  check('the prepared copy exists and is executable', prepared !== null && existsSync(prepared) && (statSync(prepared).mode & 0o111) !== 0)
  check('the prepared copy carries a full ad-hoc signature, no longer linker-signed', prepared !== null && !isLinkerSigned(prepared) && codesignFlags(prepared).includes('adhoc'), prepared !== null ? codesignFlags(prepared) : '')
  const run = prepared !== null ? spawnSync(prepared, ['--version'], { encoding: 'utf8' }) : null
  check('the prepared copy runs (`rg --version` answers ripgrep)', run !== null && run.status === 0 && run.stdout.startsWith('ripgrep '), run === null ? '' : `${run.status} ${run.stdout.slice(0, 60)} ${run.stderr.slice(0, 120)}`)
  check('the payload\'s own rg bytes are unchanged', sha256Of(fixture.rgPath) === fixture.rgSha256)
  check('…and it is still linker-signed, exactly as shipped', isLinkerSigned(fixture.rgPath), codesignFlags(fixture.rgPath))
  check('the whole-payload digest is unchanged', payloadDigestOf(fixture.dir) === digestBefore)
  const after = verifyPayloadDir(fixture.dir, { depth: 'deep', roster: fixture.roster })
  check('deep verification after the repair still reads signed — a clean install never reads TAMPERED', after.verdict.state === 'signed', JSON.stringify(after.verdict))

  section('§3 a second process reuses the copy instead of signing again')
  const firstMtime = prepared !== null ? statSync(prepared).mtimeMs : 0
  await new Promise(r => setTimeout(r, 20))
  const again = typeof prepareSignedCopy === 'function' ? await prepareSignedCopy(fixture.rgPath) : null
  check('the same path comes back', again === prepared, `${String(again)} vs ${String(prepared)}`)
  check('…without rewriting the copy', prepared !== null && statSync(prepared).mtimeMs === firstMtime)
  check('no staging file is left behind', prepared !== null && !existsSync(join(prepared, '..', `.rg.${process.pid}.tmp`)))

  section('§4 a real change to the payload still reads TAMPERED')
  flipOneByte(fixture.rgPath)
  const tampered = verifyPayloadDir(fixture.dir, { depth: 'deep', roster: fixture.roster })
  check('one flipped byte in the vendored rg: deep verification reads tampered', tampered.verdict.state === 'tampered', JSON.stringify(tampered.verdict))
  check('…naming the payload tree', tampered.verdict.state === 'tampered' && tampered.verdict.note.includes('payload tree differs from the signed digest'), JSON.stringify(tampered.verdict))
  const fast = verifyPayloadDir(fixture.dir, { depth: 'fast', roster: fixture.roster })
  check('the fast depth still reads signed and says the tree is unevaluated (the deep check is where a tree change shows)', fast.verdict.state === 'signed' && fast.unevaluated.some(u => u.includes('whole-payload digest')), JSON.stringify(fast))
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-payload-untouched-by-ripgrep-repair — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-payload-untouched-by-ripgrep-repair — all checks pass')
process.exit(0)
