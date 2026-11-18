import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  BASH_PACK_MANIFEST_FILE,
  BASH_PACK_NAME,
  bashMsys2LockMismatch,
  bashPackTreeDigest,
  checkBashPackDir,
  type BashMsys2Lock,
  type BashMsys2Manifest,
} from '../../src/utils/shell/bashPack.ts'

type Copy = { from: string; to: string }
type SourceCopy = { inner: string; member: string; to: string }

export type BashWinPackage = {
  name: string
  version: string
  file: string
  bytes: number
  sha256: string
  license: string
  licenseFiles: string[]
  source: { file: string; bytes: number; sha256: string }
  take: string[]
  copy?: Copy[]
  sourceCopy?: SourceCopy[]
}

export type BashWinLock = BashMsys2Lock & {
  name: string
  patchLevel: number
  license: string
  sourceNote: string
  platforms: Record<string, { kind?: string; target: string; binary?: string; runtime?: string; emulated?: boolean }>
  msys2: {
    bashVersion: string
    runtimeVersion: string
    repository: string
    sources: string
    recipes: string
    database: { file: string; bytes: number; sha256: string; readAt: string; packages: number }
    programsDir: string
    programs: string[]
    files: Record<string, string>
    packages: BashWinPackage[]
  }
}

const HEX64 = /^[0-9a-f]{64}$/

export function readBashWinLock(lockPath: string): BashWinLock {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as BashWinLock
  const block = lock.msys2
  if (lock.name !== BASH_PACK_NAME) throw new Error(`the lock names ${String(lock.name)}, not ${BASH_PACK_NAME}`)
  if (block === undefined || !Array.isArray(block.packages) || block.packages.length === 0) throw new Error('the lock carries no msys2 block with packages')
  if (!block.bashVersion.startsWith(`${lock.version}(`)) throw new Error(`the msys2 block pins bash ${block.bashVersion}, the lock's version is ${lock.version}`)
  for (const base of [block.repository, block.sources]) {
    if (!base.startsWith('https://') || base.endsWith('/')) throw new Error(`the msys2 block's address ${base} is not an https address without a trailing slash`)
  }
  if (!HEX64.test(block.database.sha256)) throw new Error('the msys2 block names no package database digest')
  for (const entry of block.packages) {
    if (!entry.file.endsWith('.pkg.tar.zst') || !HEX64.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw new Error(`the lock's ${entry.name} names no .pkg.tar.zst file with a size and a 64-hex sha256`)
    if (!entry.source.file.endsWith('.src.tar.zst') || !HEX64.test(entry.source.sha256) || !Number.isSafeInteger(entry.source.bytes) || entry.source.bytes <= 0) throw new Error(`the lock's ${entry.name} names no source package with a size and a 64-hex sha256`)
    if (entry.take.length === 0 || entry.licenseFiles.length === 0) throw new Error(`the lock's ${entry.name} takes no file or names no licence text`)
  }
  if (bashWinPlatforms(lock).length === 0) throw new Error('the lock names no platform of kind msys2')
  return lock
}

export function bashWinPlatforms(lock: BashWinLock): string[] {
  return Object.keys(lock.platforms).filter(platform => lock.platforms[platform]?.kind === 'msys2')
}

export type PinnedFile = { owner: string; file: string; path: string; url: string; bytes: number; sha256: string }

export function pinnedBashWinFiles(lock: BashWinLock, cacheDir: string, sources: 'needed' | 'all'): PinnedFile[] {
  const block = lock.msys2
  const out: PinnedFile[] = []
  for (const entry of block.packages) out.push({ owner: entry.name, file: entry.file, path: path.join(cacheDir, entry.file), url: `${block.repository}/${entry.file}`, bytes: entry.bytes, sha256: entry.sha256 })
  for (const entry of block.packages) {
    if (sources === 'needed' && entry.sourceCopy === undefined) continue
    out.push({ owner: entry.name, file: entry.source.file, path: path.join(cacheDir, 'src', entry.source.file), url: `${block.sources}/${entry.source.file}`, bytes: entry.source.bytes, sha256: entry.source.sha256 })
  }
  return out
}

export function measureFile(file: string): { bytes: number; sha256: string } | null {
  if (!existsSync(file)) return null
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(1 << 20)
  const fd = openSync(file, 'r')
  let bytes = 0
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
      bytes += read
    }
  } finally {
    closeSync(fd)
  }
  return { bytes, sha256: hash.digest('hex') }
}

export function pinnedFileFault(pinned: PinnedFile): string | null {
  const measured = measureFile(pinned.path)
  if (measured === null) return `${pinned.file} is not in the cache (${pinned.path})`
  if (measured.bytes !== pinned.bytes || measured.sha256 !== pinned.sha256) {
    return `${pinned.file} in the cache is ${measured.bytes} bytes with sha256 ${measured.sha256}; the lock pins ${pinned.bytes} bytes and ${pinned.sha256} — delete ${pinned.path} to download it again (if a fresh download reads the same, the package changed at its address and the lock must be read against MSYS2's database again)`
  }
  return null
}

type TarEntry = { path: string; type: string; body: Uint8Array; link: string }

function field(header: Uint8Array, start: number, length: number): string {
  let end = start
  while (end < start + length && header[end] !== 0) end++
  return new TextDecoder().decode(header.subarray(start, end))
}

function* tarEntries(buffer: Uint8Array): Generator<TarEntry> {
  const decoder = new TextDecoder()
  let offset = 0
  let extended: Record<string, string> = {}
  let longName: string | null = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156] ?? 48)
    const headerSize = parseInt(field(header, 124, 12).trim() || '0', 8)
    const size = type !== 'x' && type !== 'g' && type !== 'L' && extended.size !== undefined ? Number(extended.size) : headerSize
    const body = buffer.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'g') {
      const records: Record<string, string> = {}
      let at = 0
      while (at < body.length) {
        let space = at
        while (space < body.length && body[space] !== 0x20) space++
        const length = Number(decoder.decode(body.subarray(at, space)))
        if (!Number.isFinite(length) || length <= 0) break
        const record = decoder.decode(body.subarray(space + 1, at + length - 1))
        const equals = record.indexOf('=')
        records[record.slice(0, equals)] = record.slice(equals + 1)
        at += length
      }
      if (type === 'x') extended = records
      continue
    }
    if (type === 'L') {
      longName = decoder.decode(body).replace(/\0+$/, '')
      continue
    }
    const prefix = field(header, 345, 155)
    const name = field(header, 0, 100)
    yield { path: extended.path ?? longName ?? (prefix === '' ? name : `${prefix}/${name}`), type, body, link: extended.linkpath ?? field(header, 157, 100) }
    extended = {}
    longName = null
  }
}

export function tarFileMembers(buffer: Uint8Array): Array<{ path: string; body: Uint8Array }> {
  const entries = [...tarEntries(buffer)]
  const bodies = new Map(entries.filter(entry => entry.type === '0').map(entry => [entry.path, entry.body]))
  const out: Array<{ path: string; body: Uint8Array }> = []
  for (const entry of entries) {
    if (entry.type === '0') out.push({ path: entry.path, body: entry.body })
    if (entry.type !== '1' && entry.type !== '2') continue
    const target = entry.type === '1' ? entry.link : path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), entry.link))
    const body = bodies.get(target)
    if (body !== undefined) out.push({ path: entry.path, body })
  }
  return out
}

function matcher(patterns: string[]): (candidate: string) => boolean {
  const tests = patterns.map(pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`))
  return candidate => tests.some(test => test.test(candidate))
}

export type PeFile = { machine: string; imports: string[] }

export function readPe(data: Buffer): PeFile | null {
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) return null
  const pe = data.readUInt32LE(0x3c)
  if (pe + 24 > data.length || data.readUInt32LE(pe) !== 0x4550) return null
  const machineCode = data.readUInt16LE(pe + 4)
  const sectionCount = data.readUInt16LE(pe + 6)
  const optionalSize = data.readUInt16LE(pe + 20)
  const optional = pe + 24
  const directories = optional + (data.readUInt16LE(optional) === 0x20b ? 112 : 96)
  const importRva = data.readUInt32LE(directories + 8)
  const table = optional + optionalSize
  const sections: Array<{ address: number; size: number; raw: number }> = []
  for (let index = 0; index < sectionCount; index++) {
    const entry = table + index * 40
    sections.push({ address: data.readUInt32LE(entry + 12), size: Math.max(data.readUInt32LE(entry + 8), data.readUInt32LE(entry + 16)), raw: data.readUInt32LE(entry + 20) })
  }
  const offsetOf = (rva: number): number | null => {
    for (const section of sections) if (rva >= section.address && rva < section.address + section.size) return rva - section.address + section.raw
    return null
  }
  const imports: string[] = []
  let at = importRva === 0 ? null : offsetOf(importRva)
  while (at !== null && at + 20 <= data.length) {
    const nameRva = data.readUInt32LE(at + 12)
    if (nameRva === 0 && data.readUInt32LE(at + 16) === 0) break
    const nameAt = offsetOf(nameRva)
    if (nameAt === null) break
    imports.push(data.subarray(nameAt, data.indexOf(0, nameAt)).toString('latin1'))
    at += 20
  }
  return { machine: machineCode === 0x8664 ? 'x86_64' : machineCode === 0xaa64 ? 'arm64' : `0x${machineCode.toString(16)}`, imports }
}

function walk(dir: string, base: string = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

const inPack = (dir: string, rel: string): string => path.join(dir, ...rel.split('/'))

export function bashVersionInside(binary: Buffer): { version: string; machine: string | null } | null {
  const text = binary.toString('latin1')
  const said = /@\(#\)Bash version (\d+\.\d+\.\d+)\((\d+)\) release GNU/.exec(text)
  if (said === null) return null
  const machine = /\0(x86_64-pc-[a-z0-9]+|aarch64-pc-[a-z0-9]+)\0/.exec(text)
  return { version: `${said[1]}(${said[2]})-release`, machine: machine?.[1] ?? null }
}

export class BashWinPackRefused extends Error {
  readonly faults: string[]
  constructor(faults: string[]) {
    super(faults.join('\n'))
    this.faults = faults
  }
}

function sourceNoteText(lock: BashWinLock): string {
  const block = lock.msys2
  return [
    `GNU bash ${block.bashVersion} for Windows as MSYS2 packages it, with the POSIX runtime it needs (msys2-runtime ${block.runtimeVersion}) and the programs a command names beside it. The programs are x86_64; on Windows on Arm they run under the system's emulation.`,
    'Every file under usr/ is copied unchanged out of the MSYS2 binary package named below; etc/fstab and etc/nsswitch.conf are written by Mercury.',
    'Mercury starts these programs as separate processes and links none of them.',
    'The corresponding source of a package is the MSYS2 source package beside it: the upstream tarball, the recipe (PKGBUILD) and every patch MSYS2 applies.',
    `Recipes: ${block.recipes}. Package database: ${block.repository}/${block.database.file}, sha256 ${block.database.sha256}, read ${block.database.readAt}.`,
    'Laid out by scripts/vendor/fetch-bash-win.ts from vendor/bash.lock.json of the Mercury source tree (https://github.com/Whq02/MercuryCLI).',
    '',
    ...block.packages.flatMap(entry => [
      `${entry.name} ${entry.version}  (${entry.license})`,
      `  binary  ${block.repository}/${entry.file}  sha256 ${entry.sha256}`,
      `  source  ${block.sources}/${entry.source.file}  sha256 ${entry.source.sha256}  ${entry.source.bytes} bytes`,
      `  licence text  ${entry.licenseFiles.join('  ')}`,
    ]),
    '',
  ].join('\n')
}

export type LaidBashWinPack = { manifest: BashMsys2Manifest; files: number; bytes: number; programs: string[]; windowsLibraries: string[] }

export function layBashWinPack(args: { lock: BashWinLock; platform: string; cacheDir: string; destDir: string }): LaidBashWinPack {
  const { lock, platform, cacheDir, destDir } = args
  const block = lock.msys2
  const entry = lock.platforms[platform]
  if (entry === undefined || entry.kind !== 'msys2' || entry.binary === undefined || entry.runtime === undefined) throw new BashWinPackRefused([`the lock names no msys2 platform ${platform}`])
  const pinnedFaults = pinnedBashWinFiles(lock, cacheDir, 'needed').map(pinnedFileFault).filter((fault): fault is string => fault !== null)
  if (pinnedFaults.length > 0) throw new BashWinPackRefused(pinnedFaults)

  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  const faults: string[] = []
  const owners = new Map<string, string>()
  const write = (rel: string, body: Uint8Array | string, owner: string): void => {
    const target = inPack(destDir, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, body)
    owners.set(rel, owner)
  }
  for (const pkg of block.packages) {
    const wanted = matcher(pkg.take)
    const copies = new Map((pkg.copy ?? []).map(copy => [copy.from, copy.to]))
    const taken: string[] = []
    for (const member of tarFileMembers(Bun.zstdDecompressSync(readFileSync(path.join(cacheDir, pkg.file))))) {
      if (wanted(member.path)) {
        write(member.path, member.body, pkg.name)
        taken.push(member.path)
      }
      const to = copies.get(member.path)
      if (to !== undefined) {
        write(to, member.body, pkg.name)
        copies.delete(member.path)
      }
    }
    for (const pattern of pkg.take) if (!taken.some(matcher([pattern]))) faults.push(`${pkg.name}: nothing in ${pkg.file} matches ${pattern}`)
    for (const missing of copies.keys()) faults.push(`${pkg.name}: ${pkg.file} holds no ${missing}`)
    for (const copy of pkg.sourceCopy ?? []) {
      const inner = tarFileMembers(Bun.zstdDecompressSync(readFileSync(path.join(cacheDir, 'src', pkg.source.file)))).find(member => member.path === copy.inner)
      if (inner === undefined) {
        faults.push(`${pkg.name}: ${pkg.source.file} holds no ${copy.inner}`)
        continue
      }
      const innerName = `.inner-${path.posix.basename(copy.inner)}`
      writeFileSync(path.join(destDir, innerName), inner.body)
      const read = spawnSync('tar', ['-xOf', innerName, copy.member], { cwd: destDir, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
      rmSync(path.join(destDir, innerName), { force: true })
      if (read.status !== 0 || read.stdout.length === 0) faults.push(`${pkg.name}: tar read no ${copy.member} out of ${copy.inner} (exit ${String(read.status)})`)
      else write(copy.to, read.stdout, pkg.name)
    }
  }
  for (const [rel, body] of Object.entries(block.files)) write(rel, body, 'mercury')
  write(lock.sourceNote, sourceNoteText(lock), 'mercury')
  write(
    'NOTICES.json',
    `${JSON.stringify(
      block.packages.map(pkg => ({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        licenseFiles: pkg.licenseFiles,
        files: [...owners].filter(([, owner]) => owner === pkg.name).map(([rel]) => rel).sort(),
        binary: { url: `${block.repository}/${pkg.file}`, sha256: pkg.sha256 },
        source: { url: `${block.sources}/${pkg.source.file}`, sha256: pkg.source.sha256, bytes: pkg.source.bytes },
      })),
      null,
      2,
    )}\n`,
    'mercury',
  )

  const licenseFiles = [...new Set(block.packages.flatMap(pkg => pkg.licenseFiles))].sort()
  for (const file of licenseFiles) if (!existsSync(inPack(destDir, file))) faults.push(`the licence text ${file} is named by a package and is not in the pack`)

  const binaryPath = inPack(destDir, entry.binary)
  const runtimePath = inPack(destDir, entry.runtime)
  if (!existsSync(binaryPath)) faults.push(`the pack holds no ${entry.binary}`)
  if (!existsSync(runtimePath)) faults.push(`the pack holds no ${entry.runtime}`)
  const said = existsSync(binaryPath) ? bashVersionInside(readFileSync(binaryPath)) : null
  if (said === null) faults.push(`${entry.binary} carries no version line`)
  else {
    if (said.version !== block.bashVersion) faults.push(`${entry.binary} says ${said.version}; the lock pins ${block.bashVersion}`)
    if (said.machine !== entry.target) faults.push(`${entry.binary} names its machine ${String(said.machine)}; the lock says ${entry.target}`)
  }

  const all = walk(destDir)
  const peFiles = all.filter(rel => /\.(exe|dll)$/i.test(rel))
  const present = new Set(peFiles.map(rel => path.posix.basename(rel).toLowerCase()))
  const windowsLibraries = new Set<string>()
  for (const rel of peFiles) {
    const pe = readPe(readFileSync(inPack(destDir, rel)))
    if (pe === null) {
      faults.push(`${rel} is not a PE file`)
      continue
    }
    if (pe.machine !== 'x86_64') faults.push(`${rel} is a ${pe.machine} file; the pack is x86_64`)
    for (const library of pe.imports.map(name => name.toLowerCase())) {
      if (present.has(library)) continue
      if (library.startsWith('msys-') || library.startsWith('cyg')) faults.push(`${rel} imports ${library}, which the pack does not hold`)
      else windowsLibraries.add(library)
    }
  }
  const programsDir = inPack(destDir, block.programsDir)
  for (const rel of all.filter(candidate => candidate.startsWith(`${block.programsDir}/`) && !/\.(exe|dll)$/i.test(candidate))) {
    const first = readFileSync(inPack(destDir, rel), 'utf8').split('\n')[0] ?? ''
    const interpreter = first.startsWith('#!') ? (first.slice(2).trim().split(/\s+/)[0] ?? '') : ''
    const name = interpreter.replace(/^\/(usr\/)?bin\//, '')
    if (interpreter === '' || name.includes('/') || !existsSync(path.join(programsDir, `${name}.exe`))) faults.push(`${rel} starts with "${first}" and the pack holds no such interpreter`)
  }
  const programs = existsSync(programsDir)
    ? readdirSync(programsDir, { withFileTypes: true }).filter(item => item.isFile() && !/\.dll$/i.test(item.name)).map(item => item.name.replace(/\.exe$/i, '')).sort()
    : []
  for (const name of block.programs) if (!existsSync(path.join(programsDir, `${name}.exe`))) faults.push(`the lock promises ${name} and ${block.programsDir} holds no ${name}.exe`)
  if (faults.length > 0) {
    rmSync(destDir, { recursive: true, force: true })
    throw new BashWinPackRefused(faults)
  }

  const tree = bashPackTreeDigest(destDir)
  const manifest: BashMsys2Manifest = {
    name: BASH_PACK_NAME,
    source: 'msys2-packages',
    version: lock.version,
    patchLevel: lock.patchLevel,
    bashVersion: block.bashVersion,
    platform,
    target: entry.target,
    emulated: entry.emulated === true,
    binary: entry.binary,
    binarySha256: createHash('sha256').update(readFileSync(binaryPath)).digest('hex'),
    runtime: entry.runtime,
    runtimeVersion: block.runtimeVersion,
    runtimeSha256: createHash('sha256').update(readFileSync(runtimePath)).digest('hex'),
    programsDir: block.programsDir,
    programs,
    license: lock.license,
    licenseFiles,
    sourceNote: lock.sourceNote,
    packages: block.packages.map(pkg => ({ name: pkg.name, version: pkg.version, file: pkg.file, sha256: pkg.sha256, license: pkg.license, sourceFile: pkg.source.file, sourceSha256: pkg.source.sha256 })),
    databaseSha256: block.database.sha256,
    fileCount: tree.fileCount,
    treeDigest: tree.treeDigest,
  }
  writeFileSync(path.join(destDir, BASH_PACK_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  const bytes = all.reduce((sum, rel) => sum + statSync(inPack(destDir, rel)).size, 0)
  return { manifest, files: tree.fileCount, bytes, programs, windowsLibraries: [...windowsLibraries].sort() }
}

export function bashWinPackFault(dir: string, lock: BashWinLock, platform: string): string | null {
  const check = checkBashPackDir(dir, { digest: true, tree: true, platform })
  if (check.state !== 'ok') return check.note
  if (check.manifest.source !== 'msys2-packages') return `the pack at ${dir} is not laid out from MSYS2 packages`
  const drift = bashMsys2LockMismatch(check.manifest, lock, platform)
  if (drift !== null) return drift
  for (const [rel, body] of Object.entries(lock.msys2.files)) {
    const file = inPack(dir, rel)
    if (!existsSync(file) || readFileSync(file, 'utf8') !== body) return `${rel} in the pack is not the text the lock holds`
  }
  return null
}
