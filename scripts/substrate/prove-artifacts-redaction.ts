#!/usr/bin/env bun

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const SECRET = 'ghp_' + 'a'.repeat(36)

console.log('============================================================')
console.log(' Artifacts store — secret-redaction proof')
console.log('============================================================')

section('#8 — content blob is secret-redacted on write')
{
  const r = await storeArtifact({
    scope: '/tmp/proj',
    name: 'run',
    kind: 'output',
    content: `build output\nleaked: ${SECRET}\ndone`,
  })
  check('storeArtifact returned a path', r.id !== null && typeof r.path === 'string', 'storeArtifact in src/utils/artifacts/store.ts returned no id or path; check why the write failed')
  if (r.path) {
    const blob = readFileSync(r.path, 'utf8')
    check('the raw secret is NOT in the blob on disk', !blob.includes(SECRET), 'storeArtifact in src/utils/artifacts/store.ts must run redactSecrets on content before writing the blob')
    check('the secret span is [REDACTED]', blob.includes('[REDACTED]'), 'storeArtifact in src/utils/artifacts/store.ts must replace the secret span with [REDACTED]')
    check('surrounding content survives', blob.includes('build output') && blob.includes('done'), 'redaction in storeArtifact (src/utils/artifacts/store.ts) must replace only the secret span and keep the rest of the content')
  }
}

section('#9 — metadata value redaction (not just keys)')
{
  const red = redactMetadata({ note: `the token is ${SECRET}`, apiKey: 'should-be-key-redacted' })
  const json = JSON.stringify(red)
  check('a secret VALUE under a benign key ("note") is scrubbed', !json.includes(SECRET), 'redactMetadata in src/utils/artifacts/store.ts must scrub secret values under any key, not only sensitive keys')
  check('the benign key is preserved, value [REDACTED]', json.includes('[REDACTED]'), 'redactMetadata in src/utils/artifacts/store.ts must keep the key and put [REDACTED] in the value')
  check('a SENSITIVE key ("apiKey") is still redacted', !json.includes('should-be-key-redacted'), 'redactMetadata in src/utils/artifacts/store.ts must still redact the value of a sensitive key such as apiKey')
}

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
    check('sidecar JSON contains no raw secret', !sidecar.includes(SECRET), 'storeArtifact in src/utils/artifacts/store.ts must pass metadata through redactMetadata before writing the .meta.json sidecar')
  } else {
    check('sidecar written', false, 'storeArtifact in src/utils/artifacts/store.ts returned no path for the sidecar write')
  }
}

section('#11 — distinct project dirs ⇒ distinct artifact scopes')
{
  check('non-injective collision pair now maps to DISTINCT scopes', scopeSlugForDir('/a/b') !== scopeSlugForDir('/a_b'), 'scopeSlugForDir in src/utils/artifacts/store.ts must map different directories to different slugs')
  check('two distinct project dirs ⇒ distinct scopes', scopeSlugForDir('/home/u/projA') !== scopeSlugForDir('/home/u/projB'), 'scopeSlugForDir in src/utils/artifacts/store.ts must map different directories to different slugs')
  check('same dir ⇒ STABLE scope (writer & reader agree)', scopeSlugForDir('/home/u/proj') === scopeSlugForDir('/home/u/proj'), 'scopeSlugForDir in src/utils/artifacts/store.ts must be deterministic: same directory, same slug')
  check('scope is still filesystem-safe', /^[A-Za-z0-9._-]+$/.test(scopeSlugForDir('/weird path/with spaces')), 'scopeSlugForDir in src/utils/artifacts/store.ts must emit only A-Z a-z 0-9 . _ - characters')
}

section('#10 — two adjacent azure secrets: the SECOND no longer leaks')
{
  const { redactSecrets } = await import(
    '../../src/utils/secrets/secretScanner.js'
  )
  const az1 = 'abc1Q~' + 'a'.repeat(33)
  const az2 = 'xyz9Q~' + 'b'.repeat(33)
  const nl = redactSecrets(`${az1}\n${az2}`)
  check('newline-separated: az1 redacted', !nl.includes(az1), 'redactSecrets in src/utils/secrets/secretScanner.ts must redact the first Azure secret')
  check('newline-separated: az2 redacted (was the leak)', !nl.includes(az2), 'redactSecrets in src/utils/secrets/secretScanner.ts must redact a second adjacent Azure secret; check how its pattern consumes the separator')
  const sp = redactSecrets(`${az1} ${az2}`)
  check('space-separated: both redacted', !sp.includes(az1) && !sp.includes(az2), 'redactSecrets in src/utils/secrets/secretScanner.ts must redact both space-separated Azure secrets')
  check('single secret still redacts', !redactSecrets(` ${az1} `).includes(az1), 'redactSecrets in src/utils/secrets/secretScanner.ts must redact a single Azure secret surrounded by spaces')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ARTIFACTS-REDACTION PROOFS PASS')
else console.log(`❌ ${failures} ARTIFACTS-REDACTION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
