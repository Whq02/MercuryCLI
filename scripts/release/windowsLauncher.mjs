import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const targets = { 'windows-x64': ['x86_64-pc-windows-msvc', 0x8664], 'windows-arm64': ['aarch64-pc-windows-msvc', 0xaa64] }
const sources = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'policy.mjs', 'src/main.rs'].map(p => `native/windows-launcher/${p}`)
  .concat(['package.json', 'scripts/release/windowsLauncher.mjs', 'scripts/release/launcherTemplates.mjs', 'src/main.tsx', 'src/entrypoints/cli.tsx'])
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceDigest = root => digest(sources.map(p => `${p}\n${digest(readFileSync(join(root, p)))}\n`).join(''))

export function checkWindowsLauncher(file, target) {
  const expected = targets[target]
  if (!expected) throw new Error(`unknown Windows launcher target: ${target}`)
  const bytes = readFileSync(file)
  const bad = reason => { throw new Error(`${file}: ${reason}`) }
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') bad('not a PE image (missing MZ header)')
  const pe = bytes.readUInt32LE(0x3c)
  if (pe < 64 || pe + 96 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) bad('invalid PE header')
  const machine = bytes.readUInt16LE(pe + 4)
  if (machine !== expected[1]) bad(`machine 0x${machine.toString(16)} does not match ${target}`)
  const flags = bytes.readUInt16LE(pe + 22)
  if (!(flags & 2) || (flags & 0x2000)) bad('not an executable image')
  if (bytes.readUInt16LE(pe + 24) !== 0x20b) bad('not a PE32+ image')
  if (bytes.readUInt16LE(pe + 24 + 68) !== 3) bad('not a console subsystem image')
  return { target, machine, bytes: bytes.length, sha256: digest(bytes) }
}

export function preparedWindowsLauncher(root, target) {
  const dir = join(root, 'release-out', 'launchers', target)
  const record = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'))
  const binary = join(dir, 'mercury.exe')
  const checked = checkWindowsLauncher(binary, target)
  if (record.sourceDigest !== sourceDigest(root) || record.sha256 !== checked.sha256) {
    throw new Error(`the ${target} launcher is stale; run node scripts/release/windowsLauncher.mjs --target ${target}`)
  }
  return binary
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const target = args[args.indexOf('--target') + 1]
  const triple = targets[target]?.[0]
  if (!args.includes('--target') || !triple) throw new Error('use --target windows-x64 or --target windows-arm64')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const targetDir = resolve(process.env.CARGO_TARGET_DIR ?? join(root, 'release-out', 'launcher-build'))
  const flags = `${process.env.RUSTFLAGS ?? ''} -C target-feature=+crt-static --remap-path-prefix=${root}=.`
  const built = spawnSync('cargo', [
    ...(args.includes('--cross') ? ['xwin'] : []), 'build', '--locked', '--release',
    '--manifest-path', join(root, 'native', 'windows-launcher', 'Cargo.toml'),
    '--target', triple, '--target-dir', targetDir,
  ], { cwd: root, stdio: 'inherit', env: { ...process.env, RUSTFLAGS: flags } })
  if (built.status !== 0) throw new Error(`Windows launcher build failed: ${built.error?.message ?? built.status}`)
  const binary = join(targetDir, triple, 'release', 'mercury.exe')
  const checked = checkWindowsLauncher(binary, target)
  const dir = join(root, 'release-out', 'launchers', target)
  mkdirSync(dir, { recursive: true })
  copyFileSync(binary, join(dir, 'mercury.exe'))
  writeFileSync(join(dir, 'build.json'), JSON.stringify({ ...checked, sourceDigest: sourceDigest(root) }, null, 2) + '\n')
  console.log(`${target}: mercury.exe (${checked.bytes} bytes, sha256 ${checked.sha256})`)
}
