#!/usr/bin/env bun
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
check('the shared helper exists', existsSync(helperPath), 'scripts/vendor/tarExtract.ts is missing; restore it (planTarExtract and extractTarGz)')
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
  check('no argv token carries a colon', plan.args.every(a => !a.includes(':')), plan.args.join(' ') + ' — planTarExtract in scripts/vendor/tarExtract.ts must pass relative, colon-free paths with cwd set to the tarball directory')
  check('cwd is the tarball directory', plan.cwd === 'C:\\repo\\vendor\\cache', `cwd ${String(plan.cwd)} — planTarExtract in scripts/vendor/tarExtract.ts must set cwd to the tarball directory`)
  check('the tarball is its bare name', plan.args.includes('pyright-1.1.413.tgz'), plan.args.join(' ') + ' — planTarExtract in scripts/vendor/tarExtract.ts must pass the tarball by its bare file name')
  check('the destination is relative with forward slashes', plan.args.includes('../pyright.extracted.tmp-1'), plan.args.join(' ') + ' — planTarExtract in scripts/vendor/tarExtract.ts must give the destination relative to cwd with forward slashes')
  check('strip-components rides along', plan.args.join(' ').includes('--strip-components 1'), plan.args.join(' ') + ' — planTarExtract in scripts/vendor/tarExtract.ts must pass --strip-components with the stripComponents value')
  check('no --force-local on the happy path', !plan.forceLocal && !plan.args.includes('--force-local'), plan.args.join(' ') + ' — planTarExtract in scripts/vendor/tarExtract.ts must add --force-local only on the absolute-path fallback')
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
  check('cross-drive falls back to absolute + --force-local under GNU', gnu.forceLocal && gnu.args.includes('--force-local') && gnu.args.includes('C:\\a\\x.tgz'), gnu.args.join(' ') + ' — planTarExtract in scripts/vendor/tarExtract.ts must fall back to absolute paths plus --force-local when GNU tar gets a cross-drive pair')
  const bsd = helper.planTarExtract({
    tarballPath: 'C:\\a\\x.tgz',
    destDir: 'D:\\b\\out',
    stripComponents: 1,
    pathApi: path.win32,
    isGnuTar: () => false,
  })
  check('bsdtar never receives --force-local', !bsd.forceLocal && !bsd.args.includes('--force-local'), bsd.args.join(' ') + ' — planTarExtract in scripts/vendor/tarExtract.ts must not add --force-local unless isGnuTar says so')
  const weird = helper.planTarExtract({
    tarballPath: '/x/we:ird.tgz',
    destDir: '/x/out',
    isGnuTar: () => true,
  })
  check('a colon surviving in a file name takes the fallback too', weird.forceLocal && weird.args.includes('--force-local'), weird.args.join(' ') + ' — planTarExtract in scripts/vendor/tarExtract.ts must take the --force-local fallback when a file name still holds a colon')
}

console.log('[3] the census: every fetch script extracts through the one helper')
{
  const scripts = ['fetch-pyright.ts', 'fetch-js-debug.ts', 'fetch-grammars.ts', 'fetch-node.ts']
  for (const script of scripts) {
    const text = readFileSync(join(import.meta.dir, '..', 'vendor', script), 'utf8')
    check(`${script} imports the shared helper`, text.includes("from './tarExtract.ts'"), `scripts/vendor/${script} must extract through extractTarGz imported from ./tarExtract.ts`)
    check(`${script} spawns no bare tar`, !text.includes("spawnSync('tar'"), `a bare tar spawn remains — replace it in scripts/vendor/${script} with extractTarGz from ./tarExtract.ts`)
  }
  const debugpy = readFileSync(join(import.meta.dir, '..', 'vendor', 'fetch-debugpy.ts'), 'utf8')
  check('fetch-debugpy stays tar-free (the wheel route)', !debugpy.includes("spawnSync('tar'"), 'scripts/vendor/fetch-debugpy.ts must unpack the wheel without spawning tar')
}

console.log('[4] live: the faked dialect aborts the old shape, the helper extracts whole')
if (process.platform === 'win32') {
  console.log('not read on Windows: live tar dialect stand-in uses /usr/bin/tar and POSIX #!/bin/sh')
} else {
  const bin = join(scratch, 'bin')
  mkdirSync(bin, { recursive: true })
  const argvLog = join(scratch, 'argv.log')
  writeFileSync(
    join(bin, 'tar'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${argvLog}"\nfor a in "$@"; do\n  case "$a" in\n    --force-local) ;;\n    [A-Za-z]:*) printf 'tar (child): Cannot connect to %s: resolve failed\\n' "\${a%%:*}" >&2; exit 128 ;;\n  esac\ndone\nexec /usr/bin/tar "$@"\n`,
  )
  chmodSync(join(bin, 'tar'), 0o755)

  const stage = join(scratch, 'stage', 'package')
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'hello.txt'), 'vendored bytes\n')
  const tarball = join(scratch, 'fixture.tgz')
  const made = spawnSync('/usr/bin/tar', ['-czf', tarball, '-C', join(scratch, 'stage'), 'package'], { encoding: 'utf8' })
  check('the fixture tarball builds', made.status === 0, (made.stderr ?? '') + ' — this proof needs /usr/bin/tar to build its fixture tarball')

  const oldPath = process.env.PATH
  process.env.PATH = `${bin}:${oldPath ?? ''}`
  try {
    const control = spawnSync('tar', ['-xzf', 'C:\\repo\\vendor\\cache\\x.tgz', '-C', '/tmp/x'], { encoding: 'utf8', env: process.env })
    check('the control reproduces the field abort', control.status === 128 && /Cannot connect/.test(control.stderr ?? ''), `status ${String(control.status)} — the faked tar in this proof must exit 128 with Cannot connect on a drive-letter argument; the stand-in script written above is wrong`)

    rmSync(argvLog, { force: true })
    const dest = join(scratch, 'out')
    mkdirSync(dest, { recursive: true })
    const run = helper.extractTarGz({ tarballPath: tarball, destDir: dest, stripComponents: 1 })
    check('the helper extraction succeeds', run.ok === true, run.ok ? '' : run.message + ' — extractTarGz in scripts/vendor/tarExtract.ts must extract with the colon-free plan')
    check('the stripped payload landed', existsSync(join(dest, 'hello.txt')), 'extractTarGz in scripts/vendor/tarExtract.ts must honour stripComponents so hello.txt lands directly in destDir')
    const logged = existsSync(argvLog) ? readFileSync(argvLog, 'utf8').split('\n').filter(Boolean) : []
    check('the argv log is colon-free', logged.length > 0 && logged.every(a => !a.includes(':')), logged.join(' ') + ' — extractTarGz in scripts/vendor/tarExtract.ts must run tar with colon-free arguments')
    check('the argv log holds no absolute path', logged.every(a => !a.startsWith('/')), logged.join(' ') + ' — extractTarGz in scripts/vendor/tarExtract.ts must pass relative paths to tar')
  } finally {
    process.env.PATH = oldPath
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ VENDOR TAR DIALECT — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
