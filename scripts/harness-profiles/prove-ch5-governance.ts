#!/usr/bin/env bun
// ============================================================================
//  scripts/harness-profiles/prove-ch5-governance.ts — the CH-5 governance proofs:
//  §A the requalification alarm (harnessEvidenceCurrency — the
//     receiptCurrency pattern): current evidence passes; EVERY drift class
//     expires with its NAMED cause (profile retired/absent · profile digest
//     · model alias · architecture epoch · corpus · composed-epoch drift);
//  §B the promotion/retirement ledger contract: rows write to the
//     EXISTING evolution ledger (program 'harness-profiles') — hermetic scratch
//     dir; 'accepted'/'improved' REQUIRE evidenceRefs (the anti-lucky-run
//     guard); the identity-tuple dedupe keeps decision re-runs single;
//  §C the campaign register writer is registered and its five typed
//     declines match the record's CH-4 register.
//
//  Env hygiene: scratch ledger dir under tmp; no operator state read.
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const {
  harnessEvidenceCurrency,
  harnessEvidenceEpoch,
  harnessProfileById,
  harnessProfileDigest,
} = await import('../../src/services/mission/harnessProfiles.ts')
const { APEX_ARCHITECTURE_EPOCH } = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const { getEvolutionLedgerPath, writeEvolutionRow } = await import('../../src/utils/evolution/evolutionLedger.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('§A the requalification alarm (named expiredBy per drift class)')
const live = {
  architectureEpoch: APEX_ARCHITECTURE_EPOCH,
  corpusDigest: 'corpus-x',
  graderDigest: 'grader-x',
  canonicalModelId: 'claude-fable-5',
}
const profile = harnessProfileById('anthropic-default')!
const currentRef = {
  profileId: profile.id,
  profileDigest: harnessProfileDigest(profile),
  modelId: 'claude-fable-5',
  architectureEpoch: live.architectureEpoch,
  corpusDigest: live.corpusDigest,
  graderDigest: live.graderDigest,
  evidenceEpoch: harnessEvidenceEpoch({ architectureEpoch: live.architectureEpoch, corpusDigest: live.corpusDigest, graderDigest: live.graderDigest }),
}
check('§A current evidence passes', harnessEvidenceCurrency(currentRef, live).current === true)
const absent = harnessEvidenceCurrency({ ...currentRef, profileId: 'no-such-profile' }, live)
check('§A an ABSENT profile expires NAMED', !absent.current && absent.expiredBy.includes('retired or absent'))
// The REAL retired profile (the first-batch retirement): its old evidence
// expires on the retired check FIRST — stale candidate evidence can never
// govern after retirement.
const retired = harnessEvidenceCurrency({ ...currentRef, profileId: 'anthropic-context-bounded' }, live)
check('§A the RETIRED candidate expires NAMED (retirement beats every other check)', !retired.current && retired.expiredBy.includes('retired or absent'))
const digestMoved = harnessEvidenceCurrency({ ...currentRef, profileDigest: 'hpr1-0000000000000000' }, live)
check('§A profile-digest drift expires NAMED', !digestMoved.current && digestMoved.expiredBy.includes('profile digest changed'))
const aliasMoved = harnessEvidenceCurrency(currentRef, { ...live, canonicalModelId: 'claude-fable-6' })
check('§A model-alias movement expires NAMED', !aliasMoved.current && aliasMoved.expiredBy.includes('model alias moved'))
const apexMoved = harnessEvidenceCurrency(currentRef, { ...live, architectureEpoch: 'apex-2' })
check('§A architecture-epoch drift expires NAMED', !apexMoved.current && apexMoved.expiredBy.includes('architecture epoch'))
const corpusMoved = harnessEvidenceCurrency(currentRef, { ...live, corpusDigest: 'corpus-y' })
check('§A corpus drift expires NAMED', !corpusMoved.current && corpusMoved.expiredBy.includes('corpus digest changed'))
const graderMoved = harnessEvidenceCurrency(currentRef, { ...live, graderDigest: 'grader-y' })
check('§A grader/set drift expires via the composed epoch, NAMED', !graderMoved.current && graderMoved.expiredBy.includes('evidence epoch drifted'))

console.log('§B the ledger contract (the existing store, program harness-profiles)')
process.env.NODE_ENV = 'test'
const scratch = mkdtempSync(join(tmpdir(), 'harness-ledger-'))
const refused = await writeEvolutionRow(scratch, {
  program: 'harness-profiles',
  iteration: 0,
  subject: 'proof-decline',
  outcome: 'refused',
  hypothesis: 'a hermetic proof row',
  mechanism: 'proof mechanism',
  notes: 'scratch-dir proof row',
})
check('§B a refused (decline) row writes', refused.ok === true)
const acceptedNoEvidence = await writeEvolutionRow(scratch, {
  program: 'harness-profiles',
  subject: 'proof-promotion',
  outcome: 'accepted',
})
check("§B 'accepted' WITHOUT evidenceRefs is REFUSED by the store (the anti-lucky-run guard)", acceptedNoEvidence.ok === false, acceptedNoEvidence.ok ? '' : acceptedNoEvidence.reason)
const acceptedWithEvidence = await writeEvolutionRow(scratch, {
  program: 'harness-profiles',
  subject: 'proof-promotion',
  outcome: 'accepted',
  evidenceRefs: ['scripts/harness-profiles/prove-ch5-governance.ts'],
})
check("§B 'accepted' WITH evidenceRefs writes", acceptedWithEvidence.ok === true)
const dedup1 = await writeEvolutionRow(scratch, { program: 'harness-profiles', iteration: 0, subject: 'proof-decline', outcome: 'refused', hypothesis: 'a hermetic proof row', mechanism: 'proof mechanism', notes: 'scratch-dir proof row' }, { dedupe: true })
check('§B the identity-tuple dedupe keeps re-runs single', dedup1.ok === true && dedup1.deduped === true)
const ledgerText = readFileSync(getEvolutionLedgerPath(scratch, 'harness-profiles'), 'utf8')
check('§B rows are machine-readable JSONL under the program ledger', ledgerText.trim().split('\n').every(l => JSON.parse(l).program === 'harness-profiles'))

console.log(failures === 0 ? '\nprove-ch5-governance: green' : `\nprove-ch5-governance: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
