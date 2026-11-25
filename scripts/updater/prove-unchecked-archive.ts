#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { zipSync } from 'fflate'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.0-beta.1' }

const { assetNameFor } = await import('../../src/platform/update-channel/channelCore.js')
const { performUpdate } = await import('../../src/platform/update-channel/updateService.js')
const { checkArchiveBeforeUnpack, updateCeilings } = await import('../../src/platform/update-channel/archiveListing.js')
const { unpackedFolderRefusal } = await import('../../src/platform/update-channel/unpackedFolder.js')
const UPDATE_CEILINGS = updateCeilings()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : ' — to fix: make checkArchiveBeforeUnpack in src/platform/update-channel/archiveListing.ts refuse this archive, and keep extractArchive in src/platform/update-channel/updateService.ts calling it before one entry is written'}`)
}

interface TarMember {
  name: string
  type?: string
  data?: Buffer
  link?: string
  gnu?: boolean
}

function tarHeader(member: TarMember): Buffer {
  const block = Buffer.alloc(512)
  block.write(member.name, 0, 100, 'latin1')
  block.write('0000755\0', 100, 'latin1')
  block.write('0000000\0', 108, 'latin1')
  block.write('0000000\0', 116, 'latin1')
  block.write(`${(member.data?.byteLength ?? 0).toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  block.write('00000000000\0', 136, 'latin1')
  block.write('        ', 148, 'latin1')
  block.write(member.type ?? '0', 156, 'latin1')
  if (member.link !== undefined) block.write(member.link, 157, 100, 'latin1')
  block.write(member.gnu === true ? 'ustar  \0' : 'ustar\0' + '00', 257, 'latin1')
  const sum = block.reduce((total, byte) => total + byte, 0)
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return block
}

function tarGz(members: TarMember[]): Buffer {
  const parts: Buffer[] = []
  for (const member of members) {
    parts.push(tarHeader(member))
    if (member.data !== undefined) parts.push(member.data, Buffer.alloc((512 - (member.data.byteLength % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

const dir = (name: string): TarMember => ({ name, type: '5' })
const file = (name: string, text = 'x'): TarMember => ({ name, data: Buffer.from(text) })
const link = (name: string, target: string, type = '2'): TarMember => ({ name, type, link: target })
function pax(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  const length = [1, 2, 3, 4].map(digits => digits + body.length).find(total => String(total).length + body.length === total) ?? 0
  return Buffer.from(`${length}${body}`)
}
const zip = (names: Record<string, string>): Buffer => Buffer.from(zipSync(Object.fromEntries(Object.entries(names).map(([name, text]) => [name, Buffer.from(text)]))))

const V_NEW = '9.9.0-beta.2'
const ASSET = assetNameFor(V_NEW, process.platform, process.arch)
if (ASSET === null) {
  console.log('  [FAIL] this host has no release asset name')
  process.exit(1)
}
const served = { archive: Buffer.alloc(0) }
const server = createServer((req, res) => {
  const url = req.url ?? ''
  const base = `http://${req.headers.host}`
  const json = (body: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (/^\/repos\/[^/]+\/[^/]+\/releases/.test(url)) {
    return json([{ tag_name: `v${V_NEW}`, draft: false, assets: [ASSET, 'SHA256SUMS.txt'].map(name => ({ name, browser_download_url: `${base}/dl/${name}` })) }])
  }
  if (/^\/repos\/[^/]+\/[^/]+$/.test(url)) return json({ private: false })
  if (url === `/dl/${ASSET}`) return void res.end(served.archive)
  if (url === '/dl/SHA256SUMS.txt') return void res.end(`${createHash('sha256').update(served.archive).digest('hex')}  ${ASSET}\n`)
  res.writeHead(404)
  res.end()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.MERCURY_UPDATE_API_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
delete process.env.MERCURY_UPDATE_CHANNEL_REPO

const scratch = mkdtempSync(join(tmpdir(), 'mercury-o03-archive-'))
const runs = { count: 0 }
type Outcome = { state: string; stage?: string; reason?: string; remedy?: string }

async function update(archive: Buffer, opts: { windows?: boolean; entries?: number; unpackedBytes?: number } = {}): Promise<{ outcome: Outcome; home: string }> {
  served.archive = archive
  const home = join(scratch, `run-${++runs.count}`, 'deep', 'home')
  const versionsDir = join(home, 'versions')
  mkdirSync(versionsDir, { recursive: true })
  mkdirSync(join(home, 'outside'))
  writeFileSync(join(home, 'outside', 'manifest.json'), '{"version":"0.0.0"}')
  const roots = { versionsDir, binDir: join(home, 'bin'), shimPath: join(home, 'bin', 'mercury'), isWindows: opts.windows === true }
  const ceilings = { ...UPDATE_CEILINGS, ...(opts.entries !== undefined ? { entries: opts.entries } : {}), ...(opts.unpackedBytes !== undefined ? { unpackedBytes: opts.unpackedBytes } : {}) }
  const outcome = (await performUpdate(roots, () => {}, { ceilings } as Parameters<typeof performUpdate>[2])) as Outcome
  return { outcome, home }
}

const REMEDY = 'report the release as malformed; nothing was activated — the active installation was not changed'
const refusedWith = (outcome: Outcome, reason: string): boolean => outcome.state === 'refused' && outcome.stage === 'envelope' && outcome.reason === reason && outcome.remedy === REMEDY
const shown = (outcome: Outcome): string => JSON.stringify({ state: outcome.state, stage: outcome.stage, reason: outcome.reason }).slice(0, 260)

function hostCan(act: () => boolean): boolean {
  try {
    return act()
  } catch {
    return false
  }
}
function checkWhere(can: boolean, why: string, label: string, cond: boolean, detail = ''): void {
  if (can) check(label, cond, detail)
  else console.log(`  [NOT STAGED] ${label} — ${why}`)
}
const probe = join(scratch, 'host-probe')
for (const name of ['plain', 'linked']) mkdirSync(join(probe, name), { recursive: true })
writeFileSync(join(probe, 'plain.tar.gz'), tarGz([dir('mercury/'), file('mercury/a.txt')]))
writeFileSync(join(probe, 'linked.tar.gz'), tarGz([dir('mercury/'), file('mercury/a.txt'), link('mercury/alias', 'a.txt')]))
const host = {
  tarUnpacks: hostCan(() => {
    execFileSync('tar', ['-xzf', join(probe, 'plain.tar.gz'), '-C', join(probe, 'plain')], { stdio: 'pipe' })
    return existsSync(join(probe, 'plain', 'mercury', 'a.txt'))
  }),
  tarLinks: hostCan(() => {
    execFileSync('tar', ['-xzf', join(probe, 'linked.tar.gz'), '-C', join(probe, 'linked')], { stdio: 'pipe' })
    return lstatSync(join(probe, 'linked', 'mercury', 'alias')).isSymbolicLink()
  }),
  links: hostCan(() => {
    symlinkSync('plain.tar.gz', join(probe, 'made-link'))
    return lstatSync(join(probe, 'made-link')).isSymbolicLink()
  }),
  fifos: hostCan(() => {
    execFileSync('mkfifo', [join(probe, 'made-fifo')], { stdio: 'pipe' })
    return lstatSync(join(probe, 'made-fifo')).isFIFO()
  }),
}
const TAR_CANNOT = "this host's tar does not unpack an archive at the fixture's path"
const LINKS_CANNOT = 'this host does not let this account make a symbolic link'
const linkedTar = { can: host.tarUnpacks && host.tarLinks, why: host.tarUnpacks ? "this host's tar does not make the fixture's link" : TAR_CANNOT }

try {
  console.log('── the bounds of the unpacking ──')
  const five = tarGz([dir('mercury/'), file('mercury/manifest.json', '{}'), file('mercury/b'), file('mercury/c'), file('mercury/d')])
  const many = await update(five, { entries: 4 })
  check('a tar that lists more entries than the ceiling is refused before it is unpacked', refusedWith(many.outcome, 'the archive lists more than 4 entries, the most a release may hold'), shown(many.outcome))
  const atCeiling = await update(five, { entries: 5 })
  checkWhere(host.tarUnpacks, TAR_CANNOT, 'a tar that lists exactly the ceiling is unpacked as before and judged by its payload', atCeiling.outcome.state === 'refused' && atCeiling.outcome.stage === 'payload', shown(atCeiling.outcome))
  const heavy = tarGz([dir('mercury/'), file('mercury/a', 'a'.repeat(4096)), file('mercury/b', 'b'.repeat(4096)), file('mercury/c', 'c'.repeat(4096))])
  const big = await update(heavy, { unpackedBytes: 8192 })
  check('a tar that unpacks to more bytes than the ceiling is refused before it is unpacked', refusedWith(big.outcome, 'the archive unpacks to more than 8192 bytes, the most a release may hold'), shown(big.outcome))

  const fiveZip = zip({ 'mercury/a': 'x', 'mercury/b': 'x', 'mercury/c': 'x', 'mercury/d': 'x', 'mercury/e': 'x' })
  const manyZip = await update(fiveZip, { windows: true, entries: 4 })
  check('a zip that lists more entries than the ceiling is refused before PowerShell is looked for', refusedWith(manyZip.outcome, 'the archive lists more than 4 entries, the most a release may hold'), shown(manyZip.outcome))
  const heavyZip = zip({ 'mercury/a': 'a'.repeat(4096), 'mercury/b': 'b'.repeat(4096), 'mercury/c': 'c'.repeat(4096) })
  const bigZip = await update(heavyZip, { windows: true, unpackedBytes: 8192 })
  check('a zip that states more unpacked bytes than the ceiling is refused before PowerShell is looked for', refusedWith(bigZip.outcome, 'the archive unpacks to more than 8192 bytes, the most a release may hold'), shown(bigZip.outcome))
  const lying = zip({ 'mercury/bomb': 'z'.repeat(65536) })
  const directoryAt = lying.readUInt32LE(lying.byteLength - 6)
  lying.writeUInt32LE(16, 22)
  lying.writeUInt32LE(16, directoryAt + 24)
  const liar = await update(lying, { windows: true })
  check('a zip whose entry holds more bytes than it states is refused before PowerShell is looked for', liar.outcome.state === 'refused' && liar.outcome.stage === 'extract' && (liar.outcome.reason ?? '').startsWith('archive extraction failed: '), shown(liar.outcome))
  const plainZip = await update(zip({ 'mercury/manifest.json': '{}' }), { windows: true })
  check('a zip within the ceilings passes the listing and goes on to the unpacker', plainZip.outcome.state === 'refused' && (plainZip.outcome.stage === 'extract-tool-absent' || plainZip.outcome.stage === 'payload'), shown(plainZip.outcome))

  console.log('── the entries ──')
  const LEAVES = 'the archive holds an entry that leaves the folder it is unpacked into: '
  const LINK_LEAVES = 'the archive holds a link that leaves the folder it is unpacked into: '
  const THROUGH = 'the archive writes an entry through a link it made itself: '
  const stoodOutside = (home: string, name: string): boolean => existsSync(join(home, name)) || existsSync(join(home, 'versions', name)) || existsSync(join(home, 'outside', name))

  const climb = await update(tarGz([dir('mercury/'), file('mercury/ok.txt'), file('mercury/../../../climbed.txt', 'climbed')]))
  check('a tar entry that climbs out with .. is refused before one entry is written', refusedWith(climb.outcome, `${LEAVES}"mercury/../../../climbed.txt"`) && !stoodOutside(climb.home, 'climbed.txt'), shown(climb.outcome))
  const absolute = await update(tarGz([dir('mercury/'), file('/mercury-o03-absolute/evil.txt', 'abs')]))
  check('a tar entry with an absolute name is refused', refusedWith(absolute.outcome, `${LEAVES}"/mercury-o03-absolute/evil.txt"`) && !existsSync('/mercury-o03-absolute'), shown(absolute.outcome))
  const through = await update(tarGz([dir('mercury/'), link('mercury/door', '../../../../outside'), file('mercury/door/through.txt', 'through')]))
  check('a tar with a link out of the folder and an entry written through it is refused', refusedWith(through.outcome, `${LINK_LEAVES}"mercury/door"`) && !stoodOutside(through.home, 'through.txt'), shown(through.outcome))
  const readThrough = await update(tarGz([dir('mercury/'), link('mercury/manifest.json', '../../../../outside/manifest.json')]))
  check('a tar whose manifest is a link to a file outside is refused before that file is read', refusedWith(readThrough.outcome, `${LINK_LEAVES}"mercury/manifest.json"`), shown(readThrough.outcome))
  const absoluteLink = await update(tarGz([dir('mercury/'), link('mercury/zero', '/dev/zero')]))
  check('a tar link with an absolute target is refused', refusedWith(absoluteLink.outcome, `${LINK_LEAVES}"mercury/zero"`), shown(absoluteLink.outcome))
  const hard = await update(tarGz([dir('mercury/'), link('mercury/hl', '../../../outside/manifest.json', '1')]))
  check('a tar hard link whose target leaves the folder is refused', refusedWith(hard.outcome, `${LINK_LEAVES}"mercury/hl"`), shown(hard.outcome))
  const fifo = await update(tarGz([dir('mercury/'), { name: 'mercury/pipe', type: '6' }]))
  check('a tar that holds a FIFO is refused', refusedWith(fifo.outcome, 'the archive holds a device, a FIFO or a socket: "mercury/pipe"'), shown(fifo.outcome))
  const device = await update(tarGz([dir('mercury/'), { name: 'mercury/dev', type: '3' }]))
  check('a tar that holds a device is refused', refusedWith(device.outcome, 'the archive holds a device, a FIFO or a socket: "mercury/dev"'), shown(device.outcome))
  const insideLink = await update(tarGz([dir('mercury/'), file('mercury/manifest.json', '{}'), link('mercury/alias', 'manifest.json'), link('mercury/again', './../mercury/manifest.json'), link('mercury/twin', 'mercury/manifest.json', '1')]))
  checkWhere(linkedTar.can, linkedTar.why, 'links that stay inside the folder are not refused: the archive is unpacked and judged by its payload', insideLink.outcome.state === 'refused' && insideLink.outcome.stage === 'payload', shown(insideLink.outcome))
  const viaLink = await update(tarGz([dir('mercury/'), dir('mercury/sub/'), link('mercury/l', 'sub'), file('mercury/l/x.txt')]))
  check('a tar entry written through a link the archive made is refused even when the link stays inside', refusedWith(viaLink.outcome, `${THROUGH}"mercury/l/x.txt"`), shown(viaLink.outcome))
  const chained = await update(tarGz([dir('mercury/'), dir('mercury/d1/'), dir('mercury/d1/d2/'), link('mercury/d1/d2/up', '../..'), link('mercury/d1/d2/out', 'up/../../outside')]))
  check('a link whose target passes through another link is refused', refusedWith(chained.outcome, `${THROUGH}"mercury/d1/d2/out"`), shown(chained.outcome))
  const longName = await update(tarGz([dir('mercury/'), { name: '././@LongLink', type: 'L', data: Buffer.from('mercury/../../../long.txt\0') }, file('mercury/harmless.txt')]))
  check('a climbing name carried in a GNU long-name header is refused though the plain header names a harmless file', refusedWith(longName.outcome, `${LEAVES}"mercury/../../../long.txt"`) && !stoodOutside(longName.home, 'long.txt'), shown(longName.outcome))
  const paxName = await update(tarGz([dir('mercury/'), { name: 'PaxHeader/harmless.txt', type: 'x', data: pax('path', 'mercury/../../../pax.txt') }, file('mercury/harmless.txt')]))
  check('a climbing name carried in a pax header is refused though the plain header names a harmless file', refusedWith(paxName.outcome, `${LEAVES}"mercury/../../../pax.txt"`) && !stoodOutside(paxName.home, 'pax.txt'), shown(paxName.outcome))

  const hidden = await update(tarGz([dir('mercury/'), { name: 'mercury/x/', data: tarHeader({ name: 'mercury/hidden-pipe', type: '6' }) }]))
  check('a tar that hides entries in the bytes of a file named as a folder is refused by the reading, before the unpacker sees it', hidden.outcome.state === 'refused' && hidden.outcome.stage === 'extract' && hidden.outcome.reason === 'archive extraction failed: a header gives a file the name of a folder', shown(hidden.outcome))

  const CUT = `mercury/${'d'.repeat(91)}/`
  const longFile = `${CUT}file.txt`
  const longNote = (name: string): TarMember => ({ name: '././@LongLink', type: 'L', data: Buffer.from(`${name}\0`), gnu: true })
  const gnuShape = tarGz([{ ...dir('mercury/'), gnu: true }, { ...file('mercury/manifest.json', '{}'), gnu: true }, { ...dir(CUT), gnu: true }, longNote(longFile), { name: CUT, data: Buffer.from('long'), gnu: true }])
  const gnuPath = join(scratch, 'gnu-shape.tar.gz')
  writeFileSync(gnuPath, gnuShape)
  const gnuListed = await checkArchiveBeforeUnpack(gnuPath, 'tar.gz', UPDATE_CEILINGS)
  check('a GNU tar whose long-named file has a header name cut at 100 bytes right after a slash is read, as GNU tar on Linux packs a release', gnuListed.state === 'ok' && gnuListed.entries === 4, `CUT holds ${CUT.length} bytes; ${JSON.stringify(gnuListed)}`)
  const gnuUpdate = await update(gnuShape)
  checkWhere(host.tarUnpacks, TAR_CANNOT, 'such an archive is unpacked and judged by its payload', gnuUpdate.outcome.state === 'refused' && gnuUpdate.outcome.stage === 'payload', shown(gnuUpdate.outcome))
  const gnuDest = join(scratch, 'gnu-shape')
  mkdirSync(gnuDest)
  if (host.tarUnpacks) execFileSync('tar', ['-xzf', gnuPath, '-C', gnuDest])
  checkWhere(host.tarUnpacks, TAR_CANNOT, "this host's tar unpacks that entry as a file under its long name, where the listing judged it", existsSync(join(gnuDest, longFile)) && readFileSync(join(gnuDest, longFile), 'utf8') === 'long' && unpackedFolderRefusal(gnuDest, UPDATE_CEILINGS) === null)
  const longFolder = await update(tarGz([{ ...dir('mercury/'), gnu: true }, longNote(`${CUT}sub/`), { name: CUT, data: tarHeader({ name: 'mercury/hidden-pipe', type: '6' }), gnu: true }]))
  check('a file entry whose waiting long name ends in a slash is still refused by the reading', longFolder.outcome.state === 'refused' && longFolder.outcome.stage === 'extract' && longFolder.outcome.reason === 'archive extraction failed: a header gives a file the name of a folder', shown(longFolder.outcome))
  const paxFolder = await update(tarGz([dir('mercury/'), { name: 'PaxHeader/x', type: 'x', data: pax('path', 'mercury/sub/') }, { name: 'mercury/x', data: tarHeader({ name: 'mercury/hidden-pipe', type: '6' }) }]))
  check('a file entry whose waiting pax path ends in a slash is still refused by the reading', paxFolder.outcome.state === 'refused' && paxFolder.outcome.stage === 'extract' && paxFolder.outcome.reason === 'archive extraction failed: a header gives a file the name of a folder', shown(paxFolder.outcome))

  const DOTS = `mercury/${'d'.repeat(89)}/..`
  const dotsFolder = `${DOTS}data/`
  const dotsFile = `${DOTS}data/file.txt`
  const dotsShape = tarGz([{ ...dir('mercury/'), gnu: true }, { ...file('mercury/manifest.json', '{}'), gnu: true }, longNote(dotsFolder), { name: DOTS, type: '5', gnu: true }, longNote(dotsFile), { name: DOTS, data: Buffer.from('dots'), gnu: true }])
  const dotsPath = join(scratch, 'dots-shape.tar.gz')
  writeFileSync(dotsPath, dotsShape)
  const dotsListed = await checkArchiveBeforeUnpack(dotsPath, 'tar.gz', UPDATE_CEILINGS)
  check('a GNU tar whose long name is cut at 100 bytes right after the first two dots of a name like ..data is read', dotsListed.state === 'ok' && dotsListed.entries === 4, `the cut holds ${DOTS.length} bytes; ${JSON.stringify(dotsListed).slice(0, 220)}`)
  const dotsUpdate = await update(dotsShape)
  checkWhere(host.tarUnpacks, TAR_CANNOT, 'such an archive is unpacked and judged by its payload', dotsUpdate.outcome.state === 'refused' && dotsUpdate.outcome.stage === 'payload', shown(dotsUpdate.outcome))
  const dotsDest = join(scratch, 'dots-shape')
  mkdirSync(dotsDest)
  if (host.tarUnpacks) execFileSync('tar', ['-xzf', dotsPath, '-C', dotsDest])
  checkWhere(host.tarUnpacks, TAR_CANNOT, "this host's tar unpacks that entry as a file under its long name", existsSync(join(dotsDest, dotsFile)) && readFileSync(join(dotsDest, dotsFile), 'utf8') === 'dots' && unpackedFolderRefusal(dotsDest, UPDATE_CEILINGS) === null)
  const climbingLong = `mercury/../../../${'x'.repeat(100)}`
  const cutClimb = await update(tarGz([{ ...dir('mercury/'), gnu: true }, longNote(climbingLong), { name: climbingLong.slice(0, 100), data: Buffer.from('x'), gnu: true }]))
  check('a waiting long name that itself climbs is refused, cut or no cut', refusedWith(cutClimb.outcome, `${LEAVES}${JSON.stringify(climbingLong).slice(0, 120)}`) && !stoodOutside(cutClimb.home, 'x'.repeat(100)), shown(cutClimb.outcome))
  const notCut = await update(tarGz([{ ...dir('mercury/'), gnu: true }, longNote(`mercury/${'h'.repeat(110)}`), { name: 'mercury/../../../climbed.txt', data: Buffer.from('x'), gnu: true }]))
  check('a header name that climbs and is not the cut of the harmless long name before it is refused', refusedWith(notCut.outcome, `${LEAVES}"mercury/../../../climbed.txt"`) && !stoodOutside(notCut.home, 'climbed.txt'), shown(notCut.outcome))
  const linkNote = (target: string): TarMember => ({ name: '././@LongLink', type: 'K', data: Buffer.from(`${target}\0`), gnu: true })
  const cutTarget = `${'./'.repeat(47)}/../..`
  const longTarget = await update(tarGz([{ ...dir('mercury/'), gnu: true }, { ...file('mercury/manifest.json', '{}'), gnu: true }, linkNote(`${cutTarget}data`), { ...link('mercury/l', cutTarget), gnu: true }]))
  checkWhere(linkedTar.can, linkedTar.why, 'a link whose long target is cut at 100 bytes right after two dots is judged by its whole target, which stays inside', longTarget.outcome.state === 'refused' && longTarget.outcome.stage === 'payload', `the cut holds ${cutTarget.length} bytes; ${shown(longTarget.outcome)}`)
  const climbingTarget = await update(tarGz([{ ...dir('mercury/'), gnu: true }, linkNote(`${cutTarget}/${'y'.repeat(20)}`), { ...link('mercury/l', cutTarget), gnu: true }]))
  check('a waiting long target that itself leaves the folder is refused', refusedWith(climbingTarget.outcome, `${LINK_LEAVES}"mercury/l"`), shown(climbingTarget.outcome))
  const targetNotCut = await update(tarGz([{ ...dir('mercury/'), gnu: true }, linkNote(`${'t'.repeat(110)}`), { ...link('mercury/l', '../../outside'), gnu: true }]))
  check('a header link target that leaves the folder and is not the cut of the harmless long target before it is refused', refusedWith(targetNotCut.outcome, `${LINK_LEAVES}"mercury/l"`), shown(targetNotCut.outcome))

  for (const name of ['..\\..\\..\\climbed.txt', 'mercury/../../../../climbed.txt', 'C:\\mercury-o03\\evil.txt', '/mercury-o03-absolute/evil.txt', '\\\\host\\share\\evil.txt', 'mercury/ .. / .. / .. / .. /trimmed.txt', 'mercury/\u00a0..\u00a0/\t..\t/\u3000..\u3000/. ./trimmed.txt', 'mercury/file.txt:stream']) {
    const climbed = await update(zip({ 'mercury/ok.txt': 'x', [name]: 'x' }), { windows: true })
    check(`a zip entry named ${JSON.stringify(name)} is refused before PowerShell is looked for`, refusedWith(climbed.outcome, `${LEAVES}${JSON.stringify(name)}`) && !stoodOutside(climbed.home, 'climbed.txt') && !stoodOutside(climbed.home, 'trimmed.txt'), shown(climbed.outcome))
  }

  console.log('── the look at the folder after the unpacker ──')
  const staged = (name: string, fill: (root: string) => void): string => {
    const root = join(scratch, 'looked', name, 'extracted')
    mkdirSync(join(root, 'mercury', 'sub'), { recursive: true })
    writeFileSync(join(root, 'mercury', 'a.txt'), 'aaaa')
    writeFileSync(join(root, 'mercury', 'sub', 'b.txt'), 'bbbb')
    fill(root)
    return root
  }
  const lookWhere = (can: boolean, why: string, label: string, name: string, fill: (root: string) => void, expected: string | null): void => {
    if (!can) return checkWhere(false, why, label, false)
    const told = unpackedFolderRefusal(staged(name, fill), UPDATE_CEILINGS)
    check(label, told === expected, String(told))
  }
  const LINK_LEFT = 'the unpacker left a link that leaves the folder it unpacked into: '
  check('a folder of files and folders within the ceilings is passed', unpackedFolderRefusal(staged('plain', () => {}), UPDATE_CEILINGS) === null)
  check('a folder with one entry more than the ceiling is refused', unpackedFolderRefusal(staged('many', () => {}), { ...UPDATE_CEILINGS, entries: 3 }) === 'the unpacker wrote more than 3 entries, the most a release may hold')
  check('a folder with one byte more than the ceiling is refused', unpackedFolderRefusal(staged('heavy', () => {}), { ...UPDATE_CEILINGS, unpackedBytes: 7 }) === 'the unpacker wrote more than 7 bytes, the most a release may hold' && unpackedFolderRefusal(staged('exact', () => {}), { ...UPDATE_CEILINGS, unpackedBytes: 8, entries: 4 }) === null)
  lookWhere(host.links, LINKS_CANNOT, 'links that stay inside the folder are passed', 'inside-link', root => {
    symlinkSync('a.txt', join(root, 'mercury', 'alias'))
    symlinkSync('../a.txt', join(root, 'mercury', 'sub', 'up-one'))
    symlinkSync('nowhere.txt', join(root, 'mercury', 'dangling'))
  }, null)
  lookWhere(host.links, LINKS_CANNOT, 'a link that leaves the folder is refused', 'out-link', root => symlinkSync(join(scratch, 'looked'), join(root, 'mercury', 'door')), `${LINK_LEFT}${JSON.stringify(join('mercury', 'door'))}`)
  lookWhere(host.links, LINKS_CANNOT, 'a link that leaves the folder only through another link is refused', 'chain-link', root => {
    symlinkSync('..', join(root, 'mercury', 'sub', 'up'))
    symlinkSync('up/../..', join(root, 'mercury', 'sub', 'out'))
  }, `${LINK_LEFT}${JSON.stringify(join('mercury', 'sub', 'out'))}`)
  lookWhere(host.links, LINKS_CANNOT, 'a link to a missing place outside the folder is refused', 'lost-link', root => symlinkSync('../../../nowhere', join(root, 'mercury', 'lost')), `${LINK_LEFT}${JSON.stringify(join('mercury', 'lost'))}`)
  lookWhere(host.fifos, 'this host has no mkfifo that makes a FIFO here', 'a FIFO is refused', 'fifo', root => void execFileSync('mkfifo', [join(root, 'mercury', 'pipe')]), `the unpacker left a device, a FIFO or a socket: ${JSON.stringify(join('mercury', 'pipe'))}`)

  check('the unpacked ceiling is a round figure of at least 4 GiB', UPDATE_CEILINGS.unpackedBytes >= 4 * 1024 ** 3 && UPDATE_CEILINGS.unpackedBytes % 1024 ** 3 === 0, String(UPDATE_CEILINGS.unpackedBytes))
  check('the entries ceiling is a round figure of at least 100,000', UPDATE_CEILINGS.entries >= 100_000 && UPDATE_CEILINGS.entries % 10_000 === 0, String(UPDATE_CEILINGS.entries))
} finally {
  server.closeAllConnections()
  server.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-unchecked-archive: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
export {}
