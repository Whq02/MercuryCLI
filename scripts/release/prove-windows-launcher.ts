#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { checkWindowsLauncher, preparedWindowsLauncher } from './windowsLauncher.mjs'
import { launcherFor, memberRole, readCompatFloor, releaseLayoutSection, topAllowlist } from './payloadContract.mjs'

const root = resolve(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'mercury-windows-launcher-'))
let failed = 0
let passed = 0
const check = (name: string, yes: boolean, detail?: string): void => {
  console.log(`${yes ? 'PASS' : 'FAIL'} ${name}`)
  if (!yes && detail !== undefined) console.log('  what to change: ' + detail)
  if (yes) passed++
  else failed++
}
const rejects = (act: () => unknown): boolean => { try { act(); return false } catch { return true } }
const sha = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
const targets = ['windows-x64', 'windows-arm64'] as const
try {
  const fixture = join(scratch, 'mercury.exe')
  writeFileSync(join(scratch, 'mercury.mjs'), 'fixture')
  for (const target of targets) {
    const pe = Buffer.alloc(512)
    pe.write('MZ')
    pe.writeUInt32LE(0x80, 0x3c)
    pe.writeUInt32LE(0x4550, 0x80)
    pe.writeUInt16LE(target === 'windows-x64' ? 0x8664 : 0xaa64, 0x84)
    pe.writeUInt16LE(2, 0x96)
    pe.writeUInt16LE(0x20b, 0x98)
    pe.writeUInt16LE(3, 0xdc)
    writeFileSync(fixture, pe)
    check(`${target}: synthetic console header is read`, checkWindowsLauncher(fixture, target).bytes === 512, 'checkWindowsLauncher in scripts/release/windowsLauncher.mjs must accept a console PE header for this target and report its byte length')
    check(`${target}: the other machine is refused`, rejects(() => checkWindowsLauncher(fixture, target === 'windows-x64' ? 'windows-arm64' : 'windows-x64')), 'checkWindowsLauncher in scripts/release/windowsLauncher.mjs must throw when the PE machine field does not match the requested target')
    const layout = releaseLayoutSection(scratch, target, readCompatFloor())
    const row = layout.members.find((m: { path: string }) => m.path === 'mercury.exe')
    check(`${target}: payload contract names and hashes the native launcher`, topAllowlist(target, readCompatFloor()).includes('mercury.exe') && row.role === 'launcher' && row.sha256 === sha(pe) && row.bytes === pe.length && memberRole('mercury.exe') === 'launcher', 'scripts/release/payloadContract.mjs must list mercury.exe in topAllowlist, give it role launcher through memberRole, and releaseLayoutSection must record its sha256 and byte count')
    check(`${target}: the stable command still selects CMD`, layout.launcher === 'mercury.cmd' && launcherFor(target) === 'mercury.cmd', 'releaseLayoutSection and launcherFor in scripts/release/payloadContract.mjs must keep mercury.cmd as the launcher for ' + target)
    pe.writeUInt16LE(2, 0xdc)
    writeFileSync(fixture, pe)
    check(`${target}: GUI subsystem is refused`, rejects(() => checkWindowsLauncher(fixture, target)), 'checkWindowsLauncher in scripts/release/windowsLauncher.mjs must throw when the PE subsystem is GUI (2) instead of console (3)')
    pe.writeUInt16LE(3, 0xdc)
    pe.writeUInt16LE(0x2002, 0x96)
    writeFileSync(fixture, pe)
    check(`${target}: DLL is refused`, rejects(() => checkWindowsLauncher(fixture, target)), 'checkWindowsLauncher in scripts/release/windowsLauncher.mjs must throw when the PE characteristics mark a DLL')
    if (existsSync(join(root, 'release-out', 'launchers', target, 'build.json'))) {
      const binary = preparedWindowsLauncher(root, target)
      const actual = checkWindowsLauncher(binary, target)
      check(`${target}: compiled launcher is a console PE with current source and binary digests (${actual.bytes} bytes)`, actual.bytes > 512, 'rebuild release-out/launchers/' + target + ' with scripts/release/windowsLauncher.mjs; preparedWindowsLauncher must return a console PE matching the current source and binary digests')
    } else {
      console.log(`SKIP ${target}: build the native executable with scripts/release/windowsLauncher.mjs to check compiled bytes`)
    }
  }
  for (const bytes of [Buffer.from('@echo off\r\n'), Buffer.from('MZ'), Buffer.alloc(96, 255)]) {
    writeFileSync(fixture, bytes)
    check('batch or truncated bytes renamed .exe are refused', rejects(() => checkWindowsLauncher(fixture, 'windows-x64')), 'checkWindowsLauncher in scripts/release/windowsLauncher.mjs must throw on bytes that are not a full PE (batch text, a bare MZ, 96 bytes of 255)')
  }
  const workflow = readFileSync(join(root, '.github/workflows/private-release.yml'), 'utf8')
  check('both Windows rows build and test the native launcher before packaging', workflow.includes('target: windows-x64') && workflow.includes('target: windows-arm64') && workflow.includes('cargo test --locked --manifest-path native/windows-launcher/Cargo.toml') && workflow.indexOf('node scripts/release/windowsLauncher.mjs --target') !== -1 && workflow.indexOf('node scripts/release/package.mjs --target') !== -1 && workflow.indexOf('node scripts/release/windowsLauncher.mjs --target') < workflow.indexOf('node scripts/release/package.mjs --target'), 'in .github/workflows/private-release.yml both Windows rows must run cargo test on native/windows-launcher and node scripts/release/windowsLauncher.mjs --target before node scripts/release/package.mjs --target')
  const args = process.argv.slice(2)
  const archives = args.flatMap((arg, i) => arg === '--archive' ? [resolve(args[i + 1]!)] : [])
  for (const archive of archives) {
    const target = targets.find(t => basename(archive).includes(t))
    if (!target) throw new Error(`archive name has no Windows target: ${archive}`)
    const dest = join(scratch, `${target}-archive`)
    const extract = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:PROOF_ARCHIVE -DestinationPath $env:PROOF_DEST'], { encoding: 'utf8', env: { ...process.env, PROOF_ARCHIVE: archive, PROOF_DEST: dest } })
      : spawnSync('unzip', ['-q', archive, '-d', dest], { encoding: 'utf8' })
    if (extract.status !== 0) throw new Error(extract.stderr || extract.error?.message || 'archive extraction failed')
    const payload = join(dest, 'mercury')
    const binary = join(payload, 'mercury.exe')
    const checked = checkWindowsLauncher(binary, target)
    const manifest = JSON.parse(readFileSync(join(payload, 'manifest.json'), 'utf8'))
    const member = manifest.releaseLayout.members.find((m: { path: string }) => m.path === 'mercury.exe')
    check(`${target}: the archive carries the native PE, CMD and PowerShell launchers`, checked.bytes > 512 && existsSync(join(payload, 'mercury.cmd')) && existsSync(join(payload, 'mercury.ps1')), 'scripts/release/package.mjs must put a console mercury.exe, mercury.cmd and mercury.ps1 in the archive payload')
    check(`${target}: the archive manifest binds the executable`, member.role === 'launcher' && member.sha256 === checked.sha256 && member.bytes === checked.bytes, 'scripts/release/package.mjs must write a manifest.json releaseLayout member for mercury.exe with role launcher and the executable sha256 and byte count')
    const verify = spawnSync('node', [join(root, 'scripts/release/verifyArchive.mjs'), '--archive', archive, '--expect', basename(archive).includes('-unsigned.') ? 'unsigned' : 'signed'], { encoding: 'utf8', timeout: 300_000 })
    check(`${target}: verifyArchive accepts the packaged archive`, verify.status === 0, 'scripts/release/verifyArchive.mjs rejected the archive; its output follows below')
    if (verify.status !== 0) console.error(verify.stdout, verify.stderr)
    const sums = join(scratch, `${target}-SHA256SUMS.txt`)
    writeFileSync(sums, targets.map(t => `${t === target ? sha(readFileSync(archive)) : '0'.repeat(64)}  mercury-v${manifest.version}-${t}.zip`).join('\n') + '\n')
    const manifests = spawnSync('node', [join(root, 'scripts/release/winget-manifest.mjs'), '--version', manifest.version, '--sums', sums, '--out', join(scratch, target), '--zip', archive], { encoding: 'utf8' })
    check(`${target}: WinGet generator accepts the zip and writes its three manifests`, manifests.status === 0 && ['.yaml', '.installer.yaml', '.locale.en-US.yaml'].every(suffix => existsSync(join(scratch, target, 'manifests/m/MercuryCLI/MercuryCLI', manifest.version, `MercuryCLI.MercuryCLI${suffix}`))), 'scripts/release/winget-manifest.mjs must exit 0 for the zip and write the .yaml, .installer.yaml and .locale.en-US.yaml manifests; its output follows below')
    if (manifests.status !== 0) console.error(manifests.stdout, manifests.stderr)
  }
  if (archives.length === 0) console.log('SKIP archive execution: pass --archive <package.mjs zip> for PE, manifest, verifier and WinGet checks')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
