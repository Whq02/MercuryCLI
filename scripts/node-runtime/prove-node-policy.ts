#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import {
  NODE_SUPPORT,
  evaluateNodeRuntime,
  nodeRefusalMessage,
  nodeRuntimeProjection,
} from '../../src/platform/node-runtime/nodePolicy.js'

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''} — change NODE_SUPPORT, evaluateNodeRuntime, nodeRefusalMessage or nodeRuntimeProjection in src/platform/node-runtime/nodePolicy.ts, or keep package.json engines.node, .node-version, the @types/node spec and bun.lock, and dist/manifest.json (rebuild) in line with NODE_SUPPORT.range`)
  }
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

section('(1) one range, projected — owner ↔ engines ↔ manifest')
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
  engines?: { node?: string }
  devDependencies?: Record<string, string>
}
check('owner range === package.json engines.node', pkg.engines?.node === NODE_SUPPORT.range, `engines=${pkg.engines?.node} owner=${NODE_SUPPORT.range}`)
check('owner range is a valid semver range', semver.validRange(NODE_SUPPORT.range) !== null)
check('owner label names the supported major', NODE_SUPPORT.label === `Node ${NODE_SUPPORT.major} LTS`)
check('owner minimum is the range floor', semver.minVersion(NODE_SUPPORT.range)?.version === NODE_SUPPORT.minimum)
check('range excludes the next major (upper bound is real)', !semver.satisfies(`${NODE_SUPPORT.major + 1}.0.0`, NODE_SUPPORT.range))
const manifestPath = join(REPO, 'dist', 'manifest.json')
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { node?: string }
  check('dist/manifest.json node === owner range', manifest.node === NODE_SUPPORT.range, `manifest=${manifest.node}`)
} else {
  console.log('  [SKIP] dist/manifest.json absent — the pooled gate prebuilds it; build to run this leg')
}

section('(2) the exact calibration pin')
const nodeVersionFile = readFileSync(join(REPO, '.node-version'), 'utf8').trim()
check('.node-version is one exact semver', /^\d+\.\d+\.\d+$/.test(nodeVersionFile), nodeVersionFile)
check('calibration satisfies the supported range', semver.satisfies(nodeVersionFile, NODE_SUPPORT.range), nodeVersionFile)
check('calibration is the supported major', semver.major(nodeVersionFile) === NODE_SUPPORT.major)
check('no competing version-manager pin (.nvmrc/.tool-versions)', !existsSync(join(REPO, '.nvmrc')) && !existsSync(join(REPO, '.tool-versions')))

section('(3) development types on the supported major')
const typesSpec = pkg.devDependencies?.['@types/node'] ?? ''
check('@types/node spec is an intentional major-24 range', /^\^24\./.test(typesSpec), typesSpec)
const lock = readFileSync(join(REPO, 'bun.lock'), 'utf8')
const lockMatch = /"@types\/node": \["@types\/node@(\d+)\.(\d+)\.(\d+)"/.exec(lock)
check('bun.lock resolves @types/node to major 24', lockMatch !== null && lockMatch[1] === '24', lockMatch?.[0] ?? 'no resolution row')

section('(4) the pure decision matrix')
const calibration = nodeVersionFile
const MATRIX: Array<[string | null | undefined, string]> = [
  [undefined, 'invalid'],
  [null, 'invalid'],
  ['', 'invalid'],
  ['garbage', 'invalid'],
  ['24.11', 'invalid'],
  ['024.11.0', 'invalid'],
  ['18.19.1', 'too-old'],
  ['20.19.0', 'too-old'],
  ['22.21.0', 'too-old'],
  ['23.11.1', 'too-old'],
  ['24.0.0', 'too-old'],
  ['24.10.9', 'too-old'],
  ['24.11.0', 'too-old'],
  ['v24.11.0', 'too-old'],
  ['24.18.0', 'too-old'],
  ['24.19.0', 'too-old'],
  ['24.20.0', 'supported'],
  ['v24.20.0', 'supported'],
  [calibration, 'supported'],
  ['24.99.5', 'supported'],
  ['24.11.0-rc.1', 'prerelease'],
  ['24.12.0-nightly20260601abcdef', 'prerelease'],
  ['25.0.0', 'unqualified-major'],
  ['25.0.0-nightly20260601abcdef', 'unqualified-major'],
  ['26.1.0', 'unqualified-major'],
]
for (const [v, expected] of MATRIX) {
  const got = evaluateNodeRuntime(v).verdict
  check(`evaluate(${JSON.stringify(v)}) → ${expected}`, got === expected, `got ${got}`)
}
check('decision is deterministic', evaluateNodeRuntime('24.11.0').verdict === evaluateNodeRuntime('24.11.0').verdict)

const refusal = nodeRefusalMessage(evaluateNodeRuntime('22.21.0'))
check('refusal names the observed version', refusal.includes('22.21.0'))
check('refusal names the label + FULL range', refusal.includes(NODE_SUPPORT.label) && refusal.includes(NODE_SUPPORT.range))
check('refusal gives one action', refusal.includes('install a current Node 24.x'))
check('refusal never claims "Node 24+"', !refusal.includes('24+'))
check('an older major is NOT told the 24-line floor reason (it needs the line, not the patch)', !refusal.includes('nodejs/node#56645'))
const belowFloor = nodeRefusalMessage(evaluateNodeRuntime('24.19.0'))
check('a Node 24 below the floor is told WHY (nodejs/node#56645 + the minimum)', belowFloor.includes('nodejs/node#56645') && belowFloor.includes(NODE_SUPPORT.minimum) && belowFloor.includes('0xC0000409'))
check('…and still gets the one action', belowFloor.includes('install a current Node 24.x'))
const proj = nodeRuntimeProjection(NODE_SUPPORT.minimum)
check('projection carries observed/label/range/verdict', proj.observed === NODE_SUPPORT.minimum && proj.label === NODE_SUPPORT.label && proj.range === NODE_SUPPORT.range && proj.verdict === 'supported')

section('(5) semver agreement over the matrix')
for (const [v] of MATRIX) {
  if (typeof v !== 'string') continue
  const clean = v.startsWith('v') ? v.slice(1) : v
  if (semver.valid(clean) === null) continue
  const ours = evaluateNodeRuntime(v).verdict === 'supported'
  const theirs = semver.satisfies(clean, NODE_SUPPORT.range)
  check(`semver agrees on ${v}`, ours === theirs, `ours=${ours} semver=${theirs}`)
}


console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ NODE POLICY PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
