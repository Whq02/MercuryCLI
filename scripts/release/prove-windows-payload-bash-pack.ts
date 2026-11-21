#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const BASH_PACK_FIX_HINT = 'to fix: change bundledVendorPacks / checkBundledVendorPacks / vendorPackTreeDigest in scripts/release/payloadContract.mjs (the bash row and its tree check), or vendor/bash.lock.json when the lock and the row disagree'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond ? ` | ${BASH_PACK_FIX_HINT}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const flagAt = (flag: string): string | null => (process.argv.includes(flag) ? (process.argv[process.argv.indexOf(flag) + 1] ?? null) : null)

console.log('============================================================')
console.log(' The payload contract holds the bash pack by every file of its tree')
console.log('============================================================')

type Pack = { name: string; version: string; platform: string; binary: string; degradation: string; manifestKey: string; dir: string; files: string[]; tree?: boolean; record?: Record<string, unknown>; carries?: string; prepare?: string }
type Verdict = { ok: boolean; findings: string[]; packs: Pack[] }
type Tree = { fileCount: number; treeDigest: string }
const contract = (await import('./payloadContract.mjs')) as {
  bundledVendorPacks: (target: string) => Pack[]
  checkBundledVendorPacks: (payloadDir: string, target: string) => Verdict
  vendorPackTreeDigest?: (dir: string) => Tree
}
const treeOf = (dir: string): Tree => (typeof contract.vendorPackTreeDigest === 'function' ? contract.vendorPackTreeDigest(dir) : { fileCount: -1, treeDigest: 'the contract exports no vendorPackTreeDigest' })
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const lock = JSON.parse(readFileSync(join(ROOT, 'vendor', 'bash.lock.json'), 'utf8')) as {
  version: string
  licenseFiles: string[]
  sourceNote: string
  msys2?: { programs: string[]; programsDir: string; files: Record<string, string>; packages: Array<{ sha256: string; licenseFiles: string[] }> }
}
const bashOf = (target: string): Pack | undefined => contract.bundledVendorPacks(target).find(pack => pack.name === 'bash')
const own = (verdict: Verdict, pack: Pack): string[] => verdict.findings.filter(finding => finding.startsWith(`${pack.dir}/`) || finding.startsWith(`${pack.dir} `))
const UNLISTED = ['usr/bin/awk.exe', 'usr/bin/msys-intl-8.dll', 'usr/share/terminfo/78/xterm']

function lay(payload: string, pack: Pack): string {
  const dir = join(payload, ...pack.dir.split('/'))
  for (const file of [...pack.files, ...(pack.platform.startsWith('win-') ? UNLISTED : [])]) {
    const full = join(dir, ...file.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, `fixture ${file}\n`)
  }
  record(dir, pack)
  return dir
}

function record(dir: string, pack: Pack, over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, '.vendor-manifest.json'),
    JSON.stringify({ name: pack.name, platform: pack.platform, version: pack.version, binary: pack.binary, binarySha256: sha(readFileSync(join(dir, ...pack.binary.split('/')))), ...(pack.record ?? {}), ...treeOf(dir), ...over }),
  )
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'windows-payload-bash-')))
try {
  section('(1) the rows of the contract')
  for (const [target, platform] of [['windows-x64', 'win-x64'], ['windows-arm64', 'win-arm64']] as const) {
    const packs = contract.bundledVendorPacks(target)
    const pack = bashOf(target)
    check(`${target}: the archive must carry the bash pack, before the engine pack, held by its tree`, packs[0]?.name === 'bash' && packs.some(other => other.name === 'brush') && pack?.tree === true && pack.platform === platform && pack.dir === `vendor/bash/${platform}` && pack.degradation === 'shell-bash' && pack.manifestKey === 'bash' && pack.version === lock.version, JSON.stringify(packs.map(other => other.name)))
    const programs = (lock.msys2?.programs ?? ['bash']).map(name => `${lock.msys2?.programsDir ?? 'usr/bin'}/${name}.exe`)
    const licences = [...new Set((lock.msys2?.packages ?? []).flatMap(pinned => pinned.licenseFiles))]
    check(`…and names the bash, its runtime, its record, NOTICES.json, the SOURCE note, ${licences.length} licence texts, the two etc files and the ${programs.length} programs a command names`, pack !== undefined && licences.length === 7 && [pack.binary, 'usr/bin/msys-2.0.dll', '.vendor-manifest.json', 'NOTICES.json', lock.sourceNote, ...licences, ...Object.keys(lock.msys2?.files ?? { none: '' }), ...programs].every(file => pack.files.includes(file)), JSON.stringify(pack?.files))
    check('…and the record of a pack must name the packages the lock pins, their package database and the versions', pack?.record !== undefined && ['source', 'bashVersion', 'runtimeVersion', 'databaseSha256', 'packages'].every(field => field in (pack.record ?? {})) && Array.isArray(pack.record.packages) && pack.record.packages.length === (lock.msys2?.packages.length ?? -1), JSON.stringify(Object.keys(pack?.record ?? {})))
    check('…and a build without it is told the command that lays it out', (pack?.prepare ?? '').includes(`scripts/vendor/fetch-bash-win.ts --target ${target}`) && (pack?.carries ?? '').length > 20, String(pack?.prepare))
  }
  for (const target of ['macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64']) {
    check(`${target}: the bash pack is held by its tree too`, bashOf(target)?.tree === true, JSON.stringify(bashOf(target)))
  }

  section('(2) a Windows payload, laid out here from the row: refused without the pack, and with any file of it changed')
  {
    const target = 'windows-x64'
    const pack = bashOf(target)
    if (pack === undefined) {
      check('the contract names a bash pack for windows-x64', false)
    } else {
      const payload = join(scratch, 'windows')
      mkdirSync(payload, { recursive: true })
      const empty = contract.checkBundledVendorPacks(payload, target)
      check('a payload without the pack is refused, every file of the row named as missing', !empty.ok && pack.files.every(file => empty.findings.includes(`${pack.dir}/${file} is missing`)), own(empty, pack).slice(0, 4).join('; '))
      const dir = lay(payload, pack)
      const whole = contract.checkBundledVendorPacks(payload, target)
      check(`a payload with the pack whole (${treeOf(dir).fileCount} files) is not refused for it`, own(whole, pack).length === 0 && whole.packs.some(other => other.name === 'bash'), own(whole, pack).join('; '))
      const refusedFor = (label: string, change: () => void, undo: () => void, words: RegExp): void => {
        change()
        const verdict = contract.checkBundledVendorPacks(payload, target)
        check(label, !verdict.ok && own(verdict, pack).some(finding => words.test(finding)), own(verdict, pack).join('; ') || 'no finding of the bash pack')
        undo()
        const again = contract.checkBundledVendorPacks(payload, target)
        check('…and with the file put back the pack is whole again', own(again, pack).length === 0, own(again, pack).join('; '))
      }
      const at = (file: string): string => join(dir, ...file.split('/'))
      const fixture = (file: string): string => `fixture ${file}\n`
      refusedFor('one byte changed in a program the row does not name (awk.exe) is refused: the tree is not the one the record counts', () => writeFileSync(at(UNLISTED[0]!), `fixture ${UNLISTED[0]}\r`), () => writeFileSync(at(UNLISTED[0]!), fixture(UNLISTED[0]!)), /does not hold the files its record counts/)
      refusedFor('a library the row does not name taken away is refused', () => rmSync(at(UNLISTED[1]!)), () => writeFileSync(at(UNLISTED[1]!), fixture(UNLISTED[1]!)), /does not hold the files its record counts/)
      refusedFor('a file added beside the programs is refused', () => writeFileSync(at('usr/bin/extra.exe'), 'not of the pack'), () => rmSync(at('usr/bin/extra.exe')), /does not hold the files its record counts/)
      refusedFor('one byte changed in etc/fstab is refused', () => writeFileSync(at('etc/fstab'), 'none / cygdrive binary 0 0\n'), () => writeFileSync(at('etc/fstab'), fixture('etc/fstab')), /does not hold the files its record counts/)
      refusedFor('one byte changed in a licence text is refused', () => writeFileSync(at('licenses/GPL-3.0.txt'), 'another text'), () => writeFileSync(at('licenses/GPL-3.0.txt'), fixture('licenses/GPL-3.0.txt')), /does not hold the files its record counts/)
      refusedFor('a changed bash.exe is refused, by its own digest and by the tree', () => writeFileSync(at(pack.binary), 'MZ another program'), () => writeFileSync(at(pack.binary), fixture(pack.binary)), /does not match its record's sha256/)
      const pinned = (pack.record?.packages ?? []) as Array<Record<string, unknown>>
      refusedFor('a record that names another package than the lock pins is refused', () => record(dir, pack, { packages: [{ ...pinned[0], sha256: '0'.repeat(64) }, ...pinned.slice(1)] }), () => record(dir, pack), /names another packages than vendor\/bash\.lock\.json pins/)
      refusedFor('a record of another bash than the lock pins is refused', () => record(dir, pack, { bashVersion: '5.2.37(1)-release' }), () => record(dir, pack), /names another bashVersion than vendor\/bash\.lock\.json pins/)
      refusedFor('a record that counts no files is refused', () => record(dir, pack, { fileCount: undefined, treeDigest: undefined }), () => record(dir, pack), /does not hold the files its record counts/)
    }
  }

  section('(3) a macOS and a Linux payload: the licence text and the SOURCE note are held by their bytes')
  for (const target of ['macos-arm64', 'linux-x64']) {
    const pack = bashOf(target)
    if (pack === undefined) {
      check(`the contract names a bash pack for ${target}`, false)
      continue
    }
    const payload = join(scratch, target)
    mkdirSync(payload, { recursive: true })
    const dir = lay(payload, pack)
    check(`${target}: the pack laid out whole is not refused for it`, own(contract.checkBundledVendorPacks(payload, target), pack).length === 0, own(contract.checkBundledVendorPacks(payload, target), pack).join('; '))
    for (const file of [...lock.licenseFiles, lock.sourceNote]) {
      writeFileSync(join(dir, file), 'other words\n')
      const verdict = contract.checkBundledVendorPacks(payload, target)
      check(`${target}: a changed ${file} is refused`, own(verdict, pack).some(finding => /does not hold the files its record counts/.test(finding)), own(verdict, pack).join('; ') || 'no finding of the bash pack')
      writeFileSync(join(dir, file), `fixture ${file}\n`)
    }
  }

  section('(4) the pack this checkout holds')
  for (const [target, platform] of [['windows-x64', 'win-x64'], ['windows-arm64', 'win-arm64']] as const) {
    const pack = bashOf(target)
    const laid = join(ROOT, 'vendor', 'bash', platform)
    if (pack === undefined || !existsSync(join(laid, '.vendor-manifest.json'))) {
      console.log(`  [SKIP] this checkout holds no ${platform} pack (bun run scripts/vendor/fetch-bash-win.ts --platform ${platform}): the rows above read a pack laid out from the row`)
      continue
    }
    const payload = join(scratch, `real-${platform}`)
    const dir = join(payload, 'vendor', 'bash', platform)
    cpSync(laid, dir, { recursive: true })
    const whole = contract.checkBundledVendorPacks(payload, target)
    check(`${platform}: the pack as the fetch laid it out, ${treeOf(dir).fileCount} files, passes`, own(whole, pack).length === 0, own(whole, pack).join('; '))
    const grep = join(dir, 'usr', 'bin', 'grep.exe')
    const bytes = readFileSync(grep)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    writeFileSync(grep, bytes)
    const changed = contract.checkBundledVendorPacks(payload, target)
    check(`${platform}: with the last byte of usr/bin/grep.exe changed it is refused`, own(changed, pack).some(finding => /does not hold the files its record counts/.test(finding)), own(changed, pack).join('; ') || 'no finding of the bash pack')
  }

  section('(5) a bundle built for Windows')
  {
    const dist = flagAt('--win-dist')
    if (dist === null) {
      console.log('  [SKIP] no --win-dist <a dist built with bun run build.ts --target windows-x64>: the built bundle is read where one is named')
    } else {
      const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as { degraded?: string[]; target?: { release?: string }; bash?: { vendored?: boolean; path?: string; source?: string; fileCount?: number; treeDigest?: string } }
      const target = manifest.target?.release ?? 'windows-x64'
      const pack = bashOf(target)
      const verdict = contract.checkBundledVendorPacks(dist, target)
      check(`the bundle built for ${target} carries the pack, and its manifest says so`, manifest.bash?.vendored === true && manifest.bash.source === 'msys2-packages' && manifest.degraded?.includes('shell-bash') === false, JSON.stringify(manifest.bash))
      check('…and the contract finds nothing to refuse the pack for', pack !== undefined && own(verdict, pack).length === 0, pack === undefined ? 'no bash row' : own(verdict, pack).join('; '))
      const tree = pack === undefined ? null : treeOf(join(dist, ...pack.dir.split('/')))
      check(`…its ${String(tree?.fileCount)} files hashing to the tree digest the manifest carries`, tree !== null && tree.fileCount === manifest.bash?.fileCount && tree.treeDigest === manifest.bash.treeDigest, JSON.stringify(tree))
      const others = pack === undefined ? verdict.findings : verdict.findings.filter(finding => !own(verdict, pack).includes(finding))
      console.log(`  (what else this payload is refused for, none of it the bash pack's: ${others.length === 0 ? 'nothing' : others.map(finding => finding.slice(0, 70)).join(' · ')})`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-windows-payload-bash-pack: ALL LAWS HOLD' : `\nprove-windows-payload-bash-pack: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
