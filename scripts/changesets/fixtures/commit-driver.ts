#!/usr/bin/env bun
// recovery-proof driver: run ONE change-set commit in a child
// process so MERCURY_FAULT_INJECT kill-shapes exercise real process death.
// Spec via argv[2] (json path): { csHome, ownerKey, files: [{path, to}] }.
// Prints the outcome JSON on stdout when it survives.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  csHome: string
  ownerKey: string
  /** `from` (when present) pins the plan's original bytes — a same-plan
   *  re-run after a commit must present the SAME plan digest to replay. */
  files: { path: string; to: string; from?: string }[]
}
process.env.MERCURY_CHANGESET_DIR = spec.csHome

const { runTextChangeSetCommit, commitPlanDigest } = await import(
  '../../../src/services/changeTransaction/changeSetCommit.ts'
)
const { sha256Hex } = await import(
  '../../../src/services/changeTransaction/changeSetPlan.ts'
)

const targets = spec.files.map(f => {
  const originalBytes = f.from !== undefined ? Buffer.from(f.from, 'utf8') : readFileSync(f.path)
  const plannedBytes = Buffer.from(f.to, 'utf8')
  return {
    canonicalPath: f.path,
    originalDigest: sha256Hex(originalBytes),
    plannedDigest: sha256Hex(plannedBytes),
    originalBytes,
    plannedBytes,
    mode: 0o644,
  }
})
const outcome = await runTextChangeSetCommit({
  ownerKey: spec.ownerKey,
  source: 'changeset',
  planDigest: commitPlanDigest(targets),
  targets,
  journalDir: join(spec.csHome, 'journal'),
  bundleRoot: join(spec.csHome, 'bundles'),
})
console.log(JSON.stringify(outcome))
