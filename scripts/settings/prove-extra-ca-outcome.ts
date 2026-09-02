#!/usr/bin/env bun
// ============================================================================
//  prove-extra-ca-outcome — an unreadable extra-CA bundle is reported as
//  unread wherever the variable is reported (release-hardening audit
//  rank 73).
//
//  The gap: NODE_EXTRA_CA_CERTS pointing at a path that could not be read
//  (moved, renamed, an offline share) fell back to the bundled roots alone
//  with only a debug line; node's own "ignoring extra certs" warning was
//  routed away from the operator; /status printed "Additional CA cert(s):
//  <path>" from the raw variable; and the TLS failure advice told them to
//  set NODE_EXTRA_CA_CERTS — which they had. The memo made it sticky.
//
//    L1 an unreadable bundle: the certificates still resolve (the bundled
//       roots), the outcome records the path, loaded:false and the error,
//       and the status sentence says NOT READ with the error
//    L2 a readable bundle: loaded:true, the sentence is the bare path
//    L3 the cache clear re-resolves (a fixed path reads on the next look)
//    L4 /status reads the sentence, the doctor carries the row (source pins)
//
//  PROVE_SRC names another checkout's src (the A/B control: L1, L2 and L4
//  read red at the pre-fix tree — no outcome).
// ============================================================================
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const SCRATCH = mkdtempSync(join(tmpdir(), 'extra-ca-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const missing = join(SCRATCH, 'moved-away.pem')
process.env.NODE_EXTRA_CA_CERTS = missing
const ca = await import(join(SRC, 'utils/caCerts.ts'))
type Outcome = { path: string; loaded: boolean; error?: string } | null
const outcome = ca.getExtraCaCertsOutcome as (() => Outcome) | undefined
const line = ca.extraCaCertsStatusLine as (() => string | null) | undefined

console.log('L1 an unreadable bundle')
{
  const certs = ca.getCACertificates() as string[] | undefined
  check('the certificates still resolve (the bundled roots carry the session)', Array.isArray(certs) && certs.length > 0)
  const o = outcome?.() ?? null
  check('the outcome names the path and says not loaded', o !== null && o.path === missing && o.loaded === false, JSON.stringify(o))
  check('…with the errno', /ENOENT/.test(o?.error ?? ''), o?.error)
  const s = line?.() ?? null
  check('the status sentence says NOT READ with the error and the roots in use', s !== null && s.includes(missing) && /NOT READ/.test(s) && /ENOENT/.test(s) && /bundled roots alone/.test(s), s ?? '(null)')
}

console.log('L2 a readable bundle')
{
  const bundle = join(SCRATCH, 'corp-root.pem')
  writeFileSync(bundle, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
  process.env.NODE_EXTRA_CA_CERTS = bundle
  ca.clearCACertsCache()
  const o = outcome?.() ?? null
  check('loaded:true with the path', o !== null && o.loaded === true && o.path === bundle, JSON.stringify(o))
  check('the sentence is the bare path', line?.() === bundle, line?.() ?? '(null)')
}

console.log('L3 the cache clear re-resolves')
{
  process.env.NODE_EXTRA_CA_CERTS = missing
  ca.clearCACertsCache()
  check('back to the unreadable path, the outcome follows', outcome?.()?.loaded === false)
  delete process.env.NODE_EXTRA_CA_CERTS
  ca.clearCACertsCache()
  check('with the variable unset there is no outcome to report', outcome?.() === null && line?.() === null)
}

console.log('L4 the surfaces (source pins)')
{
  const status = readFileSync(join(SRC, 'utils/status.tsx'), 'utf8')
  check('/status paints the outcome sentence', status.includes('extraCaCertsStatusLine()'))
  const health = readFileSync(join(SRC, 'utils/healthReport.ts'), 'utf8')
  check('the doctor carries the row', health.includes("id: 'extra-ca-certs'") && health.includes('extraCaCertsCheck()'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-extra-ca-outcome: ALL PASS' : `\nprove-extra-ca-outcome: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
