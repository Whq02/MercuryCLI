#!/usr/bin/env bun

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cfg = mkdtempSync(join(tmpdir(), 'artifacts-cfg-'))
process.env.MERCURY_CONFIG_DIR = cfg

const { storeArtifact, redactMetadata } = await import('../../src/sessions/artifacts/store.js')

let failures = 0
function check(label: string, cond: boolean, detail = '', failHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && failHint ? ' — ' + failHint : ''}`)
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
  check('storeArtifact returned a path', r.id !== null && typeof r.path === 'string', '', 'fix storeArtifact in src/sessions/artifacts/store.ts so it returns an id and a blob path for plain string content')
  if (r.path) {
    const blob = readFileSync(r.path, 'utf8')
    check('the raw secret is NOT in the blob on disk', !blob.includes(SECRET), '', 'storeArtifact in src/sessions/artifacts/store.ts must run the content through redactSecrets before writing the blob')
    check('the secret span is [REDACTED]', blob.includes('[REDACTED]'), '', 'redactSecrets in src/platform/secrets/secretScanner.ts must replace the secret span with the [REDACTED] marker')
    check('surrounding content survives', blob.includes('build output') && blob.includes('done'), '', 'storeArtifact in src/sessions/artifacts/store.ts must redact only the secret span and keep the text around it')
  }
}

section('#9 — metadata value redaction (not just keys)')
{
  const red = redactMetadata({ note: `the token is ${SECRET}`, apiKey: 'should-be-key-redacted' })
  const json = JSON.stringify(red)
  check('a secret VALUE under a benign key ("note") is scrubbed', !json.includes(SECRET), '', 'redactValue in src/sessions/artifacts/store.ts must pass string values under non-sensitive keys through redactSecrets')
  check('the benign key is preserved, value [REDACTED]', json.includes('[REDACTED]'), '', 'redactMetadata in src/sessions/artifacts/store.ts must keep the key and put the [REDACTED] marker in the value')
  check('a SENSITIVE key ("apiKey") is still redacted', !json.includes('should-be-key-redacted'), '', 'SENSITIVE_KEY in src/sessions/artifacts/store.ts must match apiKey so redactMetadata redacts its value')
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
    check('sidecar JSON contains no raw secret', !sidecar.includes(SECRET), '', 'storeArtifact in src/sessions/artifacts/store.ts must write redactMetadata(input.metadata) to the .meta.json sidecar')
  } else {
    check('sidecar written', false, '', 'storeArtifact in src/sessions/artifacts/store.ts returned no path; fix it so a write of small content with metadata succeeds')
  }
}

section('#10 — two adjacent azure secrets: the SECOND no longer leaks')
{
  const { redactSecrets } = await import(
    '../../src/platform/secrets/secretScanner.js'
  )
  const az1 = 'abc1Q~' + 'a'.repeat(33)
  const az2 = 'xyz9Q~' + 'b'.repeat(33)
  const nl = redactSecrets(`${az1}\n${az2}`)
  check('newline-separated: az1 redacted', !nl.includes(az1), '', 'the Azure rule built in buildRules (src/platform/secrets/secretScanner.ts) no longer redacts a lone secret')
  check('newline-separated: az2 redacted (was the leak)', !nl.includes(az2), '', 'the Azure rule built in buildRules (src/platform/secrets/secretScanner.ts) must not consume the separator that the next secret needs')
  const sp = redactSecrets(`${az1} ${az2}`)
  check('space-separated: both redacted', !sp.includes(az1) && !sp.includes(az2), '', 'the Azure rule built in buildRules (src/platform/secrets/secretScanner.ts) must not consume the separator that the next secret needs')
  check('single secret still redacts', !redactSecrets(` ${az1} `).includes(az1), '', 'the Azure rule built in buildRules (src/platform/secrets/secretScanner.ts) must still redact a secret surrounded by spaces')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ARTIFACTS-REDACTION PROOFS PASS')
else console.log(`❌ ${failures} ARTIFACTS-REDACTION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
