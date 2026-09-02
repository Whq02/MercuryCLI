#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-qualification-store.ts
//  PROOF: the digest-tied qualification-receipt
//  store.
//
//    1. MINT+PERSIST: a receipt lands at the auth scope keyed
//       (model, role, source); re-minting REPLACES; the file carries no
//       secret material.
//    2. DIGEST TIE: currency requires the CURRENT adapter digest, the
//       CURRENT role-capability digest, and the CURRENT architecture epoch —
//       any drift EXPIRES the receipt with the reason named, never silently.
//    3. LIVE-ONLY MINTING: the runtime records a receipt exactly at the
//       settled-turn seam (source wiring — the latch and the mint share the
//       settlement branch).
//    4. Role digests are distinct per role (a scribe-router receipt can
//       never satisfy another role's check; a RETIRED role's stored receipt
//       digests to the retired marker and expires mechanically).
//
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-qualification-store.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' A8 — qualification-receipt store proof')
console.log('============================================================')

const savedConfig = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CONFIG_DIR = mkdtempSync(joinPath(tmpdir(), 'prove-apex-qual-'))

const {
  recordLiveQualification,
  readQualificationReceipts,
  receiptCurrency,
  roleCapabilityDigest,
  __qualificationFilePathForTest,
} = await import('../../src/services/providers/openai/qualificationStore.js')
const { APEX_ARCHITECTURE_EPOCH, OPENAI_ADAPTER_DIGEST } = await import(
  '../../src/services/providers/openai/openaiCatalogue.js'
)

//
section('1 · mint + persist + replace + no secrets')
//
{
  const first = recordLiveQualification({
    modelId: 'gpt-5.6-sol',
    role: 'primary',
    sourceKind: 'chatgpt-subscription',
    behaviourContractDigest: 'bc1-proof',
    liveEffort: 'low',
    now: () => 1000,
  })
  check('mint returns the persisted receipt', first?.qualifiedAtMs === 1000 && first.adapterDigest === OPENAI_ADAPTER_DIGEST)
  const second = recordLiveQualification({
    modelId: 'gpt-5.6-sol',
    role: 'primary',
    sourceKind: 'chatgpt-subscription',
    liveEffort: 'high',
    now: () => 2000,
  })
  check('re-mint REPLACES the (model, role, source) row', second !== undefined && readQualificationReceipts().length === 1)
  recordLiveQualification({ modelId: 'gpt-5.6-sol', role: 'specialist', sourceKind: 'chatgpt-subscription', now: () => 3000 })
  check('a different role is a separate row', readQualificationReceipts().length === 2)
  const raw = readFileSync(__qualificationFilePathForTest(), 'utf8')
  check('the file carries no token/key material', !/refresh|access_token|Bearer|sk-/.test(raw))
  check('every stored receipt reads CURRENT right after minting', readQualificationReceipts().every(r => r.current))
}

//
section('2 · digest tie — drift expires, with the reason named')
//
{
  const current = readQualificationReceipts()[0]!.receipt
  const staleAdapter = receiptCurrency({ ...current, adapterDigest: 'openai-responses-adapter@0:old' })
  check('adapter digest drift ⇒ expired, reason named', !staleAdapter.current && (staleAdapter as { expiredBy: string }).expiredBy.includes('adapter'))
  const staleEpoch = receiptCurrency({ ...current, architectureEpoch: 'apex-0' })
  check('architecture-epoch drift ⇒ expired', !staleEpoch.current && (staleEpoch as { expiredBy: string }).expiredBy.includes('epoch'))
  const staleRole = receiptCurrency({ ...current, roleCapabilityDigest: 'rc1-dead' })
  check('role-capability drift ⇒ expired naming the role', !staleRole.current && (staleRole as { expiredBy: string }).expiredBy.includes(current.role))
  check('the unmodified receipt stays current', receiptCurrency(current).current)
  check('current epoch is stamped', current.architectureEpoch === APEX_ARCHITECTURE_EPOCH)
}

//
section('3 · live-only minting (source wiring)')
//
{
  const src = readFileSync(
    joinPath(import.meta.dir, '../../src/services/providers/openai/openaiCallModel.ts'),
    'utf8',
  )
  const settleIdx = src.indexOf("openaiLiveProof = { at: Date.now(), model: modelId }")
  const mintIdx = src.indexOf('recordLiveQualification({')
  check('the mint shares the settled-turn branch with the live-proof latch', settleIdx > 0 && mintIdx > settleIdx && mintIdx - settleIdx < 600)
  check('the mint carries the behaviour-contract digest', /behaviourContractDigest: contract\.digest/.test(src))
}

//
section('4 · role digests are distinct')
//
{
  const roles = ['primary', 'scribe-router', 'scribe-implementer', 'specialist', 'coordinator'] as const
  const digests = roles.map(r => roleCapabilityDigest(r))
  check('every role digest is unique', new Set(digests).size === roles.length)
  check('digests are stable across calls', roleCapabilityDigest('primary') === roleCapabilityDigest('primary'))
  check(
    "a RETIRED role id (an old stored receipt's 'party-tank') digests to the retired marker — expires, never crashes",
    roleCapabilityDigest('party-' + 'tank' as never) === 'rc1-retired-role',
  )
}

if (savedConfig === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = savedConfig

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL QUALIFICATION-STORE PROOFS PASS')
else console.log(`${failures} QUALIFICATION-STORE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
