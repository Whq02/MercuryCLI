#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
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
const resolver = await import('../../src/integrations/debugger/debugpyResolver.ts')
resolver._resetDebugpyResolverForTesting()
const resolution = resolver.resolvePythonDebugAdapter()
check('§A probe resolves green against the vendored copy', resolution.state === 'ok', resolution.state === 'ok' ? '' : resolution.reason, 'resolvePythonDebugAdapter in src/integrations/debugger/debugpyResolver.ts must resolve the copy named by MERCURY_DEBUGPY_VENDOR_DIR')
const after = walk(payload)
check('§A the payload is BYTE-STABLE through the probe (zero files added)', JSON.stringify(after) === JSON.stringify(before), `${after.length - before.length} new file(s)`, 'resolvePythonDebugAdapter in src/integrations/debugger/debugpyResolver.ts must not write into the vendored payload')

const env = resolver.pythonSpawnEnv()
const prefix = env.PYTHONPYCACHEPREFIX
check('§A2 the spawn env carries the cache prefix (or the suppression fallback)', typeof prefix === 'string' || env.PYTHONDONTWRITEBYTECODE === '1', '', 'pythonSpawnEnv in src/integrations/debugger/debugpyResolver.ts must set PYTHONPYCACHEPREFIX or PYTHONDONTWRITEBYTECODE')
if (typeof prefix === 'string') {
  check('§A2 the cache root lives under the mercury cache home, not the payload', prefix.includes('pycache') && !prefix.startsWith(payload), '', 'pythonSpawnEnv in src/integrations/debugger/debugpyResolver.ts must put PYTHONPYCACHEPREFIX in a pycache folder under the cache home, outside the payload')
}

const ROOT = join(import.meta.dir, '..', '..')


const env2 = resolver.pythonSpawnEnv()
check('§D repeated resolution agrees on ONE cache root', env.PYTHONPYCACHEPREFIX === env2.PYTHONPYCACHEPREFIX, '', 'pythonSpawnEnv in src/integrations/debugger/debugpyResolver.ts must return the same PYTHONPYCACHEPREFIX on every call')

{
  const { spawn } = await import('node:child_process')
  const snippet =
    `const{pythonSpawnEnv}=await import(${JSON.stringify(join(ROOT, 'src/integrations/debugger/debugpyResolver.ts'))});` +
    `console.log(pythonSpawnEnv().PYTHONPYCACHEPREFIX ?? 'SUPPRESSED')`
  const runOnce = (): Promise<{ code: number | null; out: string }> =>
    new Promise(resolvePromise => {
      const child = spawn(process.execPath, ['-e', snippet], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.on('close', code => resolvePromise({ code, out: out.trim() }))
    })
  const [a, b] = await Promise.all([runOnce(), runOnce()])
  check('§D2 concurrent resolutions both succeed', a.code === 0 && b.code === 0, `${a.code}/${b.code}`, 'pythonSpawnEnv in src/integrations/debugger/debugpyResolver.ts must not fail when two processes resolve at once')
  check('§D2 concurrent resolutions agree on ONE root', a.out === b.out && a.out.length > 0, `${a.out} vs ${b.out}`, 'pythonSpawnEnv in src/integrations/debugger/debugpyResolver.ts must pick one cache root across concurrent processes')
}

{
  const distVendor = join(ROOT, 'dist', 'vendor', 'debugpy')
  try {
    const pollution = walk(distVendor).filter(p => p.endsWith('.pyc') || p.includes('__pycache__'))
    check('§E the REAL vendored payload carries zero bytecode after suite-driven use', pollution.length === 0, `${pollution.length} file(s)`, 'delete the .pyc and __pycache__ files under dist/vendor/debugpy and find what ran Python without the PYTHONPYCACHEPREFIX from pythonSpawnEnv in src/integrations/debugger/debugpyResolver.ts')
  } catch {
    console.log('  [SKIP] §E no dist/vendor/debugpy at this root (unbuilt checkout)')
  }
}

{
  const { describeArtifactIdentity, artifactIdentityLine } = await import(
    '../../src/platform/product/artifactIdentity.ts'
  )
  const id = describeArtifactIdentity('9.9.9-fixture')
  check('§F the projection carries version + distribution', id.version === '9.9.9-fixture' && ['packaged-install', 'source-build', 'source-run'].includes(id.distribution), '', 'describeArtifactIdentity in src/platform/product/artifactIdentity.ts must return the version it was given and a known distribution')
  const line = artifactIdentityLine(id)
  check('§F the concise line leads with the UNMANGLED semver', line.startsWith('v9.9.9-fixture ·'), '', 'artifactIdentityLine in src/platform/product/artifactIdentity.ts must begin with v and the unchanged version')
  const { healthContext } = await import('../../src/platform/health/healthReport.ts')
  const { identityChecks } = await import('../../src/platform/health/sections/identity.ts')
  const context = await healthContext()
  const buildRow = await identityChecks(context).find(row => row.id === 'build-identity')?.run()
  check('§F /health build row consumes the ONE projection', buildRow?.evidence.startsWith(artifactIdentityLine(describeArtifactIdentity(context.version))) === true, buildRow?.evidence, 'the build-identity check in src/platform/health/sections/identity.ts must build its evidence from artifactIdentityLine and describeArtifactIdentity in src/platform/product/artifactIdentity.ts')
}

console.log(failed === 0 ? '\n ✅ MANAGED PAYLOADS STAY BYTE-STABLE' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
