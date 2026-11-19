#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtCli } from '../lib/builtProduct.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
let fail = 0
const ok = (label: string) => console.log(`  ✓ ${label}`)
const bad = (label: string) => {
  console.log(`  ✗ ${label}`)
  fail = 1
}

const pkgVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkgVersion)) ok(`package.json version = ${pkgVersion} (the one root)`)
else bad(`package.json version '${pkgVersion}' is not semver`)
const mv = pkgVersion



const viaFlag = builtCli(['--no-commands', '-V'])
const viaVerb = builtCli(['--no-commands', 'version'])
if (viaFlag.status === 0 && viaFlag.stdout === `Mercury ${mv}\n`)
  ok('main.tsx exitWithVersionLine prints `Mercury ${MERCURY_VERSION}` (the one print behind -V and the version verb)')
else bad('main.tsx exitWithVersionLine must print `Mercury ${MERCURY_VERSION}`')


if (viaFlag.status === 0 && viaVerb.status === 0 && viaFlag.stdout !== '' && viaFlag.stdout === viaVerb.stdout)
  ok('`-V` and the `version` verb both end in exitWithVersionLine (main.tsx)')
else bad('main.tsx `-V` and the `version` verb must both call exitWithVersionLine')


const dist = join(root, 'dist/mercury.mjs')
if (existsSync(dist)) {
  try {
    const out = execFileSync('node', [dist, '--version'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim()
    if (mv && out === `Mercury ${mv}`)
      ok(`BOOTED identity: \`node dist/mercury.mjs --version\` → "${out}"`)
    else bad(`booted --version printed "${out}" — expected "Mercury ${mv}"`)
  } catch (e) {
    bad(`booting dist/mercury.mjs --version failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const out = execFileSync('node', [dist, 'version'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim()
    if (mv && out === `Mercury ${mv}`)
      ok(`BOOTED identity: \`node dist/mercury.mjs version\` → "${out}"`)
    else bad(`booted version printed "${out}" — expected "Mercury ${mv}"`)
  } catch (e) {
    bad(`booting dist/mercury.mjs version failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const out = execFileSync('node', [dist, '-V', 'prove-slow-path'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim()
    if (mv && out === `Mercury ${mv}`)
      ok(`SLOW-PATH booted identity: \`-V <extra-arg>\` (commander option:V → exitWithVersionLine) → "${out}"`)
    else bad(`slow-path -V printed "${out}" — expected "Mercury ${mv}"`)
  } catch (e) {
    bad(`slow-path -V errored: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const out = execFileSync('node', [dist, '--version', 'prove-slow-path'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim()
    if (mv && out === `Mercury ${mv}`)
      ok(`SLOW-PATH booted identity: \`--version <extra-arg>\` (commander) → "${out}"`)
    else bad(`slow-path --version printed "${out}" — expected "Mercury ${mv}"`)
  } catch (e) {
    bad(`slow-path --version errored (the commander flag-spec bug?): ${e instanceof Error ? e.message : String(e)}`)
  }
} else {
  console.log('  – dist/mercury.mjs absent — skipping the booted check (source seams proven above)')
}

console.log(fail === 0 ? '\n✅ version-identity proof PASS' : '\n❌ version-identity proof FAIL')
process.exit(fail)
