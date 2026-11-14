import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyRelease } from '../../nix/verify-release.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SYSTEMS = {
  'x86_64-linux': 'linux-x64',
  'aarch64-linux': 'linux-arm64',
  'x86_64-darwin': 'macos-x64',
  'aarch64-darwin': 'macos-arm64',
}

export function releasePins(version, sums, archiveNameFor) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) throw new Error('version must name a Mercury release')
  const records = new Map()
  for (const line of sums.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const row = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line)
    if (!row) throw new Error('the release checksum file has a malformed row')
    if (records.has(row[2])) throw new Error(`the release checksum file repeats ${row[2]}`)
    records.set(row[2], row[1].toLowerCase())
  }
  const systems = {}
  for (const [system, target] of Object.entries(SYSTEMS)) {
    const name = archiveNameFor(version, target)
    const sha256 = records.get(name)
    if (!sha256) throw new Error(`the release checksum file has no ${name}`)
    systems[system] = { target, url: `https://github.com/Whq02/MercuryCLI/releases/download/v${version}/${name}`, sha256 }
  }
  return { version, systems }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function refreshNixReleasePins({ version, archives, sums, out, owner, check = false }) {
  const pins = releasePins(version, readFileSync(sums, 'utf8'), owner.archiveNameFor)
  const scratch = mkdtempSync(join(tmpdir(), 'mercury-nix-release-'))
  try {
    for (const [system, pin] of Object.entries(pins.systems)) {
      const name = owner.archiveNameFor(version, pin.target)
      const archive = join(archives, name)
      if (!existsSync(archive)) throw new Error(`missing finalized archive ${name}`)
      if (await sha256File(archive) !== pin.sha256) throw new Error(`SHA-256 mismatch for ${name}`)
      const unpacked = join(scratch, system)
      mkdirSync(unpacked)
      const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
      if (listing.status !== 0 || listing.stdout.split(/\r?\n/).filter(Boolean).some(name => !/^mercury(?:\/|$)/.test(name) || name.split('/').includes('..'))) throw new Error(`unexpected archive envelope in ${name}`)
      const extracted = spawnSync('tar', ['-xzf', archive, '-C', unpacked], { encoding: 'utf8' })
      if (extracted.status !== 0 || readdirSync(unpacked).join() !== 'mercury') throw new Error(`could not extract the mercury envelope in ${name}`)
      await verifyRelease(join(unpacked, 'mercury'), version, pin.target)
    }
    const text = JSON.stringify(pins, null, 2) + '\n'
    if (check) {
      if (!existsSync(out) || readFileSync(out, 'utf8') !== text) throw new Error('the Nix release pins differ from the finalized release')
    } else {
      const temporary = `${out}.tmp-${process.pid}`
      mkdirSync(dirname(out), { recursive: true })
      try {
        writeFileSync(temporary, text, { flag: 'wx' })
        renameSync(temporary, out)
      } finally { rmSync(temporary, { force: true }) }
    }
    return pins
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

async function main() {
  const args = process.argv.slice(2)
  const option = name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1] }
  if (args.includes('--help')) {
    console.log('node scripts/release/refresh-nix-release-pins.mjs --version <version> --archives <finalized release directory> [--sums <SHA256SUMS.txt>] [--out <nix/release.json>] [--check]')
    return
  }
  const version = option('--version')
  const archives = option('--archives')
  if (!version || !archives) throw new Error('--version and --archives are required; run --help for the release step')
  const owner = await import(pathToFileURL(join(ROOT, 'dist/verify-artifact.mjs')).href)
  const pins = await refreshNixReleasePins({ version, archives: resolve(archives), sums: resolve(option('--sums') ?? join(archives, 'SHA256SUMS.txt')), out: resolve(option('--out') ?? join(ROOT, 'nix/release.json')), owner, check: args.includes('--check') })
  console.log(`refresh-nix-release-pins: ${pins.version}, four signed archives verified; pins ${args.includes('--check') ? 'match' : 'written'}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
