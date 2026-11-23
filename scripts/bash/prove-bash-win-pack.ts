#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BASH_PACK_MANIFEST_FILE, BASH_PACK_PATH, bashPackIsFetched, bashPackTreeDigest, checkBashPackDir, readBashPackManifest } from '../../src/platform/shell/bashPack.ts'
import { BashWinPackRefused, bashVersionInside, bashWinPackFault, bashWinPlatforms, bunzip2, layBashWinPack, memberOfBzip2Tar, pinnedBashWinFiles, pinnedFileFault, readBashWinLock, readPe } from '../vendor/lay-bash-win-pack.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const PACK_ROOT = join(ROOT, ...BASH_PACK_PATH.split('/'))
const CACHE = join(PACK_ROOT, 'archive', 'msys2')
const FETCH = join(ROOT, 'scripts', 'vendor', 'fetch-bash-win.ts')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const HEX64 = /^[0-9a-f]{64}$/

console.log('============================================================')
console.log(' The bash pack for Windows: what the lock pins is what is laid out')
console.log('============================================================')

const lock = readBashWinLock(join(ROOT, 'vendor', 'bash.lock.json'))
const block = lock.msys2
const platforms = bashWinPlatforms(lock)

section('(1) the lock')
check('the lock names two fetched platforms, win-x64 and win-arm64, and the door calls both fetched', JSON.stringify(platforms) === JSON.stringify(['win-x64', 'win-arm64']) && platforms.every(bashPackIsFetched), platforms.join(' '))
check('both name the same binary, runtime and machine, and only the Arm one says its programs are emulated', lock.platforms['win-x64']!.binary === lock.platforms['win-arm64']!.binary && lock.platforms['win-x64']!.runtime === lock.platforms['win-arm64']!.runtime && lock.platforms['win-x64']!.target === lock.platforms['win-arm64']!.target && lock.platforms['win-x64']!.emulated !== true && lock.platforms['win-arm64']!.emulated === true, JSON.stringify(lock.platforms['win-arm64']))
check(`the bash it pins is the lock's own version at MSYS2's build of it: ${block.bashVersion}`, block.bashVersion.startsWith(`${lock.version}(`) && block.bashVersion.endsWith(')-release'), block.bashVersion)
check(
  `every package is pinned by file name, size and sha256, beside its source package with size and sha256: ${block.packages.length}`,
  block.packages.length === 19 && block.packages.every(entry => entry.file.endsWith('-x86_64.pkg.tar.zst') && entry.file.startsWith(`${entry.name}-`) && entry.bytes > 0 && HEX64.test(entry.sha256) && entry.source.file.endsWith('.src.tar.zst') && entry.source.bytes > 0 && HEX64.test(entry.source.sha256)),
  block.packages.filter(entry => !HEX64.test(entry.sha256)).map(entry => entry.name).join(' '),
)
check('no package is named twice and every one names a licence and its text', new Set(block.packages.map(entry => entry.name)).size === block.packages.length && block.packages.every(entry => entry.license !== '' && entry.licenseFiles.length > 0 && entry.licenseFiles.every(file => file.startsWith('licenses/'))))
check('the packages come over https from one repository, the sources from one more, and the database they were read from is named by its sha256', block.repository.startsWith('https://') && block.sources.startsWith('https://') && HEX64.test(block.database.sha256) && /^\d{4}-\d{2}-\d{2}T/.test(block.database.readAt), `${block.repository} ${block.sources}`)
check(`the lock promises the programs a detector asks for beside a bash: ${block.programs.length}`, block.programs.length === 13 && ['grep', 'sed', 'ls', 'cat', 'bash'].every(name => block.programs.includes(name)), block.programs.join(' '))
check('the two files Mercury writes are in the lock: drives without a prefix, /tmp in the user\'s temp folder, the home folder from the environment or Windows', (block.files['etc/fstab'] ?? '').includes('none / cygdrive ') && (block.files['etc/fstab'] ?? '').includes('none /tmp usertemp ') && (block.files['etc/nsswitch.conf'] ?? '').includes('db_home: env windows'), JSON.stringify(block.files))

section('(2) the packs that stand in this checkout')
const standing = platforms.filter(platform => existsSync(join(PACK_ROOT, platform, BASH_PACK_MANIFEST_FILE)))
if (standing.length === 0) console.log('  [SKIP] this checkout holds no Windows bash pack (bun run scripts/vendor/fetch-bash-win.ts --all lays both out): the rows that read one are skipped')
for (const platform of standing) {
  const dir = join(PACK_ROOT, platform)
  const verdict = checkBashPackDir(dir, { digest: true, tree: true, platform })
  check(`${platform}: the pack reads whole: its bash matches its record and its files are the ones the record counts`, verdict.state === 'ok', verdict.state === 'ok' ? '' : verdict.note)
  const fault = bashWinPackFault(dir, lock, platform)
  check(`${platform}: the record names the lock's bash, runtime, database and packages, and the two written files hold the lock's text`, fault === null, fault ?? '')
  const manifest = readBashPackManifest(dir)
  if (manifest === null || manifest.source !== 'msys2-packages') continue
  const said = bashVersionInside(readFileSync(join(dir, ...manifest.binary.split('/'))))
  check(`${platform}: the bash inside says ${block.bashVersion} and names the machine ${lock.platforms[platform]!.target}`, said?.version === block.bashVersion && said.machine === lock.platforms[platform]!.target, JSON.stringify(said))
  const files: string[] = []
  const walk = (at: string, rel: string): void => {
    for (const item of readdirSync(at, { withFileTypes: true })) {
      if (item.isDirectory()) walk(join(at, item.name), rel === '' ? item.name : `${rel}/${item.name}`)
      else files.push(rel === '' ? item.name : `${rel}/${item.name}`)
    }
  }
  walk(dir, '')
  const programs = files.filter(file => /\.(exe|dll)$/i.test(file))
  const held = new Set(programs.map(file => file.split('/').pop()!.toLowerCase()))
  const foreign: string[] = []
  const unmet: string[] = []
  for (const file of programs) {
    const pe = readPe(readFileSync(join(dir, ...file.split('/'))))
    if (pe === null || pe.machine !== 'x86_64') foreign.push(file)
    for (const library of (pe?.imports ?? []).map(name => name.toLowerCase())) if (!held.has(library) && (library.startsWith('msys-') || library.startsWith('cyg'))) unmet.push(`${file} wants ${library}`)
  }
  check(`${platform}: every program and library is an x86_64 Windows file: ${programs.length}`, programs.length > 100 && foreign.length === 0, foreign.join(' '))
  check(`${platform}: every library of the runtime's family that a file imports is in the pack`, unmet.length === 0, unmet.join('; '))
  check(`${platform}: the programs the lock promises stand beside the bash, with ${manifest.programs.length} names in all`, block.programs.every(name => existsSync(join(dir, ...manifest.programsDir.split('/'), `${name}.exe`)) && manifest.programs.includes(name)))
  const texts = manifest.licenseFiles.map(file => [file, readFileSync(join(dir, ...file.split('/')), 'utf8')] as const)
  const text = (name: string): string => texts.find(([file]) => file.endsWith(name))?.[1] ?? ''
  check(
    `${platform}: the licence texts ride with the programs: ${manifest.licenseFiles.length}`,
    manifest.licenseFiles.length === 7 && text('GPL-3.0.txt').includes('GNU GENERAL PUBLIC LICENSE') && text('GPL-3.0.txt').includes('Version 3, 29 June 2007') && text('LGPL-3.0.txt').includes('GNU LESSER GENERAL PUBLIC LICENSE') && text('LGPL-2.1.txt').includes('Version 2.1') && text('CYGWIN_LICENSE').includes('Linking Exception') && text('GCC-RUNTIME-LIBRARY-EXCEPTION.txt').includes('GCC RUNTIME LIBRARY EXCEPTION') && text('pcre-LICENCE').includes('PCRE LICENCE') && text('ncurses-LICENSE').includes('Copyright'),
    manifest.licenseFiles.join(' '),
  )
  const note = readFileSync(join(dir, lock.sourceNote), 'utf8')
  check(`${platform}: the SOURCE note names every package's binary and its source package, each with its address and sha256`, block.packages.every(entry => note.includes(`${block.repository}/${entry.file}`) && note.includes(entry.sha256) && note.includes(`${block.sources}/${entry.source.file}`) && note.includes(entry.source.sha256)) && note.includes(block.database.sha256))
  check(`${platform}: the record says ${platform === 'win-arm64' ? 'its programs are emulated there' : 'its programs are native there'}`, manifest.emulated === (platform === 'win-arm64'))
}
if (standing.length === 2) {
  const [x64, arm64] = standing.map(platform => readBashPackManifest(join(PACK_ROOT, platform)))
  check('win-arm64 holds the very files win-x64 holds: one tree digest', x64 !== null && arm64 !== null && x64.treeDigest === arm64.treeDigest && x64.fileCount === arm64.fileCount, `${x64?.treeDigest} ${arm64?.treeDigest}`)
}

section('(3) the fetch: every checksum before a file is opened, and a changed byte refused')
const cached = pinnedBashWinFiles(lock, CACHE, 'needed')
if (cached.some(file => !existsSync(file.path))) {
  console.log(`  [SKIP] ${CACHE} does not hold the pinned packages (bun run scripts/vendor/fetch-bash-win.ts --all downloads them): the fetch is not run here`)
} else {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bash-win-pack-')))
  try {
    const cache = join(scratch, 'cache')
    const out = join(scratch, 'out')
    cpSync(CACHE, cache, { recursive: true })
    const fetchOnce = (extra: string[]): { status: number | null; text: string } => {
      const ran = spawnSync(process.execPath, [FETCH, '--platform', 'win-x64', '--offline', '--cache', cache, '--out', out, ...extra], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      return { status: ran.status, text: `${ran.stdout ?? ''}${ran.stderr ?? ''}` }
    }
    const first = fetchOnce([])
    const verified = first.text.split('\n').filter(line => line.includes('(in the cache, verified)')).length
    check(`the fetch ends 0 and says every checksum is verified: ${verified} files, each by size and sha256`, first.status === 0 && verified === cached.length && first.text.includes(`every checksum verified — ${block.packages.length} binary packages`), first.text.split('\n').slice(-4).join(' | '))
    const laid = readBashPackManifest(join(out, 'win-x64'))
    const tree = existsSync(join(out, 'win-x64')) ? bashPackTreeDigest(join(out, 'win-x64')) : null
    check('it lays the pack out with a record that counts its own files', laid !== null && tree !== null && laid.treeDigest === tree.treeDigest && laid.fileCount === tree.fileCount && checkBashPackDir(join(out, 'win-x64'), { digest: true, tree: true, platform: 'win-x64' }).state === 'ok')
    const stands = readBashPackManifest(join(PACK_ROOT, 'win-x64'))
    if (stands !== null) check('laid out twice from the same packages, the pack is the same to the byte: the tree digest of this run is the standing pack\'s', laid?.treeDigest === stands.treeDigest, `${laid?.treeDigest} ${stands.treeDigest}`)
    const again = fetchOnce([])
    check('run again on a whole pack it does nothing', again.status === 0 && again.text.includes('pack already valid'), again.text.slice(0, 200))

    const victim = cached.find(file => file.owner === 'grep')!
    const victimPath = join(cache, victim.file)
    const bytes = readFileSync(victimPath)
    bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0x01
    writeFileSync(victimPath, bytes)
    const refused = fetchOnce(['--force'])
    check(`with one byte of ${victim.file} changed in the cache the fetch refuses, naming the file and both digests`, refused.status === 1 && refused.text.includes(victim.file) && refused.text.includes(victim.sha256) && refused.text.includes('the lock pins'), refused.text.split('\n').slice(-3).join(' | ').slice(0, 400))
    check('…and it leaves no half-made pack behind', !readdirSync(out).some(name => name.includes('.tmp-')) && laid !== null && readBashPackManifest(join(out, 'win-x64'))?.treeDigest === laid.treeDigest, readdirSync(out).join(' '))
    const fault = pinnedFileFault({ ...victim, path: victimPath })
    check('the same file read by the check the layout runs is refused before it is opened', fault !== null && fault.includes(victim.sha256), fault ?? 'passed')
    let thrown: unknown = null
    try {
      layBashWinPack({ lock, platform: 'win-x64', cacheDir: cache, destDir: join(scratch, 'direct') })
    } catch (error) {
      thrown = error
    }
    check('laying the pack out directly from that cache is refused too, and nothing is written', thrown instanceof BashWinPackRefused && thrown.faults.some(line => line.includes(victim.file)) && !existsSync(join(scratch, 'direct')), String(thrown).slice(0, 200))
    rmSync(victimPath)
    const missing = fetchOnce(['--force'])
    check('with the package gone from the cache and no network asked for, it refuses and names the file', missing.status === 1 && missing.text.includes(victim.file) && missing.text.includes('not in the cache'), missing.text.split('\n').slice(-3).join(' | ').slice(0, 300))

    section('(4) the door refuses a pack that is not what its record says')
    const copy = join(scratch, 'copy', 'win-x64')
    mkdirSync(join(scratch, 'copy'), { recursive: true })
    cpSync(join(out, 'win-x64'), copy, { recursive: true })
    check('a whole copy passes', checkBashPackDir(copy, { digest: true, tree: true, platform: 'win-x64' }).state === 'ok')
    const grep = join(copy, 'usr', 'bin', 'grep.exe')
    writeFileSync(grep, Buffer.concat([readFileSync(grep), Buffer.from('x')]))
    const changed = checkBashPackDir(copy, { digest: true, tree: true, platform: 'win-x64' })
    check('one changed program beside the bash is refused: the files are not the ones the record counts', changed.state === 'mismatch' && changed.note.includes('not the ones its record counts'), changed.state === 'ok' ? 'passed' : changed.note)
    cpSync(join(out, 'win-x64'), copy, { recursive: true, force: true })
    writeFileSync(join(copy, 'usr', 'bin', 'bash.exe'), Buffer.concat([readFileSync(join(copy, 'usr', 'bin', 'bash.exe')), Buffer.from('x')]))
    const bash = checkBashPackDir(copy, { digest: true, platform: 'win-x64' })
    check('a changed bash is refused, naming the digest', bash.state === 'mismatch' && bash.note.includes('digest'), bash.state === 'ok' ? 'passed' : bash.note)
    cpSync(join(out, 'win-x64'), copy, { recursive: true, force: true })
    rmSync(join(copy, 'licenses', 'GPL-3.0.txt'))
    const unlicensed = checkBashPackDir(copy, { platform: 'win-x64' })
    check('a pack without a licence text is refused, naming the file', unlicensed.state === 'mismatch' && unlicensed.note.includes('licenses/GPL-3.0.txt'), unlicensed.state === 'ok' ? 'passed' : unlicensed.note)
    cpSync(join(out, 'win-x64'), copy, { recursive: true, force: true })
    rmSync(join(copy, 'usr', 'bin', 'msys-2.0.dll'))
    const noRuntime = checkBashPackDir(copy, { platform: 'win-x64' })
    check('a pack without its runtime is refused, naming the file', noRuntime.state === 'mismatch' && noRuntime.note.includes('msys-2.0.dll'), noRuntime.state === 'ok' ? 'passed' : noRuntime.note)
    const elsewhere = checkBashPackDir(join(out, 'win-x64'), { platform: 'win-arm64' })
    check('the pack laid out for one platform is refused on the other', elsewhere.state === 'mismatch', elsewhere.state === 'ok' ? 'passed' : elsewhere.note)
    const built = ['darwin-arm64', 'linux-x64'].map(platform => join(PACK_ROOT, platform)).find(dir => existsSync(join(dir, BASH_PACK_MANIFEST_FILE)))
    if (built !== undefined) {
      const wrongKind = checkBashPackDir(built, { platform: 'win-x64' })
      check('a pack built from the GNU tarball is refused where a Windows pack is asked for', wrongKind.state === 'mismatch', wrongKind.state === 'ok' ? 'passed' : wrongKind.note)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('(5) the bzip2 reader that lays the pack on Windows, where the system tar reads no bzip2')
{
  const stream = Buffer.from('QlpoOTFBWSZTWT5poD8AABxfgIBQQAMCAQolUAA/597gAAggAIqGphKbNUzUwT00RgA0amkyGo02jQgybUZCWFV/oc0euwIFseS2Y9PpDg91iDehXOkl7T+5CdAsdozcCwW1P7EfjpytmqikOQ5ao+q0KiNWdMx1Qg0Z1u7j7QHVmx3cn0yzsEhqdYg7Ad/MQYVuISQ1f2k13cjIMkJgwcMXlFgRKgytxffdK+xuhdyRThQkD5poD8A=', 'base64')
  const reading = (bytes: Uint8Array): Uint8Array | string => {
    try {
      return bunzip2(bytes)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const read = reading(stream)
  check('it reads a stream bzip2 wrote to the byte: 516 bytes with a run of 300 in them', typeof read !== 'string' && read.length === 516 && createHash('sha256').update(read).digest('hex') === '1ba6784c7df12e8ac81cf1704caf62d5f44accc8c3540d7c5cedf9e40a7784d6', typeof read === 'string' ? read : `${read.length} bytes`)
  const changed = Buffer.from(stream)
  changed[90] = changed[90]! ^ 0x04
  const refused = reading(changed)
  check('one changed bit is refused, never read as other text', typeof refused === 'string', typeof refused === 'string' ? '' : `${refused.length} bytes were read`)
  const cut = reading(stream.subarray(0, 120))
  check('a stream that stops early is refused', typeof cut === 'string' && cut.includes('ends before'), String(cut).slice(0, 80))
  const notOne = memberOfBzip2Tar(Buffer.from('not a bzip2 stream at all'), 'pcre-8.45/LICENCE')
  check('what is no bzip2 stream is named as that, where the layout asks for a file inside it', notOne === 'not a bzip2 stream', String(notOne).slice(0, 80))
}

console.log(failures === 0 ? '\nprove-bash-win-pack: ALL LAWS HOLD' : `\nprove-bash-win-pack: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
