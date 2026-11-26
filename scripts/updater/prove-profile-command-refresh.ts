#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'
import { hostAssetName, makeFixtures, makePayload, spawnFixtureReleaseServer } from './journeyFixtures.ts'

const TREE = resolve(import.meta.dir, '..', '..')
const SCENES = ['posix', 'windows-bytes'] as const
const at = process.argv.indexOf('--scene')

if (at < 0) {
  if (process.platform === 'win32') {
    console.log('prove-profile-command-refresh: [SKIP] the POSIX CLI and Mac-generated Windows byte scenes run on POSIX; Windows cmd.exe execution is walked on Windows')
    process.exit(0)
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'profile-refresh-')))
  let worst = 0
  try {
    for (const scene of SCENES) {
      const userHome = join(scratch, `${scene}-user`)
      mkdirSync(userHome, { recursive: true })
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: userHome,
        USERPROFILE: userHome,
        LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
        MERCURY_CREDENTIAL_STORE: 'file',
      }
      for (const name of ['MERCURY_HOME', 'MERCURY_VERSIONS_DIR', 'MERCURY_DAEMON_DIR', 'MERCURY_FAULT_INJECT']) delete env[name]
      const child = spawnSync(process.execPath, [import.meta.path, '--scene', scene, scratch, userHome], { stdio: 'inherit', env })
      if (child.status !== 0) worst = 1
    }
  } finally {
    removeScratch(scratch)
  }
  process.exit(worst)
}

const scene = process.argv[at + 1] ?? ''
const scratch = process.argv[at + 2] ?? ''
const userHome = process.argv[at + 3] ?? ''
if (scratch === '' || userHome === '' || homedir() !== userHome) {
  console.error(`prove-profile-command-refresh: SAFETY: scratch HOME ${userHome} not active (homedir=${homedir()})`)
  process.exit(1)
}
const assertUnderScratch = (path: string): void => {
  const rel = relative(resolve(scratch), resolve(path))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`prove-profile-command-refresh: SAFETY: path escapes scratch: ${path}`)
    process.exit(1)
  }
}

const configHome = join(scratch, `${scene}-H\u00e4user`)
assertUnderScratch(configHome)
mkdirSync(configHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = configHome

const { commandFiles, reconcileManagedCommands } = await import('../../src/platform/profiles/profiles.ts')
const { writeShimSet } = await import('../../src/platform/update-channel/installLayout.ts')
type LayoutRoots = import('../../src/platform/update-channel/installLayout.ts').LayoutRoots

let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (ok) passed++
  else failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail === '' ? '' : `${detail} — `}fix reconcileManagedCommands in src/platform/profiles/profiles.ts`}`)
}
const show = (value: unknown): string => JSON.stringify(value)
const stampOf = (path: string): string => {
  const st = lstatSync(path)
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`
}
const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

function spawnAsync(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolveRun => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('close', status => resolveRun({ status, stdout, stderr }))
  })
}

async function runPosixCliScene(): Promise<void> {
  console.log('── posix: real built CLI mercury update reconcile door, marker decides, outgoing guard, and dry-run ──')
  const staged = stageInstall('release', userHome)
  const versionsDir = join(staged.home, 'versions')
  const version = readFileSync(join(versionsDir, 'current.txt'), 'utf8').trim()
  const home2 = `${configHome}2`
  const home3 = `${configHome}3`
  const home4 = `${configHome}4`
  const home5 = `${configHome}5`
  for (const dir of [home2, home3, home4, home5]) {
    assertUnderScratch(dir)
    mkdirSync(dir, { recursive: true })
  }
  const keepFile = join(home2, 'keep-me.txt')
  writeFileSync(keepFile, 'keep-profile-2-state\n')
  writeFileSync(join(home2, 'profile.json'), `${JSON.stringify({ first: configHome, id: 2 })}\n`)
  writeFileSync(join(home3, 'profile.json'), `${JSON.stringify({ first: configHome, id: 3 })}\n`)
  writeFileSync(join(home4, 'profile.json'), `${JSON.stringify({ first: configHome, id: 4 })}\n`)
  writeFileSync(join(home5, 'profile.json'), `${JSON.stringify({ first: configHome, id: 5 })}\n`)
  const recordPath = join(configHome, 'profiles.json')
  const recordText = `${JSON.stringify({ profiles: [{ id: 2, name: 'Work' }, { id: 3 }, { id: 4 }, { id: 5 }] }, null, 2)}\n`
  writeFileSync(recordPath, recordText)

  const roots: LayoutRoots = { versionsDir, binDir: staged.bin, shimPath: staged.command, isWindows: false }
  const installDesc = { bin: roots.binDir, command: roots.shimPath, program: { MERCURY_VERSIONS_DIR: versionsDir }, isWindows: false, userHome }
  const expected2 = commandFiles(installDesc, 2, home2)[0]!
  const staleMarked2 = `#!/bin/sh\n# mercury-managed-profile 2\nMERCURY_CONFIG_DIR=${shQuote(home2)} exec ${shQuote(staged.command)} "$@"\n`
  const unmarked3 = `#!/bin/sh\n# custom user wrapper (marker removed)\nMERCURY_CONFIG_DIR=${shQuote(home3)} MERCURY_VERSIONS_DIR=${shQuote(versionsDir)} exec ${shQuote(staged.command)} "$@"\n`
  const linkTarget = join(scratch, 'posix-link-target')
  const word2 = join(staged.bin, 'mercury2')
  const word3 = join(staged.bin, 'mercury3')
  const word4 = join(staged.bin, 'mercury4')
  const word5 = join(staged.bin, 'mercury5')
  const word9 = join(staged.bin, 'mercury9')
  writeFileSync(word2, staleMarked2)
  chmodSync(word2, 0o755)
  writeFileSync(word3, unmarked3)
  chmodSync(word3, 0o755)
  writeFileSync(linkTarget, `#!/bin/sh\n# mercury-managed-profile 4\nexit 0\n`)
  symlinkSync(linkTarget, word4)
  const unreg9 = `#!/bin/sh\n# mercury-managed-profile 9\nexit 0\n`
  writeFileSync(word9, unreg9)
  chmodSync(word9, 0o755)

  const stamp3Before = stampOf(word3)
  const stamp9Before = stampOf(word9)
  const dryEnv: NodeJS.ProcessEnv = {
    ...staged.env,
    HOME: userHome,
    USERPROFILE: userHome,
    LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
    MERCURY_CONFIG_DIR: configHome,
    MERCURY_VERSIONS_DIR: versionsDir,
    PATH: `${staged.bin}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
  }
  const loginSource = async (command: string): Promise<string> => {
    const listed = await spawnAsync(command, ['auth', 'list', '--json'], dryEnv)
    if (listed.status !== 0) return ''
    const parsed = JSON.parse(listed.stdout) as { families: Array<{ id: string; signedIn: boolean; source: string }> }
    const row = parsed.families.find(family => family.id === 'anthropic')
    return row?.signedIn ? row.source : 'none'
  }
  const login1 = await spawnAsync(staged.command, ['auth', 'login', 'anthropic', '--key', 'sk-ant-refresh-one-00000000001111'], dryEnv)
  const login2 = await spawnAsync(word2, ['auth', 'login', 'anthropic', '--key', 'sk-ant-refresh-two-00000000002222'], dryEnv)
  check('file-store logins seed under both Profile 1 and Profile 2 before refresh', login1.status === 0 && login2.status === 0 && (await loginSource(staged.command)).includes('1111') && (await loginSource(word2)).includes('2222'))

  const word2BeforeDry = stampOf(word2)
  const dry = await spawnAsync(staged.command, ['install', '--dry-run'], dryEnv)
  check('mercury install --dry-run exits 0 and leaves stale mercury2 untouched', dry.status === 0 && readFileSync(word2, 'utf8') === staleMarked2 && stampOf(word2) === word2BeforeDry, show([dry.status, dry.stderr.slice(-200)]))

  const asset = hostAssetName(version)
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      assets: [
        { name: asset, browser_download_url: 'http://127.0.0.1:1/asset' },
        { name: 'SHA256SUMS.txt', browser_download_url: 'http://127.0.0.1:1/sums' },
      ],
    }]))
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const updateEnv: NodeJS.ProcessEnv = {
    ...dryEnv,
    MERCURY_UPDATE_API_BASE_URL: `http://127.0.0.1:${port}`,
    MERCURY_UPDATE_CHANNEL_REPO: 'fixture-owner/fixture-repo',
    MERCURY_GH_CMD: JSON.stringify([join(scratch, 'absent', 'gh')]),
  }
  try {
    const first = await spawnAsync(staged.command, ['update'], updateEnv)
    check('built mercury update (current) exits 0 and runs the reconcile door', first.status === 0 && first.stdout.includes(`Mercury is current: ${version}`), show([first.status, first.stdout, first.stderr.slice(-200)]))
    check('marked stale POSIX mercury2 becomes exact current commandFiles bytes with execute bit', readFileSync(word2, 'utf8') === expected2.text && (statSync(word2).mode & 0o777) === 0o755, show([readFileSync(word2, 'utf8'), (statSync(word2).mode & 0o777).toString(8)]))
    const stamp2AfterFirst = stampOf(word2)
    const second = await spawnAsync(staged.command, ['update'], updateEnv)
    check('second mercury update pass performs zero rewrite/mtime churn on current mercury2', second.status === 0 && stampOf(word2) === stamp2AfterFirst, show([stamp2AfterFirst, stampOf(word2)]))
    check('unmarked mercury3 (marker removed by user) stays untouched with zero writes', readFileSync(word3, 'utf8') === unmarked3 && stampOf(word3) === stamp3Before, show([stamp3Before, stampOf(word3)]))
    check('symlinked mercury4 stays a symlink and target stays untouched', lstatSync(word4).isSymbolicLink() && readFileSync(linkTarget, 'utf8').includes('# mercury-managed-profile 4'))
    check('intentionally deleted mercury5 stays absent', !existsSync(word5))
    check('unregistered mercury9 stays untouched', readFileSync(word9, 'utf8') === unreg9 && stampOf(word9) === stamp9Before)
    check('profile 2 home contents, labels and file-store credentials stay untouched after refresh', readFileSync(keepFile, 'utf8') === 'keep-profile-2-state\n' && readFileSync(recordPath, 'utf8') === recordText && (await loginSource(staged.command)).includes('1111') && (await loginSource(word2)).includes('2222'))

    const verRun = await spawnAsync(word2, ['--version'], dryEnv)
    check('refreshed mercury2 --version runs the installed build from the non-ASCII home', verRun.status === 0 && verRun.stdout.trim() === `Mercury ${version}`, show([verRun.status, verRun.stdout, verRun.stderr.slice(-200)]))
    const healthRun = await spawnAsync(word2, ['health', '--json'], dryEnv)
    const checks = healthRun.status === 0 ? (JSON.parse(healthRun.stdout) as { sections: Array<{ checks: Array<{ id: string; evidence?: string }> }> }).sections.flatMap(s => s.checks) : []
    const configEvidence = checks.find(row => row.id === 'config-home')?.evidence ?? ''
    check('refreshed mercury2 health --json names the non-ASCII second home', configEvidence.startsWith(`${home2} via `), show([healthRun.status, configEvidence]))
  } finally {
    server.close()
  }

  console.log('── posix: outgoing updater (v_old -> v_new) never writes old profile templates ──')
  const outScratch = join(scratch, 'outgoing')
  const outUser = join(outScratch, 'user')
  const outHome = join(outScratch, 'H\u00e4user')
  const outHome2 = `${outHome}2`
  const outVersions = join(outScratch, 'versions')
  const outBin = join(outUser, '.local', 'bin')
  const outFixtures = join(outScratch, 'fixtures')
  for (const dir of [outUser, outHome, outHome2, outVersions, outBin, outFixtures]) {
    assertUnderScratch(dir)
    mkdirSync(dir, { recursive: true })
  }
  const V_OLD = '9.9.0-beta.1'
  const V_NEW = '9.9.0-beta.2'
  makePayload(join(outVersions, V_OLD), V_OLD, { bundlePath: join(TREE, 'dist', 'mercury.mjs') })
  writeFileSync(join(outVersions, 'current.txt'), `${V_OLD}\n`)
  const outRoots: LayoutRoots = { versionsDir: outVersions, binDir: outBin, shimPath: join(outBin, 'mercury'), isWindows: false }
  writeShimSet(outRoots)
  writeFileSync(join(outHome, 'profiles.json'), `${JSON.stringify({ profiles: [{ id: 2 }] }, null, 2)}\n`)
  writeFileSync(join(outHome2, 'profile.json'), `${JSON.stringify({ first: outHome, id: 2 })}\n`)
  const outWord2 = join(outBin, 'mercury2')
  const outOld2 = `#!/bin/sh\n# mercury-managed-profile 2\nMERCURY_CONFIG_DIR=${shQuote(outHome2)} exec ${shQuote(outRoots.shimPath)} "$@"\n`
  writeFileSync(outWord2, outOld2)
  chmodSync(outWord2, 0o755)
  const outStampBefore = stampOf(outWord2)
  const fixturesDir = makeFixtures(outFixtures, 'upgrade', [{ version: V_NEW }])
  const fixtureServer = await spawnFixtureReleaseServer({ fixtures: fixturesDir })
  try {
    const outEnv: NodeJS.ProcessEnv = {
      PATH: `${outBin}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: outUser,
      USERPROFILE: outUser,
      LOCALAPPDATA: join(outUser, 'AppData', 'Local'),
      MERCURY_CONFIG_DIR: outHome,
      MERCURY_VERSIONS_DIR: outVersions,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_UPDATE_CHANNEL_REPO: 'fixture-owner/fixture-repo',
      MERCURY_UPDATE_API_BASE_URL: fixtureServer.url,
      MERCURY_GH_CMD: JSON.stringify([join(outScratch, 'absent', 'gh')]),
      TERM: 'dumb',
      CI: '1',
    }
    const upgraded = await spawnAsync(outRoots.shimPath, ['update', '--allow-unsigned'], outEnv)
    check('outgoing updater switches current.txt to v_new without rewriting mercury2 with v_old templates', upgraded.status === 0 && readFileSync(join(outVersions, 'current.txt'), 'utf8').trim() === V_NEW && readFileSync(outWord2, 'utf8') === outOld2 && stampOf(outWord2) === outStampBefore, show([upgraded.status, readFileSync(join(outVersions, 'current.txt'), 'utf8').trim(), upgraded.stderr.slice(-200)]))
  } finally {
    await fixtureServer.close()
  }
}

function runWindowsBytesScene(): void {
  console.log('── windows-bytes (Mac-generated Windows bytes, NOT Windows cmd.exe execution): SUBMIT 493 layout ──')
  const versionsDir = join(scratch, 'win-versions')
  const binDir = join(userHome, 'AppData', 'Local', 'Mercury', 'bin')
  const version = '1.1.0'
  const activeDir = join(versionsDir, version)
  const otherDir = join(versionsDir, '1.0.9')
  for (const dir of [activeDir, otherDir, binDir]) {
    assertUnderScratch(dir)
    mkdirSync(dir, { recursive: true })
  }
  const activeBundle = join(activeDir, 'mercury.mjs')
  const otherBundle = join(otherDir, 'mercury.mjs')
  writeFileSync(activeBundle, 'console.log("Mercury 1.1.0")\n')
  writeFileSync(otherBundle, 'console.log("Mercury 1.0.9")\n')
  writeFileSync(join(versionsDir, 'current.txt'), `${version}\n`)
  const winRoots: LayoutRoots = { versionsDir, binDir, shimPath: join(binDir, 'mercury.cmd'), isWindows: true }
  writeShimSet(winRoots)

  const homes = new Map<number, string>()
  for (const id of [2, 3, 4, 5]) {
    const dir = `${configHome}${id}`
    assertUnderScratch(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'profile.json'), `${JSON.stringify({ first: configHome, id })}\n`)
    homes.set(id, dir)
  }
  const keepFile = join(homes.get(2)!, 'keep-me.txt')
  writeFileSync(keepFile, 'keep-win-profile-2\n')
  const recordPath = join(configHome, 'profiles.json')
  const recordText = `${JSON.stringify({ profiles: [{ id: 2, name: 'Work' }, { id: 3 }, { id: 4 }, { id: 5 }] }, null, 2)}\n`
  writeFileSync(recordPath, recordText)

  const winInstall = { bin: binDir, command: winRoots.shimPath, program: { MERCURY_VERSIONS_DIR: versionsDir }, isWindows: true, userHome }
  const exp2 = commandFiles(winInstall, 2, homes.get(2)!)
  const staleCmd2 = [
    '@echo off',
    'rem mercury-managed-profile 2',
    'setlocal DisableDelayedExpansion',
    `set "MERCURY_CONFIG_DIR=${homes.get(2)!}"`,
    `set "MERCURY_VERSIONS_DIR=${versionsDir}"`,
    '"%~dp0mercury.cmd" %*',
    '',
  ].join('\r\n')
  const unmarkedCmd3 = [
    '@echo off',
    'rem user-owned script without managed marker',
    'setlocal DisableDelayedExpansion',
    `set "MERCURY_CONFIG_DIR=${homes.get(3)!}"`,
    `set "MERCURY_VERSIONS_DIR=${versionsDir}"`,
    '"%~dp0mercury.cmd" %*',
    '',
  ].join('\r\n')
  const unmarkedSh3 = `#!/bin/sh\n# user-owned\nMERCURY_CONFIG_DIR=${shQuote(homes.get(3)!)} exec "$(dirname "$0")/mercury" "$@"\n`
  const unmarkedPs13 = `\uFEFF# user-owned\r\nexit 0\r\n`

  const cmd2Path = join(binDir, 'mercury2.cmd')
  const sh2Path = join(binDir, 'mercury2')
  const ps12Path = join(binDir, 'mercury2.ps1')
  writeFileSync(cmd2Path, staleCmd2)
  writeFileSync(sh2Path, `#!/bin/sh\n# mercury-managed-profile 2\nMERCURY_CONFIG_DIR=${shQuote(homes.get(2)!)} exec "$(dirname "$0")/mercury" "$@"\n`)
  chmodSync(sh2Path, 0o644)
  writeFileSync(ps12Path, `# mercury-managed-profile 2\r\nexit 0\r\n`)
  writeFileSync(join(binDir, 'mercury3.cmd'), unmarkedCmd3)
  writeFileSync(join(binDir, 'mercury3'), unmarkedSh3)
  writeFileSync(join(binDir, 'mercury3.ps1'), unmarkedPs13)
  const linkTarget = join(scratch, 'win-link-target.cmd')
  writeFileSync(linkTarget, staleCmd2.replace('profile 2', 'profile 4'))
  symlinkSync(linkTarget, join(binDir, 'mercury4.cmd'))
  writeFileSync(join(binDir, 'mercury5.ps1'), `# mercury-managed-profile 5\r\nexit 0\r\n`)
  const unregPath = join(binDir, 'mercury9.cmd')
  writeFileSync(unregPath, staleCmd2.replace('profile 2', 'profile 9'))

  const stamp3 = [stampOf(join(binDir, 'mercury3.cmd')), stampOf(join(binDir, 'mercury3')), stampOf(join(binDir, 'mercury3.ps1'))]
  const stampUnreg = stampOf(unregPath)

  process.env.MERCURY_VERSIONS_DIR = versionsDir
  process.argv[1] = otherBundle
  reconcileManagedCommands(winRoots)
  check('non-active version (running != current.txt) leaves stale mercury2.cmd untouched', readFileSync(cmd2Path, 'utf8') === staleCmd2)

  process.argv[1] = activeBundle
  const out1 = reconcileManagedCommands(winRoots)
  const afterCmd2 = readFileSync(cmd2Path, 'utf8')
  check('SUBMIT 493: marked old 6ce324b43d mercury2.cmd becomes exact current commandFiles bytes (+23 bytes chcp 65001 >nul 2>nul)', out1 !== null && afterCmd2 === exp2[0]!.text && Buffer.byteLength(afterCmd2) - Buffer.byteLength(staleCmd2) === 23, show([Buffer.byteLength(staleCmd2), Buffer.byteLength(afterCmd2)]))
  check('marked stale Windows Git Bash mercury2 becomes exact current bytes with execute mode', readFileSync(sh2Path, 'utf8') === exp2[1]!.text && (statSync(sh2Path).mode & 0o777) === 0o755)
  check('marked stale Windows mercury2.ps1 becomes exact current bytes (BOM + CRLF + marker)', readFileSync(ps12Path, 'utf8') === exp2[2]!.text && readFileSync(ps12Path, 'utf8').startsWith('\uFEFF# mercury-managed-profile 2\r\n'))

  const stampsAfterFirst = [stampOf(cmd2Path), stampOf(sh2Path), stampOf(ps12Path)]
  reconcileManagedCommands(winRoots)
  check('second pass is a strict no-op (zero writes, zero mtime/inode churn on all three wrappers)', show([stampOf(cmd2Path), stampOf(sh2Path), stampOf(ps12Path)]) === show(stampsAfterFirst))

  const stamp3After = [stampOf(join(binDir, 'mercury3.cmd')), stampOf(join(binDir, 'mercury3')), stampOf(join(binDir, 'mercury3.ps1'))]
  check('unmarked .cmd, sh and .ps1 (marker absent) are preserved byte-for-byte with zero writes', readFileSync(join(binDir, 'mercury3.cmd'), 'utf8') === unmarkedCmd3 && readFileSync(join(binDir, 'mercury3'), 'utf8') === unmarkedSh3 && readFileSync(join(binDir, 'mercury3.ps1'), 'utf8') === unmarkedPs13 && show(stamp3After) === show(stamp3))
  check('symlinked mercury4.cmd stays a symlink and target stays untouched', lstatSync(join(binDir, 'mercury4.cmd')).isSymbolicLink() && readFileSync(linkTarget, 'utf8').includes('profile 4'))
  check('intentionally deleted mercury5.cmd stays absent while marked stale mercury5.ps1 refreshes', !existsSync(join(binDir, 'mercury5.cmd')) && readFileSync(join(binDir, 'mercury5.ps1'), 'utf8') === commandFiles(winInstall, 5, homes.get(5)!)[2]!.text)
  check('unregistered mercury9.cmd stays untouched', readFileSync(unregPath, 'utf8') === staleCmd2.replace('profile 2', 'profile 9') && stampOf(unregPath) === stampUnreg)
  check('profile 2 home contents and profiles.json labels stay untouched', readFileSync(keepFile, 'utf8') === 'keep-win-profile-2\n' && readFileSync(recordPath, 'utf8') === recordText)

  writeFileSync(cmd2Path, staleCmd2)
  process.env.MERCURY_FAULT_INJECT = 'rename:throw'
  try {
    reconcileManagedCommands(winRoots)
  } finally {
    delete process.env.MERCURY_FAULT_INJECT
  }
  const tmpLeft = readdirSync(binDir).filter(name => name.endsWith('.tmp'))
  check('rename failure leaves prior usable mercury2.cmd intact and sweeps temp files', readFileSync(cmd2Path, 'utf8') === staleCmd2 && tmpLeft.length === 0)
  reconcileManagedCommands(winRoots)
  check('next pass after transient failure refreshes mercury2.cmd cleanly', readFileSync(cmd2Path, 'utf8') === exp2[0]!.text)

  writeFileSync(cmd2Path, staleCmd2)
  writeFileSync(winRoots.shimPath, '@echo off\r\nrem operator custom mercury\r\n')
  reconcileManagedCommands(winRoots)
  check('foreign main shim leaves profile commands untouched', readFileSync(cmd2Path, 'utf8') === staleCmd2)
  rmSync(join(versionsDir, 'current.txt'), { force: true })
  check('unmanaged layout (no current.txt) returns null and leaves profile commands untouched', reconcileManagedCommands(winRoots) === null && readFileSync(cmd2Path, 'utf8') === staleCmd2)
}

console.log('============================================================')
console.log(` Profile command refresh — ${scene}`)
console.log('============================================================')
if (scene === 'posix') await runPosixCliScene()
else if (scene === 'windows-bytes') runWindowsBytesScene()
else failed++
console.log(`prove-profile-command-refresh (${scene}): ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
