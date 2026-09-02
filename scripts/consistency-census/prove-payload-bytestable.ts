#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/prove-payload-bytestable.ts — W7-E (UN-52/53/54):
//  managed payloads stay byte-stable through python execution.
//
//  §A the REAL resolver probe against a temp payload copy leaves ZERO new
//     files beneath the payload — bytecode lands in Mercury's build-keyed
//     runtime cache instead (bounded, outside version roots/projects/lanes).
//  §B both spawn sites ride the ONE byte-stability env owner
//     (pythonSpawnEnv — structural pin on the probe + dapClient).
//  §C the no-bytecode fallback: when the cache root is unavailable the env
//     carries PYTHONDONTWRITEBYTECODE, never a bare inherited env.
//  §D concurrent probes agree on one cache root (same build key ⇒ same
//     prefix — the bounded-cache law's local leg; the three-platform leg
//     rides the close lanes per UN-53).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const walk = (d: string): string[] => {
  const out: string[] = []
  const rec = (p: string): void => {
    for (const name of readdirSync(p)) {
      const full = join(p, name)
      if (statSync(full).isDirectory()) rec(full)
      else out.push(full)
    }
  }
  rec(d)
  return out.sort()
}

// §A — the temp payload copy through the REAL resolver
const payload = mkdtempSync(join(tmpdir(), 'unison-w7e-payload-'))
const vendorRoot = join(payload, 'vendor', 'debugpy')
mkdirSync(join(vendorRoot, 'debugpy', 'adapter'), { recursive: true })
mkdirSync(join(vendorRoot, 'debugpy', '_vendored'), { recursive: true })
writeFileSync(join(vendorRoot, 'debugpy', '__init__.py'), '__version__ = "0.0-fixture"\n')
writeFileSync(join(vendorRoot, 'debugpy', '_vendored', '__init__.py'), '')
writeFileSync(join(vendorRoot, 'debugpy', '_vendored', 'force_pydevd.py'), '')
writeFileSync(join(vendorRoot, 'debugpy', 'adapter', '__main__.py'), '')
const before = walk(payload)

process.env.MERCURY_DEBUGPY_VENDOR_DIR = vendorRoot
const resolver = await import('../../src/services/dap/debugpyResolver.ts')
resolver._resetDebugpyResolverForTesting()
const resolution = resolver.resolvePythonDebugAdapter()
check('§A probe resolves green against the vendored copy', resolution.state === 'ok', resolution.state === 'ok' ? '' : resolution.reason)
const after = walk(payload)
check('§A the payload is BYTE-STABLE through the probe (zero files added)', JSON.stringify(after) === JSON.stringify(before), `${after.length - before.length} new file(s)`)

// §A2 — the bytecode went to the build-keyed runtime cache
const env = resolver.pythonSpawnEnv()
const prefix = env.PYTHONPYCACHEPREFIX
check('§A2 the spawn env carries the cache prefix (or the suppression fallback)', typeof prefix === 'string' || env.PYTHONDONTWRITEBYTECODE === '1')
if (typeof prefix === 'string') {
  check('§A2 the cache root lives under the mercury cache home, not the payload', prefix.includes('pycache') && !prefix.startsWith(payload))
}

// §B — one env owner at both spawn sites (structural)
const ROOT = join(import.meta.dir, '..', '..')
const resolverSrc = readFileSync(join(ROOT, 'src/services/dap/debugpyResolver.ts'), 'utf8')
const clientSrc = readFileSync(join(ROOT, 'src/services/dap/dapClient.ts'), 'utf8')
check('§B the probe spawns with pythonSpawnEnv()', resolverSrc.includes('env: pythonSpawnEnv()'))
check('§B the adapter launch spawns with pythonSpawnEnv()', clientSrc.includes('env: pythonSpawnEnv()'))
check('§B no bare inherited env remains at the dap spawn sites', !clientSrc.includes('env: process.env,'))

// §C — the fallback arm exists and suppresses bytecode
check('§C the unavailable-cache arm suppresses bytecode entirely', resolverSrc.includes("PYTHONDONTWRITEBYTECODE: '1'"))

// §D — one root per build key (deterministic across calls)
const env2 = resolver.pythonSpawnEnv()
check('§D repeated resolution agrees on ONE cache root', env.PYTHONPYCACHEPREFIX === env2.PYTHONPYCACHEPREFIX)

// §D2 — CONCURRENT creation (UN-53): two simultaneous resolutions agree on
// one root and both succeed (mkdir-recursive idempotence + force reaping —
// no torn cache, no crash).
{
  const { spawn } = await import('node:child_process')
  const snippet =
    `const{pythonSpawnEnv}=await import(${JSON.stringify(join(ROOT, 'src/services/dap/debugpyResolver.ts'))});` +
    `console.log(pythonSpawnEnv().PYTHONPYCACHEPREFIX ?? 'SUPPRESSED')`
  const runOnce = (): Promise<{ code: number | null; out: string }> =>
    new Promise(resolvePromise => {
      const child = spawn(process.execPath, ['-e', snippet], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.on('close', code => resolvePromise({ code, out: out.trim() }))
    })
  const [a, b] = await Promise.all([runOnce(), runOnce()])
  check('§D2 concurrent resolutions both succeed', a.code === 0 && b.code === 0, `${a.code}/${b.code}`)
  check('§D2 concurrent resolutions agree on ONE root', a.out === b.out && a.out.length > 0, `${a.out} vs ${b.out}`)
}

// §E — the REAL vendored payload beside the built artifact stays clean: the
// ide suite drives the actual probe + real debug sessions against
// dist/vendor/debugpy, and with the byte-stability env none of it may leave
// bytecode beneath the payload. (Skips loudly when no dist exists.)
{
  const distVendor = join(ROOT, 'dist', 'vendor', 'debugpy')
  try {
    const pollution = walk(distVendor).filter(p => p.endsWith('.pyc') || p.includes('__pycache__'))
    check('§E the REAL vendored payload carries zero bytecode after suite-driven use', pollution.length === 0, `${pollution.length} file(s)`)
  } catch {
    console.log('  [SKIP] §E no dist/vendor/debugpy at this root (unbuilt checkout)')
  }
}

// §F — the artifact-identity projection (UN-55): same semver, different
// builds distinguish by distribution + buildTree + buildTime; the version
// itself is never mangled.
{
  const { describeArtifactIdentity, artifactIdentityLine } = await import(
    '../../src/utils/artifactIdentity.ts'
  )
  const id = describeArtifactIdentity('9.9.9-fixture')
  check('§F the projection carries version + distribution', id.version === '9.9.9-fixture' && ['packaged-install', 'source-build', 'source-run'].includes(id.distribution))
  const line = artifactIdentityLine(id)
  check('§F the concise line leads with the UNMANGLED semver', line.startsWith('v9.9.9-fixture ·'))
  const doctorSrc = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
  check('§F /health build row consumes the ONE projection', doctorSrc.includes('describeArtifactIdentity(') && doctorSrc.includes('artifactIdentityLine('))
}

console.log(failed === 0 ? '\n ✅ MANAGED PAYLOADS STAY BYTE-STABLE' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
