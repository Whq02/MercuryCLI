#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

section('(6) the mismatch arm, STANDING (a poisoned SCRATCH copy of the cache ⇒ BUILD FAILED naming the fetch; the shared cache is never written)')
if (existsSync(join(EXTRACT, '.vendor-manifest.json'))) {
  const vmanPath = join(EXTRACT, '.vendor-manifest.json')
  const original = readFileSync(vmanPath)
  const scratch = mkdtempSync(join(tmpdir(), 'jsdebug-poison-build-'))
  const mirror = mkdtempSync(join(tmpdir(), 'jsdebug-poison-root-'))
  try {
    for (const entry of readdirSync(ROOT)) {
      if (entry === 'vendor' || entry === 'build.ts' || entry === 'dist' || entry === '.git') continue
      symlinkSync(join(ROOT, entry), join(mirror, entry))
    }
    copyFileSync(join(ROOT, 'build.ts'), join(mirror, 'build.ts'))
    mkdirSync(join(mirror, 'vendor'))
    for (const entry of readdirSync(join(ROOT, 'vendor'))) {
      if (entry === 'js-debug') continue
      symlinkSync(join(ROOT, 'vendor', entry), join(mirror, 'vendor', entry))
    }
    const realExtract = realpathSync(EXTRACT)
    const mirrorExtract = join(mirror, 'vendor', 'js-debug', 'extracted')
    mkdirSync(mirrorExtract, { recursive: true })
    for (const entry of readdirSync(realExtract)) {
      if (entry === '.vendor-manifest.json') continue
      symlinkSync(join(realExtract, entry), join(mirrorExtract, entry))
    }
    const poisoned = { ...(JSON.parse(original.toString('utf8')) as Record<string, unknown>), version: '0.0.0-poison' }
    writeFileSync(join(mirrorExtract, '.vendor-manifest.json'), JSON.stringify(poisoned, null, 2) + '\n')
    const bun = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
    const r = spawnSync(bun, ['run', join(mirror, 'build.ts')], {
      encoding: 'utf8',
      timeout: 300_000,
      cwd: ROOT,
      env: {
        ...process.env,
        MERCURY_BUILD_OUTDIR: scratch,
        MERCURY_BUILD_TIME: '2026-01-01T00:00:00.000Z',
      },
    })
    check('poisoned cache FAILS the build (exit 1)', r.status === 1, `exit ${r.status}: ${(r.stderr || r.stdout || '').slice(-300)}`)
    const err = `${r.stderr ?? ''}${r.stdout ?? ''}`
    check('…naming the mismatch', err.includes('vendor/js-debug cache does not match vendor/js-debug.lock.json'))
    check('…and the fetch remedy', err.includes('bun run scripts/vendor/fetch-js-debug.ts'))
  } finally {
    rmSync(mirror, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
  check('the shared cache manifest was never written (bytes unchanged)', readFileSync(vmanPath).equals(original))
  const recheck = spawnSync(
    process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun'),
    ['run', join(ROOT, 'scripts', 'vendor', 'fetch-js-debug.ts'), '--check'],
    { encoding: 'utf8', timeout: 120_000, env: { ...process.env } },
  )
  check('the shared cache still passes --check', recheck.status === 0, (recheck.stderr || '').slice(0, 200))
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
