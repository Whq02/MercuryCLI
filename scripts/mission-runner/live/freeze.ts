// ============================================================================
//  scripts/mission-runner/live/freeze.ts — the §12 qualification freeze record.
// ----------------------------------------------------------------------------
//  Frozen BEFORE the qualification matrix runs: Mercury SHA · artifact
//  digest · corpus digest · qualification task ids · model-catalogue
//  snapshot · baseline/candidate policy identities · machine profile ·
//  run/replan limits · the §12.1 graduation rule (predeclared statistics) ·
//  the pairing seed. qualify.sh REFUSES to run without a freeze that
//  matches the live tree.
//
//  CLI: bun freeze.ts --write [--seed N]
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { corpusDigest } from '../corpus/manifest.js'
import { HELIX_TASKS } from '../corpus/tasks.js'
import { HELIX_POLICIES, policyById, policyDigest } from './policies.js'
import { missionPolicyEpoch, missionProfileSetDigest, MISSION_PROFILES, missionProfileDigest } from '../../../src/services/mission/policyProfiles.js'
import { APEX_ARCHITECTURE_EPOCH } from '../../../src/services/providers/openai/openaiCatalogue.js'

const repoRoot = resolve(new URL('../../..', import.meta.url).pathname)
export const FREEZE_PATH = 'docs/benchmarks/mission-runner/qualification-freeze.json'

export function buildFreeze(seed: number): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'dist/manifest.json'), 'utf8')) as Record<string, unknown>
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const qualificationTasks = HELIX_TASKS.filter(t => t.partition === 'qualification').map(t => t.id)
  return {
    frozenAt: new Date().toISOString(),
    mercurySha: head,
    artifactTree: String(manifest.buildTree ?? 'unknown'),
    artifactVersion: String(manifest.version ?? 'unknown'),
    corpusDigest: corpusDigest(),
    qualificationTasks,
    modelCatalogue: {
      anthropicDefault: 'claude-opus-4-8',
      engines: ['gpt-5.6-sol (chatgpt-subscription, receipts required current)'],
      architectureEpoch: APEX_ARCHITECTURE_EPOCH,
      missionPolicyEpoch: missionPolicyEpoch({
        architectureEpoch: APEX_ARCHITECTURE_EPOCH,
        frontierDefaultModel: 'claude-opus-4-8',
      }),
    },
    baselinePolicy: { id: 'solo', digest: policyDigest(policyById('solo')) },
    candidatePolicy: {
      id: 'selected',
      profileSetDigest: missionProfileSetDigest(),
      profiles: MISSION_PROFILES.map(p => ({ id: p.id, digest: missionProfileDigest(p) })),
    },
    armPolicies: HELIX_POLICIES.map(p => ({ id: p.id, digest: policyDigest(p) })),
    machineProfile: {
      host: hostname(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    limits: {
      maxLiveRunsProgramme: 120,
      qualificationRuns: qualificationTasks.length * 2,
      perTaskCeilingSec: 'per corpus manifest',
      infraRetryRule:
        'ONE retry allowed only when the harness failed to launch before any model turn (spawn error, empty stdout, no session) — retried rows are recorded with runIndex>1 and the original row is KEPT',
      replanCeilings: { perNodeAttempts: 3, missionReplanCeiling: 6 },
    },
    graduationRule: 'scripts/mission-runner/live/graduation.ts (§12.1; predeclared statistics in its header)',
    pairingSeed: seed,
  }
}

if (import.meta.main) {
  const seedArg = process.argv.indexOf('--seed')
  const seed = seedArg >= 0 ? Number(process.argv[seedArg + 1]) : 20260721
  const freeze = buildFreeze(seed)
  if (process.argv.includes('--write')) {
    writeFileSync(join(repoRoot, FREEZE_PATH), JSON.stringify(freeze, null, 2) + '\n', 'utf8')
    console.log('froze ' + FREEZE_PATH + ' @ ' + freeze.mercurySha)
  } else {
    console.log(JSON.stringify(freeze, null, 2))
  }
}
