#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-jsdebug-vendor.ts
//  PROOF: the pinned js-debug vendor contract — the debugpy/pyright vendor
//  discipline over a GitHub release tarball (the Node/TS debug lane's G2).
//
//    (1) LOCK SHAPE — vendor/js-debug.lock.json pins name/version/tarball/
//        url/sha512/serverEntry with the licence declared.
//    (2) FETCH --check HONESTY — valid cache ⇒ exit 0; absent/stale ⇒
//        exit 2 + remedy (no network either way).
//    (3) EXTRACTION DETERMINISM — treeDigest recomputes identically from
//        the extracted bytes; server entry + licence present.
//    (4) BUILT-MANIFEST TRUTH — dist/manifest.json's jsDebug claim matches
//        the real dist/vendor/js-debug tree (vendored ⇒ entry + version
//        match the lock; else degraded[] carries 'js-debugger' + remedy).
//    (5) DEGRADED-BUILD SEAM — MERCURY_BUILD_NO_VENDOR_JSDEBUG=1 scratch
//        build ⇒ vendored=false + degraded + no tree.
//    (6) THE MISMATCH ARM, STANDING (vendor-staleness law): a cache whose
//        vendor manifest disagrees with the lock FAILS the scratch build
//        loudly, naming the fetch command — the re-pinned-lock-without-
//        refetch class can never ship silently. (The poison is transient
//        and byte-restored in finally; --check re-verifies after.)
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-jsdebug-vendor.ts
// ============================================================================

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const LOCK = join(ROOT, 'vendor', 'js-debug.lock.json')
const EXTRACT = join(ROOT, 'vendor', 'js-debug', 'extracted')
const DIST_MANIFEST = join(ROOT, 'dist', 'manifest.json')
const DIST_VENDOR = join(ROOT, 'dist', 'vendor', 'js-debug')

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
console.log(' js-debug vendor contract — lock · fetch --check · manifest')
console.log('============================================================')

section('(1) lock shape')
const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as {
  name: string
  version: string
  tarball: string
  url: string
  sha512: string
  license: string
  licenseFiles: string[]
  serverEntry: string
}
check('lock pins js-debug-dap', lock.name === 'js-debug-dap' && /^\d+\.\d+\.\d+$/.test(lock.version))
check('sha512 is a 128-hex digest', /^[0-9a-f]{128}$/.test(lock.sha512))
check('url points at the pinned release asset', lock.url.endsWith(lock.tarball) && lock.tarball.includes(`v${lock.version}`))
check('url is the vscode-js-debug releases home', lock.url.startsWith('https://github.com/microsoft/vscode-js-debug/releases/download/'))
check('licence declared (MIT + LICENSE)', lock.license === 'MIT' && lock.licenseFiles.includes('LICENSE'))
check('server entry is the standalone DAP server', lock.serverEntry === 'src/dapDebugServer.js')

section('(2) fetch --check honesty (no network)')
{
  const bun = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
  const r = spawnSync(bun, ['run', join(ROOT, 'scripts', 'vendor', 'fetch-js-debug.ts'), '--check'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env },
  })
  if (existsSync(join(EXTRACT, '.vendor-manifest.json'))) {
    check('--check exits 0 for a present cache', r.status === 0, `exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 200)}`)
  } else {
    check('--check exits 2 for an absent cache', r.status === 2, `exit ${r.status}`)
    check('--check names the remedy', (r.stderr ?? '').includes('fetch-js-debug.ts'), r.stderr.slice(0, 200))
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
  check('licence preserved', existsSync(join(EXTRACT, 'LICENSE')))
} else {
  console.log('  [SKIP — LOUD] no local vendor cache; run: bun run scripts/vendor/fetch-js-debug.ts')
  failures++
}

section('(4) built-manifest truth (dist/manifest.json vs the real tree)')
if (existsSync(DIST_MANIFEST)) {
  const m = JSON.parse(readFileSync(DIST_MANIFEST, 'utf8')) as {
    jsDebug?: { vendored: boolean; version?: string; sha512?: string; serverEntry?: string; remedy?: string }
    degraded: string[]
  }
  check('manifest carries the jsDebug record', m.jsDebug !== undefined)
  if (m.jsDebug?.vendored) {
    check('vendored claim ⇒ the server entry ships', existsSync(join(DIST_VENDOR, 'src', 'dapDebugServer.js')))
    check('vendored version matches the lock', m.jsDebug.version === lock.version)
    check('vendored sha512 matches the lock', m.jsDebug.sha512 === lock.sha512)
    check("degraded[] carries no 'js-debugger'", !m.degraded.includes('js-debugger'))
    // THE MODULE-CLASS FENCE + THE BOOT ARM. Upstream ships no package.json,
    // so node classes the CJS server bundle by the NEAREST ANCESTOR
    // package.json — a type:module scope above the tree (this repo's own; a
    // stray one above an operator's config home) loaded it as ESM and it
    // died at boot ("Dynamic require of 'fs' is not supported") — a rung
    // that was extraction-proven but never BOOTED (the masked-by-absence
    // class). The build writes a one-line {"type":"commonjs"} fence; the
    // arm DRIVES the boot from inside the hostile scope instead of trusting
    // the classing: spawn the server IN PLACE (the repo IS a type:module
    // scope — asserted, so the arm can never silently lose its hostility),
    // read the listening line, bounded kill reaps it.
    const fencePath = join(DIST_VENDOR, 'package.json')
    check('the module-class fence ships ({"type":"commonjs"})', existsSync(fencePath) && (JSON.parse(readFileSync(fencePath, 'utf8')) as { type?: string }).type === 'commonjs')
    const repoPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { type?: string }
    check('the hostile scope is REAL (the repo package.json is type:module — the boot below proves the fence, not the default)', repoPkg.type === 'module')
    const bootPort = 49152 + Math.floor(Math.random() * 16000)
    const boot = spawnSync('node', [join(DIST_VENDOR, 'src', 'dapDebugServer.js'), String(bootPort), '127.0.0.1'], {
      encoding: 'utf8',
      timeout: 6000,
      cwd: ROOT,
    })
    check(
      'the vendored server BOOTS inside the type:module scope (listening line read; bounded spawn reaped)',
      (boot.stdout ?? '').includes(`Debug server listening at 127.0.0.1:${bootPort}`),
      ((boot.stderr || boot.stdout) ?? '').slice(0, 160),
    )
  } else {
    check("not-vendored ⇒ degraded[] carries 'js-debugger'", m.degraded.includes('js-debugger') === true)
    check('not-vendored ⇒ no tree ships', !existsSync(DIST_VENDOR))
    check('not-vendored carries the remedy', typeof m.jsDebug?.remedy === 'string' && m.jsDebug.remedy.includes('fetch-js-debug'))
  }
} else {
  console.log('  [SKIP — LOUD] no dist/manifest.json; build first.')
  failures++
}

section('(5) degraded-build seam (MERCURY_BUILD_NO_VENDOR_JSDEBUG=1, scratch outdir)')
{
  const scratch = mkdtempSync(join(tmpdir(), 'jsdebug-degraded-build-'))
  try {
    const bun = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
    const r = spawnSync(bun, ['run', join(ROOT, 'build.ts')], {
      encoding: 'utf8',
      timeout: 300_000,
      cwd: ROOT,
      env: {
        ...process.env,
        MERCURY_BUILD_OUTDIR: scratch,
        MERCURY_BUILD_NO_VENDOR_JSDEBUG: '1',
        MERCURY_BUILD_TIME: '2026-01-01T00:00:00.000Z',
      },
    })
    check('degraded build succeeds (js-debug is optional)', r.status === 0, (r.stderr || r.stdout).slice(-300))
    const m = JSON.parse(readFileSync(join(scratch, 'manifest.json'), 'utf8')) as {
      jsDebug?: { vendored: boolean; remedy?: string }
      degraded: string[]
    }
    check('scratch manifest: vendored=false', m.jsDebug?.vendored === false)
    check("scratch manifest: degraded includes 'js-debugger'", m.degraded.includes('js-debugger'))
    check('scratch dist ships NO js-debug tree', !existsSync(join(scratch, 'vendor', 'js-debug')))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('(6) the mismatch arm, STANDING (poisoned cache ⇒ BUILD FAILED naming the fetch)')
if (existsSync(join(EXTRACT, '.vendor-manifest.json'))) {
  const vmanPath = join(EXTRACT, '.vendor-manifest.json')
  const original = readFileSync(vmanPath)
  const scratch = mkdtempSync(join(tmpdir(), 'jsdebug-poison-build-'))
  try {
    const poisoned = { ...(JSON.parse(original.toString('utf8')) as Record<string, unknown>), version: '0.0.0-poison' }
    writeFileSync(vmanPath, JSON.stringify(poisoned, null, 2) + '\n')
    const bun = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
    const r = spawnSync(bun, ['run', join(ROOT, 'build.ts')], {
      encoding: 'utf8',
      timeout: 300_000,
      cwd: ROOT,
      env: {
        ...process.env,
        MERCURY_BUILD_OUTDIR: scratch,
        MERCURY_BUILD_TIME: '2026-01-01T00:00:00.000Z',
      },
    })
    check('poisoned cache FAILS the build (exit 1)', r.status === 1, `exit ${r.status}`)
    const err = `${r.stderr ?? ''}${r.stdout ?? ''}`
    check('…naming the mismatch', err.includes('vendor/js-debug cache does not match vendor/js-debug.lock.json'))
    check('…and the fetch remedy', err.includes('bun run scripts/vendor/fetch-js-debug.ts'))
  } finally {
    writeFileSync(vmanPath, original)
    rmSync(scratch, { recursive: true, force: true })
  }
  const recheck = spawnSync(
    process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun'),
    ['run', join(ROOT, 'scripts', 'vendor', 'fetch-js-debug.ts'), '--check'],
    { encoding: 'utf8', timeout: 120_000, env: { ...process.env } },
  )
  check('cache byte-restored after the poison (--check OK)', recheck.status === 0, (recheck.stderr || '').slice(0, 200))
} else {
  console.log('  [SKIP — LOUD] no local vendor cache; the mismatch arm needs it.')
  failures++
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ ALL JS-DEBUG VENDOR CHECKS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
