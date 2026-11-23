#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const ca = await import(join(SRC, 'platform/network/caCerts.ts'))
type Outcome = { path: string; loaded: boolean; error?: string } | null
const outcome = ca.getExtraCaCertsOutcome as (() => Outcome) | undefined
const line = ca.extraCaCertsStatusLine as (() => string | null) | undefined

console.log('L1 an unreadable bundle')
{
  const certs = ca.getCACertificates() as string[] | undefined
  check('the certificates still resolve (the bundled roots carry the session)', Array.isArray(certs) && certs.length > 0, 'getCACertificates in src/platform/network/caCerts.ts must fall back to the bundled roots when NODE_EXTRA_CA_CERTS cannot be read')
  const o = outcome?.() ?? null
  check('the outcome names the path and says not loaded', o !== null && o.path === missing && o.loaded === false, `${JSON.stringify(o)}; getExtraCaCertsOutcome in src/platform/network/caCerts.ts must return the path with loaded false`)
  check('…with the errno', /ENOENT/.test(o?.error ?? ''), `${o?.error}; getExtraCaCertsOutcome in src/platform/network/caCerts.ts must carry the read error`)
  const s = line?.() ?? null
  check('the status sentence says NOT READ with the error and the roots in use', s !== null && s.includes(missing) && /NOT READ/.test(s) && /ENOENT/.test(s) && /bundled roots alone/.test(s), `${s ?? '(null)'}; extraCaCertsStatusLine in src/platform/network/caCerts.ts must say NOT READ with the path, the error and bundled roots alone`)
}

console.log('L2 a readable bundle')
{
  const bundle = join(SCRATCH, 'corp-root.pem')
  writeFileSync(bundle, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
  process.env.NODE_EXTRA_CA_CERTS = bundle
  ca.clearCACertsCache()
  const o = outcome?.() ?? null
  check('loaded:true with the path', o !== null && o.loaded === true && o.path === bundle, `${JSON.stringify(o)}; getExtraCaCertsOutcome in src/platform/network/caCerts.ts must report loaded true with the path after clearCACertsCache`)
  check('the sentence is the bare path', line?.() === bundle, `${line?.() ?? '(null)'}; extraCaCertsStatusLine in src/platform/network/caCerts.ts must return the bare path for a readable bundle`)
}

console.log('L3 the cache clear re-resolves')
{
  process.env.NODE_EXTRA_CA_CERTS = missing
  ca.clearCACertsCache()
  check('back to the unreadable path, the outcome follows', outcome?.()?.loaded === false, 'clearCACertsCache in src/platform/network/caCerts.ts must make getExtraCaCertsOutcome read NODE_EXTRA_CA_CERTS again')
  delete process.env.NODE_EXTRA_CA_CERTS
  ca.clearCACertsCache()
  check('with the variable unset there is no outcome to report', outcome?.() === null && line?.() === null, 'with NODE_EXTRA_CA_CERTS unset, getExtraCaCertsOutcome and extraCaCertsStatusLine in src/platform/network/caCerts.ts must return null')
}

console.log('L4 the surfaces (source pins)')
{
  const { authChecks } = await import(join(SRC, 'platform/health/sections/auth.ts'))
  const { getExtraCaCertsOutcome } = await import(join(SRC, 'platform/network/caCerts.ts'))
  const caRow = (await authChecks()).find((row: { id: string }) => row.id === 'extra-ca-certs')
  const unset = await caRow?.run()
  process.env.NODE_EXTRA_CA_CERTS = join(SRC, 'no-such-bundle.pem')
  ca.clearCACertsCache()
  const missing = await caRow?.run()
  const missingOutcome = getExtraCaCertsOutcome()
  delete process.env.NODE_EXTRA_CA_CERTS
  ca.clearCACertsCache()
  check('/health carries the row', unset?.status === 'ok' && unset.evidence.startsWith('NODE_EXTRA_CA_CERTS unset') && missing?.status === 'fail' && missingOutcome !== null && missing.evidence.startsWith(`${missingOutcome.path} could not be read`), `${unset?.evidence} | ${missing?.evidence}; the extra-ca-certs row of authChecks in src/platform/health/sections/auth.ts must report ok when unset and fail with the path and could not be read when the bundle is missing`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-extra-ca-outcome: ALL PASS' : `\nprove-extra-ca-outcome: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
