#!/usr/bin/env bun
// ============================================================================
//  scripts/node-runtime/prove-workflow-toolchain.ts — U5: every
//  hosted job that builds/runs/smokes/packages Mercury selects the PRODUCT
//  Node runtime explicitly (the exact calibration pin via node-version-file),
//  prints it for the receipt, and the gate carries the compact real-process
//  qualification (calibration supported + real Node 22 refusal).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const count = (t: string, needle: string): number => t.split(needle).length - 1
/** Third-party actions are pinned to immutable commit SHAs (supply
 *  chain), with the version kept in a trailing comment:
 *  `uses: owner/repo@<40 hex> # v7`. Counting the floating `@v7` spelling would
 *  now count zero — and, worse, would go green again the moment someone
 *  unpinned one. */
const countPinned = (t: string, action: string, tag: string): number =>
  (t.match(new RegExp(`uses: ${action}@[0-9a-f]{40} # ${tag}\\b`, 'g')) ?? []).length
/** Any surviving floating ref: `uses: owner/repo@v7` with no SHA. */
const floatingRefs = (t: string): string[] =>
  (t.match(/uses: [\w.-]+\/[\w.-]+@v[\d.]+\s*$/gm) ?? []).map(m => m.trim())

//
section('gate.yml — build, every shard, darwin')
const gate = readFileSync(join(REPO, '.github/workflows/gate.yml'), 'utf8')
check('setup-node v7 (SHA-pinned) in build + shard + darwin + the Node-22 leg (4 uses)', countPinned(gate, 'actions/setup-node', 'v7') === 4, `${countPinned(gate, 'actions/setup-node', 'v7')}`)
check('every third-party action is pinned to an immutable SHA', floatingRefs(gate).length === 0, floatingRefs(gate).join(', '))
check('bun installs via a pinned action, not a live curl-to-shell', gate.includes('oven-sh/setup-bun@') && !gate.includes('bun.sh/install'))
check('calibration selected via node-version-file (3 job classes)', count(gate, 'node-version-file: .node-version') === 3)
check('the refusal leg pins a REAL Node 22', gate.includes("node-version: '22'"))
check('every job class prints the selected node', count(gate, 'run: node --version') >= 3)
check('qualification: supported + refusal legs both present', gate.includes('qualify-artifact.sh dist/mercury.mjs expect-supported') && gate.includes('qualify-artifact.sh dist/mercury.mjs expect-refusal'))
check('no package-manager caching on setup-node (bun owns installs)', !/setup-node@[0-9a-f]{40} # v7\n(\s+with:\n(\s+.+\n)*?)?\s+cache:/.test(gate))
check('verdict job records its deliberate no-node decision', gate.includes('verdict runs python-only aggregation'))
check('dispatch-only trigger untouched', gate.includes('workflow_dispatch:') && !gate.includes('push:'))

//
section('private-release.yml — verify + every packaging OS')
const rel = readFileSync(join(REPO, '.github/workflows/private-release.yml'), 'utf8')
// 3 uses since UPDATE-RELIABILITY U2: verify + package matrix + bridge-gate
// (the bridge-gate EXECUTES the previous shipped runtime and the candidate
// smoke, so it selects the product pin like every Mercury-running job).
check('setup-node v7 (SHA-pinned) in verify + package + bridge-gate (3 uses)', countPinned(rel, 'actions/setup-node', 'v7') === 3, `${countPinned(rel, 'actions/setup-node', 'v7')}`)
check('every third-party action is pinned to an immutable SHA', floatingRefs(rel).length === 0, floatingRefs(rel).join(', '))
check('all three select the calibration pin via node-version-file', count(rel, 'node-version-file: .node-version') === 3)
check('verify + package print the selected node', count(rel, 'run: node --version') === 2)
// The fallback notes promise the vendored runtime (a release install needs
// only git) and read the supported range from the ONE version root — a
// hand-copied range literal went stale once (24.11.0 against a 24.20.0 floor).
check('release notes say the archive carries its own Node 24 LTS runtime, the range read from package.json engines (no literal)', rel.includes('carries its own Node 24 LTS runtime') && rel.includes('["engines"]["node"]') && !/>=24\.\d+\.\d+ <25/.test(rel))
check('publish job records its deliberate no-node decision', rel.includes('release runs sha256sum + gh only'))
check('no stale Node 20 claim anywhere in the workflow', !rel.includes('Node.js 20'))

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ WORKFLOW TOOLCHAIN PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
