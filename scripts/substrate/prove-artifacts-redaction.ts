#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-artifacts-redaction.ts
//  PROOF: the artifacts store (now LIVE-by-default in the daemon) does NOT
//  persist secrets to disk. Regression for the autonomy review:
//   #8 (HIGH) — the CONTENT blob is secret-redacted before hashing/writing
//      (a raw blob makes the "secret-redacted" invariant false).
//   #9 (MED)  — metadata VALUES (not just keys) are scrubbed, so a secret under
//      a non-sensitive key doesn't persist verbatim in the .meta.json sidecar.
//  Exercised against the REAL storeArtifact / redactMetadata.
// ============================================================================

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the config home at a temp dir BEFORE importing the store (getMercuryHome
// is memoized + read lazily at first storeArtifact call).
const cfg = mkdtempSync(join(tmpdir(), 'artifacts-cfg-'))
process.env.MERCURY_CONFIG_DIR = cfg

const { storeArtifact, redactMetadata, scopeSlugForDir } = await import('../../src/utils/artifacts/store.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const SECRET = 'ghp_' + 'a'.repeat(36) // a github-token-shaped secret redactSecrets catches

console.log('============================================================')
console.log(' Artifacts store — secret-redaction proof')
console.log('============================================================')

// ── #8 — the content BLOB is redacted before it lands on disk ─────────────────
section('#8 — content blob is secret-redacted on write')
{
  const r = await storeArtifact({
    scope: '/tmp/proj',
    name: 'run',
    kind: 'output',
    content: `build output\nleaked: ${SECRET}\ndone`,
  })
  check('storeArtifact returned a path', r.id !== null && typeof r.path === 'string')
  if (r.path) {
    const blob = readFileSync(r.path, 'utf8')
    check('the raw secret is NOT in the blob on disk', !blob.includes(SECRET))
    check('the secret span is [REDACTED]', blob.includes('[REDACTED]'))
    check('surrounding content survives', blob.includes('build output') && blob.includes('done'))
  }
}

// ── #9 — metadata VALUES (under non-sensitive keys) are scrubbed ──────────────
section('#9 — metadata value redaction (not just keys)')
{
  const red = redactMetadata({ note: `the token is ${SECRET}`, apiKey: 'should-be-key-redacted' })
  const json = JSON.stringify(red)
  check('a secret VALUE under a benign key ("note") is scrubbed', !json.includes(SECRET))
  check('the benign key is preserved, value [REDACTED]', json.includes('[REDACTED]'))
  check('a SENSITIVE key ("apiKey") is still redacted', !json.includes('should-be-key-redacted'))
}

// ── end-to-end: the .meta.json sidecar on disk carries no secret ──────────────
section('end-to-end: sidecar on disk has no secret value')
{
  const r = await storeArtifact({
    scope: '/tmp/proj',
    name: 'run2',
    kind: 'output',
    content: 'ok',
    metadata: { detail: `connect with ${SECRET}` },
  })
  if (r.path) {
    const sidecar = readFileSync(r.path + '.meta.json', 'utf8')
    check('sidecar JSON contains no raw secret', !sidecar.includes(SECRET))
  } else {
    check('sidecar written', false)
  }
}

// ── #11 — scope is collision-resistant (no cross-project artifact leak) ───────
section('#11 — distinct project dirs ⇒ distinct artifact scopes')
{
  // slug() alone is not injective — "/a/b" and "/a_b" both collapse to "a_b".
  check('non-injective collision pair now maps to DISTINCT scopes', scopeSlugForDir('/a/b') !== scopeSlugForDir('/a_b'))
  check('two distinct project dirs ⇒ distinct scopes', scopeSlugForDir('/home/u/projA') !== scopeSlugForDir('/home/u/projB'))
  check('same dir ⇒ STABLE scope (writer & reader agree)', scopeSlugForDir('/home/u/proj') === scopeSlugForDir('/home/u/proj'))
  check('scope is still filesystem-safe', /^[A-Za-z0-9._-]+$/.test(scopeSlugForDir('/weird path/with spaces')))
}

// ── audit-r1 #10 — adjacent azure secrets both redact (shared delimiter) ──────
section('#10 — two adjacent azure secrets: the SECOND no longer leaks')
{
  const { redactSecrets } = await import(
    '../../src/utils/secrets/secretScanner.js'
  )
  const az1 = 'abc1Q~' + 'a'.repeat(33)
  const az2 = 'xyz9Q~' + 'b'.repeat(33)
  // The azure rule's boundary was CONSUMING: redacting #1 ate the single delimiter
  // that #2 needs as its leading boundary, so #2 leaked verbatim. Zero-width
  // lookaround leaves the delimiter in place.
  const nl = redactSecrets(`${az1}\n${az2}`)
  check('newline-separated: az1 redacted', !nl.includes(az1))
  check('newline-separated: az2 redacted (was the leak)', !nl.includes(az2))
  const sp = redactSecrets(`${az1} ${az2}`)
  check('space-separated: both redacted', !sp.includes(az1) && !sp.includes(az2))
  // a single secret with a valid trailing boundary still redacts (no regression)
  check('single secret still redacts', !redactSecrets(` ${az1} `).includes(az1))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ARTIFACTS-REDACTION PROOFS PASS')
else console.log(`❌ ${failures} ARTIFACTS-REDACTION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
