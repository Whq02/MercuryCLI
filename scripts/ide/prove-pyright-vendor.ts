#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-pyright-vendor.ts
//  PROOF: the pinned Pyright vendor contract — the debugpy
//  vendor discipline over an npm tarball.
//
//    (1) LOCK SHAPE — vendor/pyright.lock.json pins name/version/tarball/
//        url/sha512(+npm integrity)/serverEntry with the licence declared.
//    (2) FETCH --check HONESTY — valid cache ⇒ exit 0; absent/stale ⇒
//        exit 2 + remedy (no network either way).
//    (3) EXTRACTION DETERMINISM — treeDigest recomputes identically from
//        the extracted bytes; server entry + licence present.
//    (4) BUILT-MANIFEST TRUTH — dist/manifest.json's pyright claim matches
//        the real dist/vendor/pyright tree (vendored ⇒ entry + version match
//        the lock; else degraded[] carries 'python-intelligence' + remedy).
//    (5) DEGRADED-BUILD SEAM — MERCURY_BUILD_NO_VENDOR_PYRIGHT=1 scratch
//        build ⇒ vendored=false + degraded + no tree.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-pyright-vendor.ts
// ============================================================================

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK = join(ROOT, 'vendor', 'pyright.lock.json')
const EXTRACT = join(ROOT, 'vendor', 'pyright', 'extracted')
const DIST_MANIFEST = join(ROOT, 'dist', 'manifest.json')
const DIST_VENDOR = join(ROOT, 'dist', 'vendor', 'pyright')

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
console.log(' pyright vendor contract — lock · fetch --check · manifest')
console.log('============================================================')

section('(1) lock shape')
const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as {
  name: string
  version: string
  tarball: string
  url: string
  sha512: string
  integrity: string
  license: string
  licenseFiles: string[]
  serverEntry: string
}
check('lock pins pyright', lock.name === 'pyright' && /^\d+\.\d+\.\d+$/.test(lock.version))
check('sha512 is a 128-hex digest', /^[0-9a-f]{128}$/.test(lock.sha512))
check('sha512 hex EQUALS the recorded npm integrity (base64)', Buffer.from(lock.sha512, 'hex').toString('base64') === lock.integrity.replace(/^sha512-/, ''))
check('url points at the pinned tarball', lock.url.endsWith(lock.tarball) && lock.tarball.includes(lock.version))
check('licence declared (MIT + LICENSE.txt)', lock.license === 'MIT' && lock.licenseFiles.includes('LICENSE.txt'))
check('server entry is the langserver bundle', lock.serverEntry === 'langserver.index.js')

section('(2) fetch --check honesty (no network)')
{
  const bun = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
  const r = spawnSync(bun, ['run', join(ROOT, 'scripts', 'vendor', 'fetch-pyright.ts'), '--check'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env },
  })
  if (existsSync(join(EXTRACT, '.vendor-manifest.json'))) {
    check('--check exits 0 for a present cache', r.status === 0, `exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 200)}`)
  } else {
    check('--check exits 2 for an absent cache', r.status === 2, `exit ${r.status}`)
    check('--check names the remedy', (r.stderr ?? '').includes('fetch-pyright.ts'), r.stderr.slice(0, 200))
  }
}

section('(3) extraction determinism (cache present only)')
if (existsSync(join(EXTRACT, '.vendor-manifest.json'))) {
  const vman = JSON.parse(readFileSync(join(EXTRACT, '.vendor-manifest.json'), 'utf8')) as {
    version: string
    tarballSha512: string
    fileCount: number
    treeDigest: string
  }
  check('vendor manifest matches the lock', vman.version === lock.version && vman.tarballSha512 === lock.sha512)
  const files = walkFiles(EXTRACT)
  check(`file count matches (${vman.fileCount})`, files.length === vman.fileCount, `${files.length} on disk`)
  const digest = sha256(files.map(f => `${f.rel} ${f.sha256}`).sort().join('\n'))
  check('treeDigest recomputes identically from the bytes', digest === vman.treeDigest, digest.slice(0, 16))
  check('server entry present', existsSync(join(EXTRACT, lock.serverEntry)))
  check('licence preserved', existsSync(join(EXTRACT, 'LICENSE.txt')))
} else {
  console.log('  [SKIP — LOUD] no local vendor cache; run: bun run scripts/vendor/fetch-pyright.ts')
  failures++
}

section('(4) built-manifest truth (dist/manifest.json vs the real tree)')
if (existsSync(DIST_MANIFEST)) {
  const m = JSON.parse(readFileSync(DIST_MANIFEST, 'utf8')) as {
    pyright?: { vendored: boolean; version?: string; sha512?: string; serverEntry?: string; remedy?: string }
    degraded: string[]
  }
  check('manifest carries the pyright record', m.pyright !== undefined)
  if (m.pyright?.vendored) {
    check('vendored claim ⇒ the server entry ships', existsSync(join(DIST_VENDOR, 'langserver.index.js')))
    check('vendored version matches the lock', m.pyright.version === lock.version)
    check('vendored sha512 matches the lock', m.pyright.sha512 === lock.sha512)
    check("degraded[] carries no 'python-intelligence'", !m.degraded.includes('python-intelligence'))
  } else {
    check("not-vendored ⇒ degraded[] carries 'python-intelligence'", m.degraded.includes('python-intelligence') === true)
    check('not-vendored ⇒ no tree ships', !existsSync(DIST_VENDOR))
    check('not-vendored carries the remedy', typeof m.pyright?.remedy === 'string' && m.pyright.remedy.includes('fetch-pyright'))
  }
} else {
  console.log('  [SKIP — LOUD] no dist/manifest.json; build first.')
  failures++
}

section('(5) degraded-build seam (MERCURY_BUILD_NO_VENDOR_PYRIGHT=1, scratch outdir)')
{
  const scratch = mkdtempSync(join(tmpdir(), 'pyright-degraded-build-'))
  try {
    const bun = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
    const r = spawnSync(bun, ['run', join(ROOT, 'build.ts')], {
      encoding: 'utf8',
      timeout: 300_000,
      cwd: ROOT,
      env: {
        ...process.env,
        MERCURY_BUILD_OUTDIR: scratch,
        MERCURY_BUILD_NO_VENDOR_PYRIGHT: '1',
        MERCURY_BUILD_TIME: '2026-01-01T00:00:00.000Z',
      },
    })
    check('degraded build succeeds (pyright is optional)', r.status === 0, (r.stderr || r.stdout).slice(-300))
    const m = JSON.parse(readFileSync(join(scratch, 'manifest.json'), 'utf8')) as {
      pyright?: { vendored: boolean; remedy?: string }
      degraded: string[]
    }
    check('scratch manifest: vendored=false', m.pyright?.vendored === false)
    check("scratch manifest: degraded includes 'python-intelligence'", m.degraded.includes('python-intelligence'))
    check('scratch dist ships NO pyright tree', !existsSync(join(scratch, 'vendor', 'pyright')))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL PYRIGHT VENDOR CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
