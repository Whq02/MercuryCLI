#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-debugpy-vendor.ts
//  PROOF: the pinned debugpy vendor contract.
//
//    (1) LOCK SHAPE — vendor/debugpy.lock.json pins name/version/wheel/url/
//        sha256/sizeBytes/adapterEntry with a 64-hex digest; the licence
//        files are declared.
//    (2) FETCH --check HONESTY — the check-only mode's verdict matches the
//        real cache state (valid ⇒ exit 0; absent/stale ⇒ exit 2 + remedy),
//        no network either way.
//    (3) EXTRACTION DETERMINISM — when the cache exists, the vendor
//        manifest's treeDigest recomputes IDENTICALLY from the extracted
//        bytes (sorted relpath+sha256 lines), and the adapter entry +
//        licence/notice files are present.
//    (4) BUILT-MANIFEST TRUTH — dist/manifest.json's pythonDebugger claim
//        matches the REAL dist/vendor/debugpy tree (vendored ⇒ tree +
//        adapter entry + version match the lock; not vendored ⇒ degraded[]
//        carries 'python-debugger' and no tree ships).
//    (5) DEGRADED-BUILD SEAM — a scratch build with
//        MERCURY_BUILD_NO_VENDOR_DEBUGPY=1 (MERCURY_BUILD_OUTDIR isolated)
//        produces manifest.pythonDebugger.vendored=false + degraded
//        including 'python-debugger' + NO vendor tree — the artifact can
//        never claim what it does not carry.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-debugpy-vendor.ts
// ============================================================================

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK = join(ROOT, 'vendor', 'debugpy.lock.json')
const EXTRACT = join(ROOT, 'vendor', 'debugpy', 'extracted')
const DIST_MANIFEST = join(ROOT, 'dist', 'manifest.json')
const DIST_VENDOR = join(ROOT, 'dist', 'vendor', 'debugpy')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

function walkFiles(dir: string, base = dir): Array<{ rel: string; sha256: string }> {
  const out: Array<{ rel: string; sha256: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(p, base))
    else if (entry.isFile()) {
      const rel = relative(base, p)
      if (rel === '.vendor-manifest.json') continue
      out.push({ rel, sha256: sha256(readFileSync(p)) })
    }
  }
  return out
}

console.log('============================================================')
console.log(' debugpy vendor contract — lock · fetch --check · manifest')
console.log('============================================================')

section('(1) lock shape')
const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as {
  name: string
  version: string
  wheel: string
  url: string
  sha256: string
  sizeBytes: number
  license: string
  licenseFiles: string[]
  adapterEntry: string
}
check('lock pins debugpy', lock.name === 'debugpy' && /^\d+\.\d+\.\d+$/.test(lock.version))
check('sha256 is a 64-hex digest', /^[0-9a-f]{64}$/.test(lock.sha256))
check('url points at the pinned wheel file', lock.url.endsWith(lock.wheel))
check('wheel filename carries the pinned version', lock.wheel.includes(lock.version))
check('licence + notice files declared', lock.license === 'MIT' && lock.licenseFiles.length >= 2)
check('adapter entry is the proven directory invocation', lock.adapterEntry === 'debugpy/adapter')

section('(2) fetch --check honesty (no network)')
{
  const bun = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
  const r = spawnSync(bun, ['run', join(ROOT, 'scripts', 'vendor', 'fetch-debugpy.ts'), '--check'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env },
  })
  const cacheValidOnDisk = existsSync(join(EXTRACT, '.vendor-manifest.json'))
  if (cacheValidOnDisk) {
    check('--check exits 0 for a present cache', r.status === 0, `exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 200)}`)
  } else {
    check('--check exits 2 for an absent cache', r.status === 2, `exit ${r.status}`)
    check('--check names the remedy', (r.stderr ?? '').includes('fetch-debugpy.ts'), r.stderr.slice(0, 200))
  }
}

section('(2b) the extractor candidate chain (small-fix bundle item 6, TASK-E007)')
{
  // Stock Windows has neither `unzip` nor `python3`; the chain must carry
  // the names that host actually has — and the failure line must name ALL
  // candidates so the operator installs the right one.
  const src = readFileSync(join(ROOT, 'scripts', 'vendor', 'fetch-debugpy.ts'), 'utf8')
  const order = ['unzip', 'python3', 'tar.exe', 'python', 'py']
  const listStart = src.indexOf('EXTRACT_CANDIDATES')
  const listSrc = listStart >= 0 ? src.slice(listStart, src.indexOf('function extractWheel')) : ''
  let lastIndex = -1
  let inOrder = listSrc.length > 0
  for (const name of order) {
    const at = listSrc.indexOf(`name: '${name}'`)
    if (at === -1 || at < lastIndex) inOrder = false
    lastIndex = at
  }
  check('all five candidates present, in order (unzip → python3 → tar.exe → python → py)', inOrder)
  check("`py` invokes the -3 launcher form", listSrc.includes("'-3', '-m', 'zipfile'"))
  check(
    'the failure message names the whole candidate list',
    src.includes("EXTRACT_CANDIDATES.map(c => `'${c.name}'`).join(', ')"),
  )
  check(
    'a failed attempt resets the tmp tree (no merged-tree digest)',
    /attempts\.push[\s\S]{0,400}rmSync\(tmp, \{ recursive: true, force: true \}\)\s*\n\s*mkdirSync\(tmp/.test(src),
  )
}

section('(3) extraction determinism (cache present only)')
if (existsSync(join(EXTRACT, '.vendor-manifest.json'))) {
  const vman = JSON.parse(readFileSync(join(EXTRACT, '.vendor-manifest.json'), 'utf8')) as {
    version: string
    wheelSha256: string
    fileCount: number
    treeDigest: string
  }
  check('vendor manifest matches the lock', vman.version === lock.version && vman.wheelSha256 === lock.sha256)
  const files = walkFiles(EXTRACT)
  check(`file count matches (${vman.fileCount})`, files.length === vman.fileCount, `${files.length} on disk`)
  const digest = sha256(files.map(f => `${f.rel} ${f.sha256}`).sort().join('\n'))
  check('treeDigest recomputes identically from the bytes', digest === vman.treeDigest, digest.slice(0, 16))
  check('adapter entry present', existsSync(join(EXTRACT, lock.adapterEntry, '__main__.py')))
  for (const lf of lock.licenseFiles) {
    check(`licence/notice preserved: ${lf}`, existsSync(join(EXTRACT, lf)))
  }
} else {
  console.log('  [SKIP — LOUD] no local vendor cache; extraction-determinism legs need it.')
  console.log('  remedy: bun run scripts/vendor/fetch-debugpy.ts  (downloads the pinned wheel once)')
}

section('(4) built-manifest truth (dist/manifest.json vs the real tree)')
if (existsSync(DIST_MANIFEST)) {
  const m = JSON.parse(readFileSync(DIST_MANIFEST, 'utf8')) as {
    pythonDebugger?: { vendored: boolean; version?: string; sha256?: string; adapterEntry?: string; remedy?: string }
    degraded: string[]
  }
  check('manifest carries the pythonDebugger record', m.pythonDebugger !== undefined)
  if (m.pythonDebugger?.vendored) {
    check('vendored claim ⇒ the tree ships', existsSync(join(DIST_VENDOR, 'debugpy', 'adapter', '__main__.py')))
    check('vendored version matches the lock', m.pythonDebugger.version === lock.version)
    check('vendored sha256 matches the lock', m.pythonDebugger.sha256 === lock.sha256)
    check("degraded[] carries no 'python-debugger'", !m.degraded.includes('python-debugger'))
    const shippedVman = join(DIST_VENDOR, '.vendor-manifest.json')
    check('the shipped tree carries its vendor manifest', existsSync(shippedVman))
  } else {
    check("not-vendored claim ⇒ degraded[] carries 'python-debugger'", m.degraded.includes('python-debugger') === true)
    check('not-vendored claim ⇒ no tree ships', !existsSync(DIST_VENDOR))
    check('not-vendored claim carries the remedy', typeof m.pythonDebugger?.remedy === 'string' && m.pythonDebugger.remedy.includes('fetch-debugpy'))
  }
} else {
  console.log('  [SKIP — LOUD] no dist/manifest.json; build first (the pooled gate prebuilds dist).')
  failures++
}

section('(5) degraded-build seam (MERCURY_BUILD_NO_VENDOR_DEBUGPY=1, scratch outdir)')
{
  const scratch = mkdtempSync(join(tmpdir(), 'debugpy-degraded-build-'))
  try {
    const bun = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
    const r = spawnSync(bun, ['run', join(ROOT, 'build.ts')], {
      encoding: 'utf8',
      timeout: 300_000,
      cwd: ROOT,
      env: {
        ...process.env,
        MERCURY_BUILD_OUTDIR: scratch,
        MERCURY_BUILD_NO_VENDOR_DEBUGPY: '1',
        MERCURY_BUILD_TIME: '2026-01-01T00:00:00.000Z',
      },
    })
    check('degraded build succeeds (debugpy is optional)', r.status === 0, (r.stderr || r.stdout).slice(-300))
    const m = JSON.parse(readFileSync(join(scratch, 'manifest.json'), 'utf8')) as {
      pythonDebugger?: { vendored: boolean; remedy?: string }
      degraded: string[]
    }
    check('scratch manifest: vendored=false', m.pythonDebugger?.vendored === false)
    check("scratch manifest: degraded includes 'python-debugger'", m.degraded.includes('python-debugger'))
    check('scratch manifest names the remedy', (m.pythonDebugger?.remedy ?? '').includes('fetch-debugpy'))
    check('scratch dist ships NO vendor tree', !existsSync(join(scratch, 'vendor', 'debugpy')))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL DEBUGPY VENDOR CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
