#!/usr/bin/env bun
// ============================================================================
//  scripts/build/prove-vendor-tar-dialect.ts — the vendor fetches extract
//  whole under EVERY tar dialect.
//
//  E008-01 ↔ TASK-018 W1-build-path (cross-box, both Windows machines):
//  three fetch-*.ts scripts spawned bare `tar` with Windows ABSOLUTE
//  paths; GNU tar parses a leading `C:` as a remote host and aborts
//  ("Cannot connect to C: resolve failed"), so whichever tar PATH resolves
//  first decided whether a checkout could fetch its vendor packs at all —
//  and the build then shipped silently degraded. bsdtar was fine.
//
//  The fix is ONE shared invocation (scripts/vendor/tarExtract.ts): tar
//  runs with cwd set and RELATIVE forward-slash paths, so no argv token
//  can carry a drive colon and GNU tar's host:path parsing can never
//  engage — no dialect probe on the happy path. Only when relativisation
//  cannot shed a drive (cross-drive) or a colon survives in a file name
//  does it fall back to absolute paths, appending GNU tar's own remedy
//  --force-local exactly when the probed dialect is GNU (bsdtar has no
//  such flag and no such parsing).
//
//  §1 the plan under win32 shapes: colon-free relative argv, cwd chosen.
//  §2 cross-drive + colon-in-filename fall back: --force-local iff GNU.
//  §3 the census: all three fetch scripts extract through the ONE helper —
//     no bare tar spawn remains outside it.
//  §4 live, with a FAKED tar first on PATH that aborts GNU-style on any
//     drive-colon argv token and otherwise delegates: the field's abort
//     reproduces against the OLD call shape (the control), and the
//     helper's invocation extracts whole with a colon-free argv log.
//  This box cannot boot Windows: the FIELD verifies the live Windows
//  fetch.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-tar-dialect-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' vendor tar dialect — colon-free argv, whole on every tar')
console.log('============================================================')

const helperPath = join(import.meta.dir, '..', 'vendor', 'tarExtract.ts')
check('the shared helper exists', existsSync(helperPath))
const helper = await import('../vendor/tarExtract.ts')

console.log('[1] the plan under win32 shapes is colon-free and relative')
{
  const plan = helper.planTarExtract({
    tarballPath: 'C:\\repo\\vendor\\cache\\pyright-1.1.413.tgz',
    destDir: 'C:\\repo\\vendor\\pyright.extracted.tmp-1',
    stripComponents: 1,
    pathApi: path.win32,
    isGnuTar: () => {
      throw new Error('the happy path must not probe the dialect')
    },
  })
  check('no argv token carries a colon', plan.args.every(a => !a.includes(':')), plan.args.join(' '))
  check('cwd is the tarball directory', plan.cwd === 'C:\\repo\\vendor\\cache')
  check('the tarball is its bare name', plan.args.includes('pyright-1.1.413.tgz'))
  check('the destination is relative with forward slashes', plan.args.includes('../pyright.extracted.tmp-1'), plan.args.join(' '))
  check('strip-components rides along', plan.args.join(' ').includes('--strip-components 1'))
  check('no --force-local on the happy path', !plan.forceLocal && !plan.args.includes('--force-local'))
}

console.log('[2] cross-drive and colon-in-filename fall back with --force-local iff GNU')
{
  const gnu = helper.planTarExtract({
    tarballPath: 'C:\\a\\x.tgz',
    destDir: 'D:\\b\\out',
    stripComponents: 1,
    pathApi: path.win32,
    isGnuTar: () => true,
  })
  check('cross-drive falls back to absolute + --force-local under GNU', gnu.forceLocal && gnu.args.includes('--force-local') && gnu.args.includes('C:\\a\\x.tgz'), gnu.args.join(' '))
  const bsd = helper.planTarExtract({
    tarballPath: 'C:\\a\\x.tgz',
    destDir: 'D:\\b\\out',
    stripComponents: 1,
    pathApi: path.win32,
    isGnuTar: () => false,
  })
  check('bsdtar never receives --force-local', !bsd.forceLocal && !bsd.args.includes('--force-local'))
  const weird = helper.planTarExtract({
    tarballPath: '/x/we:ird.tgz',
    destDir: '/x/out',
    isGnuTar: () => true,
  })
  check('a colon surviving in a file name takes the fallback too', weird.forceLocal && weird.args.includes('--force-local'), weird.args.join(' '))
}

console.log('[3] the census: every fetch script extracts through the one helper')
{
  const scripts = ['fetch-pyright.ts', 'fetch-js-debug.ts', 'fetch-grammars.ts']
  for (const script of scripts) {
    const text = readFileSync(join(import.meta.dir, '..', 'vendor', script), 'utf8')
    check(`${script} imports the shared helper`, text.includes("from './tarExtract.ts'"))
    check(`${script} spawns no bare tar`, !text.includes("spawnSync('tar'"), 'a bare tar spawn remains')
  }
  const debugpy = readFileSync(join(import.meta.dir, '..', 'vendor', 'fetch-debugpy.ts'), 'utf8')
  check('fetch-debugpy stays tar-free (the wheel route)', !debugpy.includes("spawnSync('tar'"))
}

console.log('[4] live: the faked dialect aborts the old shape, the helper extracts whole')
{
  // The faked tar: logs argv, aborts GNU-style on any drive-colon token,
  // otherwise delegates to the system tar (real extraction).
  const bin = join(scratch, 'bin')
  mkdirSync(bin, { recursive: true })
  const argvLog = join(scratch, 'argv.log')
  writeFileSync(
    join(bin, 'tar'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argvLog}"\nfor a in "$@"; do\n  case "$a" in\n    --force-local) ;;\n    [A-Za-z]:*) printf 'tar (child): Cannot connect to %s: resolve failed\\n' "\${a%%:*}" >&2; exit 128 ;;\n  esac\ndone\nexec /usr/bin/tar "$@"\n`,
  )
  chmodSync(join(bin, 'tar'), 0o755)

  // A real .tgz fixture: package/hello.txt (the npm layout the fetches strip).
  const stage = join(scratch, 'stage', 'package')
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'hello.txt'), 'vendored bytes\n')
  const tarball = join(scratch, 'fixture.tgz')
  const made = spawnSync('/usr/bin/tar', ['-czf', tarball, '-C', join(scratch, 'stage'), 'package'], { encoding: 'utf8' })
  check('the fixture tarball builds', made.status === 0, made.stderr ?? '')

  const oldPath = process.env.PATH
  process.env.PATH = `${bin}:${oldPath ?? ''}`
  try {
    // The CONTROL: the OLD call shape (absolute path handed to bare tar)
    // against a drive-colon token reproduces the field's abort verbatim.
    // env passed explicitly — bun's spawnSync resolves the executable
    // against the process-start PATH otherwise (the helper does the same).
    const control = spawnSync('tar', ['-xzf', 'C:\\repo\\vendor\\cache\\x.tgz', '-C', '/tmp/x'], { encoding: 'utf8', env: process.env })
    check('the control reproduces the field abort', control.status === 128 && /Cannot connect/.test(control.stderr ?? ''), `status ${String(control.status)}`)

    // The helper against the same faked dialect: extracts whole.
    rmSync(argvLog, { force: true })
    const dest = join(scratch, 'out')
    mkdirSync(dest, { recursive: true })
    const run = helper.extractTarGz({ tarballPath: tarball, destDir: dest, stripComponents: 1 })
    check('the helper extraction succeeds', run.ok === true, run.ok ? '' : run.message)
    check('the stripped payload landed', existsSync(join(dest, 'hello.txt')))
    const logged = existsSync(argvLog) ? readFileSync(argvLog, 'utf8').split('\n').filter(Boolean) : []
    check('the argv log is colon-free', logged.length > 0 && logged.every(a => !a.includes(':')), logged.join(' '))
    check('the argv log holds no absolute path', logged.every(a => !a.startsWith('/')), logged.join(' '))
  } finally {
    process.env.PATH = oldPath
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ VENDOR TAR DIALECT — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
