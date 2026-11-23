#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) console.log('    what to change: the shell row in runtimeChecks of src/platform/health/sections/runtime.ts so its evidence and fix match the record from shellRecord in src/platform/shell/shellRecord.ts and the tool:shell row from collectReadiness in src/platform/health/readiness.ts; the bundle checks run dist/mercury.mjs, so rebuild with `bun run build.ts` first')
}
const section = (title: string): void => console.log(`\n${title}`)
const flagAt = (flag: string): string | null => (process.argv.includes(flag) ? (process.argv[process.argv.indexOf(flag) + 1] ?? null) : null)

console.log('============================================================')
console.log(' The health row of the Bash tool shell says what the record says')
console.log('============================================================')

type Row = { status: string; evidence: string; fix?: string }
type Ready = { id: string; state: string; detail: string; remedy?: string }
type Cert = { sections?: Array<{ checks: Array<Row & { id: string }> }>; readiness?: Ready[] }
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shell-row-')))

function health(bundle: string, name: string, env: Record<string, string | undefined> = {}): { row: (Row & { id: string }) | undefined; ready: Ready | undefined; build: string; install: string; text: string } {
  const ran = spawnSync('node', [bundle, 'health', '--json'], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, name), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_SHELL_ENGINE: undefined, MERCURY_SHELL_PREFIX: undefined, MERCURY_GIT_BASH_PATH: undefined, MERCURY_WINDOWS_SHELL_ROAD: undefined, ...env },
  })
  try {
    const cert = JSON.parse(ran.stdout) as Cert
    const rows = cert.sections?.flatMap(part => part.checks) ?? []
    const said = (id: string): string => rows.find(row => row.id === id)?.evidence ?? ''
    return { row: rows.find(row => row.id === 'shell'), ready: cert.readiness?.find(row => row.id === 'tool:shell'), build: said('build-identity'), install: said('install-provenance'), text: '' }
  } catch {
    return { row: undefined, ready: undefined, build: '', install: '', text: `status ${String(ran.status)} · ${(ran.stderr ?? '').slice(-300)}` }
  }
}

const source = (rel: string): string => join(ROOT, rel).replace(/\\/g, '\\\\')
const BOTH = `
  ;(globalThis).MACRO = { VERSION: '1.0.0' }
  const config = await import('${source('src/platform/settings/config.ts')}')
  config.enableConfigs()
  const { runtimeChecks } = await import('${source('src/platform/health/sections/runtime.ts')}')
  const row = await runtimeChecks().find(spec => spec.id === 'shell')?.run()
  const readiness = await import('${source('src/platform/health/readiness.ts')}')
  console.log('BOTH ' + JSON.stringify({ row, ready: readiness.collectReadiness({ includeEnv: false }).records.find(found => found.id === 'tool:shell') }))
  process.exit(0)
`

function bothFromSource(name: string, env: Record<string, string | undefined>): { row: Row | undefined; ready: Ready | undefined; text: string } {
  const ran = spawnSync(process.execPath, ['-e', BOTH], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, name), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_SHELL_ENGINE: undefined, MERCURY_SHELL_PREFIX: undefined, MERCURY_GIT_BASH_PATH: undefined, MERCURY_WINDOWS_SHELL_ROAD: undefined, BASH_ENV: undefined, ENV: undefined, ...env },
  })
  const line = (ran.stdout ?? '').split('\n').find(text => text.startsWith('BOTH '))
  if (line === undefined) return { row: undefined, ready: undefined, text: `status ${String(ran.status)} · ${(ran.stderr ?? '').slice(-300)}` }
  const both = JSON.parse(line.slice(5)) as { row?: Row; ready?: Ready }
  return { row: both.row, ready: both.ready, text: '' }
}

const same = (pair: { row: Row | undefined; ready: Ready | undefined }): boolean => pair.row !== undefined && pair.ready !== undefined && pair.ready.detail === pair.row.evidence && pair.ready.remedy === pair.row.fix
const POSIX = process.platform !== 'win32'
const emptyHome = join(scratch, 'home-with-no-login-file')
const handsOverHome = join(scratch, 'home-whose-login-file-ends-the-shell')
const pin = join(scratch, 'pinned-no-bash')
if (POSIX) {
  mkdirSync(emptyHome)
  mkdirSync(handsOverHome)
  writeFileSync(join(handsOverHome, '.bash_profile'), 'exit 0\n')
  writeFileSync(pin, '#!/bin/sh\nexit 0\n')
  chmodSync(pin, 0o755)
}
const PASSED_PIN = `passed over: ${pin}, named by MERCURY_GIT_BASH_PATH, did not answer as a bash`
const NOT_CARRIED = 'nothing the bash login files define is carried: '

try {
  section('(1) the row, asked in this process')
  {
    const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
    const record = await import('../../src/platform/shell/shellRecord.ts')
    const row = (await runtimeChecks().find(spec => spec.id === 'shell')?.run()) as Row | undefined
    const served = await record.shellRecord()
    check('the row names the path of the shell the record names', row !== undefined && row.evidence.includes(served.path), JSON.stringify({ row, served }))
    check('…and its version', row !== undefined && served.version !== '' && row.evidence.includes(served.version), JSON.stringify({ row, served }))
    check('…and no zsh: neither a zsh as the shell that runs nor the words "bash or zsh"', row !== undefined && !/zsh[^/]* — /i.test(row.evidence) && !row.evidence.includes('bash or zsh'), row?.evidence)
    const ownLoginFiles = row !== undefined && row.status === 'warn' && row.evidence.includes('nothing the bash login files define is carried: ')
    check("the bash Mercury ships reads ok, or warns that this machine's own login files are not carried; any other shell is a warning, with what to change where a pack is skipped", row !== undefined && (served.origin === 'shipped' ? (row.status === 'ok' && row.fix === undefined) || ownLoginFiles : row.status === 'warn' || (row.status === 'ok' && /MERCURY_SHELL_ENGINE|Shell engine setting/.test(row.evidence))), JSON.stringify(row))
    if (!POSIX) {
      console.log('  [SKIP] the stand-in program and the login file of the next rows are for a machine with sh')
    } else {
      const passed = bothFromSource('pin-passed-over', { HOME: emptyHome, MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: pin })
      check('with a pin passed over, the readiness row tool:shell says what the health row says, what was passed over among it', same(passed) && (passed.row?.evidence ?? '').includes(PASSED_PIN), JSON.stringify(passed))
      const none = bothFromSource('no-shell', { HOME: emptyHome, MERCURY_WINDOWS_SHELL_ROAD: 'no-bash', MERCURY_SHELL_ENGINE: 'system' })
      check('where nothing serves, both say so in the same words with the same fix, and the readiness row reads unavailable', same(none) && none.row?.status === 'warn' && none.ready?.state === 'unavailable' && none.row.evidence.includes('passed over: '), JSON.stringify(none))
      const handsOver = bothFromSource('hands-over', { HOME: handsOverHome })
      check('where nothing of the login files is carried, both say so in the same words, with the same change to make', same(handsOver) && (served.origin === 'engine' || (handsOver.row?.evidence ?? '').includes(NOT_CARRIED)), JSON.stringify(handsOver))
    }
  }

  section('(2) the built bundle')
  {
    const bundle = join(ROOT, 'dist', 'mercury.mjs')
    if (!existsSync(bundle)) {
      console.log('  [SKIP] dist/mercury.mjs absent — build first (the gate prebuilds)')
    } else {
      const own = health(bundle, 'own')
      check('health --json carries the row, naming a bash with its version, or the engine', own.row !== undefined && /^(?:bash \d+\.\d+|brush \d+\.\d+|the (?:bundled )?shell engine at )/.test(own.row.evidence), JSON.stringify(own.row) + own.text)
      check('…and the readiness row tool:shell is there beside it', own.ready !== undefined && own.ready.detail.length > 0, JSON.stringify(own.ready))
      check('…and says what the health row says: the same words and the same fix', same(own), JSON.stringify({ row: own.row, ready: own.ready }))
      if (POSIX) {
        const passed = health(bundle, 'bundle-pin', { HOME: emptyHome, MERCURY_WINDOWS_SHELL_ROAD: 'locate', MERCURY_GIT_BASH_PATH: pin })
        check('with a pin passed over, the two rows of health --json say the same, what was passed over among it', same(passed) && (passed.row?.evidence ?? '').includes(PASSED_PIN), JSON.stringify({ row: passed.row, ready: passed.ready }) + passed.text)
        const withoutThePack = (view: string): string => {
          mkdirSync(join(view, 'vendor'), { recursive: true })
          for (const name of readdirSync(dirname(bundle))) {
            if (name !== 'vendor' && lstatSync(join(dirname(bundle), name)).isFile()) copyFileSync(join(dirname(bundle), name), join(view, name))
          }
          for (const name of readdirSync(join(dirname(bundle), 'vendor'))) {
            if (name !== 'bash') symlinkSync(join(dirname(bundle), 'vendor', name), join(view, 'vendor', name))
          }
          return join(view, 'mercury.mjs')
        }
        const bare = health(withoutThePack(join(scratch, 'dist-without-the-pack')), 'bundle-no-pack', { HOME: emptyHome })
        check('with the bash pack gone from beside the bundle, the two rows say the same, and both name the skipped pack as what to mend', same(bare) && (bare.row?.fix ?? '').startsWith('The bash pack is skipped in this install:'), JSON.stringify({ row: bare.row, ready: bare.ready }) + bare.text)
        const REMEDY = ' · the remedy of the absent pack is chosen by resolveBashPackDir in src/platform/shell/bashPack.ts: the install command for a packaged install that stands in a versions folder beside its current.txt and whose build carried the pack; the command that makes the pack everywhere else'
        const bareSays = `${bare.row?.evidence ?? ''} | ${bare.row?.fix ?? ''}`
        check('…a packaged copy run in place, with no versions folder around it, keeps the command that makes the pack', bare.build.includes('packaged-install') && /\(prepare it: bun run scripts\/vendor\/build-bash\.ts \(needs [^)]+\), then rebuild\)$/.test(bare.row?.fix ?? '') && !bareSays.includes('reinstall Mercury'), bareSays + REMEDY)
        const { mercuryInstallUpdateCommand } = await import('../../src/platform/host-os/words.ts')
        const version = (JSON.parse(readFileSync(join(dirname(bundle), 'manifest.json'), 'utf8')) as { version: string }).version
        const versions = join(scratch, 'versions')
        const installedBundle = withoutThePack(join(versions, version))
        writeFileSync(join(versions, 'current.txt'), `${version}\n`)
        const installed = health(installedBundle, 'managed-no-pack', { HOME: emptyHome, MERCURY_VERSIONS_DIR: versions })
        const reinstall = `(reinstall Mercury to restore it: ${mercuryInstallUpdateCommand(installedBundle)})`
        const installedSays = `${installed.row?.evidence ?? ''} | ${installed.row?.fix ?? ''}`
        check('a managed install whose bash pack is gone: the certificate itself reads it as a packaged install that mercury install manages', installed.build.includes('packaged-install') && installed.install.startsWith(`managed ${version} at `), JSON.stringify({ build: installed.build, install: installed.install }) + installed.text)
        check('…its two rows say the same', same(installed), JSON.stringify({ row: installed.row, ready: installed.ready }) + REMEDY)
        check('…and both give the remedy an installed user can follow: the install command, in the evidence and at the end of the fix', (installed.row?.evidence ?? '').includes(reinstall) && (installed.row?.fix ?? '').startsWith('The bash pack is skipped in this install:') && (installed.row?.fix ?? '').endsWith(reinstall), installedSays + REMEDY)
        check('…and name no script of a checkout and no rebuild', installedSays.length > 3 && !/scripts\/vendor\/|then rebuild/.test(installedSays), installedSays + REMEDY)
        const skippedBundle = withoutThePack(join(scratch, 'packaged-from-a-build-without-the-pack'))
        const skippedManifest = join(dirname(skippedBundle), 'manifest.json')
        writeFileSync(skippedManifest, JSON.stringify({ ...(JSON.parse(readFileSync(skippedManifest, 'utf8')) as object), bash: { vendored: false } }))
        const skipped = health(skippedBundle, 'packaged-build-no-pack', { HOME: emptyHome })
        const skippedSays = `${skipped.row?.evidence ?? ''} | ${skipped.row?.fix ?? ''}`
        check('a packaged build whose own record says it was made without the pack keeps the command that makes it', skipped.build.includes('packaged-install') && same(skipped) && /\(prepare it: bun run scripts\/vendor\/build-bash\.ts \(needs [^)]+\), then rebuild\)$/.test(skipped.row?.fix ?? '') && !skippedSays.includes('reinstall Mercury'), skippedSays + REMEDY)
        const checkout = join(scratch, 'checkout')
        const builtBundle = withoutThePack(join(checkout, 'dist'))
        writeFileSync(join(checkout, 'build.ts'), '')
        for (const marker of ['src', '.git']) mkdirSync(join(checkout, marker))
        const built = health(builtBundle, 'checkout-no-pack', { HOME: emptyHome })
        const builtSays = `${built.row?.evidence ?? ''} | ${built.row?.fix ?? ''}`
        check('a build in a checkout that holds no bash pack: the certificate itself reads it as a source build', built.build.includes('source-build') && built.install.startsWith('development '), JSON.stringify({ build: built.build, install: built.install }) + built.text)
        check('…its two rows say the same, and the remedy stays the command that makes the pack, then a rebuild', same(built) && /\(prepare it: bun run scripts\/vendor\/build-bash\.ts \(needs [^)]+\), then rebuild\)$/.test(built.row?.fix ?? '') && !builtSays.includes('reinstall Mercury'), builtSays + REMEDY)
        const handsOver = health(bundle, 'bundle-hands-over', { HOME: handsOverHome })
        check('where nothing of the login files is carried, the two rows say the same, with the same change to make', same(handsOver) && (handsOver.row?.evidence ?? '').includes(NOT_CARRIED), JSON.stringify({ row: handsOver.row, ready: handsOver.ready }) + handsOver.text)
      }
      const engine = health(bundle, 'engine', { MERCURY_SHELL_ENGINE: 'brush' })
      check('with the engine pinned the row names the engine and the pin, and stays ok where its pack is', engine.row !== undefined && (/brush/.test(engine.row.evidence) ? engine.row.status === 'ok' && engine.row.evidence.includes('MERCURY_SHELL_ENGINE') : engine.row.evidence.length > 0), JSON.stringify(engine.row) + engine.text)
    }
  }

  section('(3) an install whose bash pack was skipped')
  {
    const dist = flagAt('--no-pack-dist')
    if (dist === null) {
      console.log('  [SKIP] no --no-pack-dist <a dist built outside a checkout with MERCURY_BUILD_NO_VENDOR_BASH=1>: the skipped pack is read where one is named')
    } else {
      const bare = health(join(dist, 'mercury.mjs'), 'no-pack')
      check('the row warns, and names the shell that runs instead with its version', bare.row?.status === 'warn' && /^(?:bash \d+\.\d+|brush \d+\.\d+)/.test(bare.row.evidence), JSON.stringify(bare.row) + bare.text)
      check('…and its fix names the skipped pack and the command that makes it', (bare.row?.fix ?? '').startsWith('The bash pack is skipped in this install:') && /scripts\/vendor\/(?:build-bash|fetch-bash-win)\.ts/.test(bare.row?.fix ?? ''), String(bare.row?.fix))
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-shell-row-reads-the-record: ALL LAWS HOLD' : `\nprove-shell-row-reads-the-record: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
