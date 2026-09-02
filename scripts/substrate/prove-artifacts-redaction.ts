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
  check('storeArtifact returned a path', r.id !== null && typeof r.path === 'string')
  if (r.path) {
    const blob = readFileSync(r.path, 'utf8')
    check('the raw secret is NOT in the blob on disk', !blob.includes(SECRET))
    check('the secret span is [REDACTED]', blob.includes('[REDACTED]'))
    check('surrounding content survives', blob.includes('build output') && blob.includes('done'))
  }
}

section('#9 — metadata value redaction (not just keys)')
{
  const red = redactMetadata({ note: `the token is ${SECRET}`, apiKey: 'should-be-key-redacted' })
  const json = JSON.stringify(red)
  check('a secret VALUE under a benign key ("note") is scrubbed', !json.includes(SECRET))
  check('the benign key is preserved, value [REDACTED]', json.includes('[REDACTED]'))
  check('a SENSITIVE key ("apiKey") is still redacted', !json.includes('should-be-key-redacted'))
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
    check('sidecar JSON contains no raw secret', !sidecar.includes(SECRET))
  } else {
    check('sidecar written', false)
  }
}

section('#11 — distinct project dirs ⇒ distinct artifact scopes')
{
  check('non-injective collision pair now maps to DISTINCT scopes', scopeSlugForDir('/a/b') !== scopeSlugForDir('/a_b'))
  check('two distinct project dirs ⇒ distinct scopes', scopeSlugForDir('/home/u/projA') !== scopeSlugForDir('/home/u/projB'))
  check('same dir ⇒ STABLE scope (writer & reader agree)', scopeSlugForDir('/home/u/proj') === scopeSlugForDir('/home/u/proj'))
  check('scope is still filesystem-safe', /^[A-Za-z0-9._-]+$/.test(scopeSlugForDir('/weird path/with spaces')))
}

section('#10 — two adjacent azure secrets: the SECOND no longer leaks')
{
  const { redactSecrets } = await import(
    '../../src/utils/secrets/secretScanner.js'
  )
  const az1 = 'abc1Q~' + 'a'.repeat(33)
  const az2 = 'xyz9Q~' + 'b'.repeat(33)
  const nl = redactSecrets(`${az1}\n${az2}`)
  check('newline-separated: az1 redacted', !nl.includes(az1))
  check('newline-separated: az2 redacted (was the leak)', !nl.includes(az2))
  const sp = redactSecrets(`${az1} ${az2}`)
  check('space-separated: both redacted', !sp.includes(az1) && !sp.includes(az2))
  check('single secret still redacts', !redactSecrets(` ${az1} `).includes(az1))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ARTIFACTS-REDACTION PROOFS PASS')
else console.log(`❌ ${failures} ARTIFACTS-REDACTION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
