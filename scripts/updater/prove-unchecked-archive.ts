#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { zipSync } from 'fflate'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.0-beta.1' }

const { assetNameFor, UPDATE_CEILINGS } = await import('../../src/platform/update-channel/channelCore.js')
const { performUpdate } = await import('../../src/platform/update-channel/updateService.js')

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
  block.write('ustar\0' + '00', 257, 'latin1')
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

try {
  console.log('── the bounds of the unpacking ──')
  const five = tarGz([dir('mercury/'), file('mercury/manifest.json', '{}'), file('mercury/b'), file('mercury/c'), file('mercury/d')])
  const many = await update(five, { entries: 4 })
  check('a tar that lists more entries than the ceiling is refused before it is unpacked', refusedWith(many.outcome, 'the archive lists more than 4 entries, the most a release may hold'), shown(many.outcome))
  const atCeiling = await update(five, { entries: 5 })
  check('a tar that lists exactly the ceiling is unpacked as before and judged by its payload', atCeiling.outcome.state === 'refused' && atCeiling.outcome.stage === 'payload', shown(atCeiling.outcome))
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
  check('links that stay inside the folder are not refused: the archive is unpacked and judged by its payload', insideLink.outcome.state === 'refused' && insideLink.outcome.stage === 'payload', shown(insideLink.outcome))
  const viaLink = await update(tarGz([dir('mercury/'), dir('mercury/sub/'), link('mercury/l', 'sub'), file('mercury/l/x.txt')]))
  check('a tar entry written through a link the archive made is refused even when the link stays inside', refusedWith(viaLink.outcome, `${THROUGH}"mercury/l/x.txt"`), shown(viaLink.outcome))
  const chained = await update(tarGz([dir('mercury/'), dir('mercury/d1/'), dir('mercury/d1/d2/'), link('mercury/d1/d2/up', '../..'), link('mercury/d1/d2/out', 'up/../../outside')]))
  check('a link whose target passes through another link is refused', refusedWith(chained.outcome, `${THROUGH}"mercury/d1/d2/out"`), shown(chained.outcome))
  const longName = await update(tarGz([dir('mercury/'), { name: '././@LongLink', type: 'L', data: Buffer.from('mercury/../../../long.txt\0') }, file('mercury/harmless.txt')]))
  check('a climbing name carried in a GNU long-name header is refused though the plain header names a harmless file', refusedWith(longName.outcome, `${LEAVES}"mercury/../../../long.txt"`) && !stoodOutside(longName.home, 'long.txt'), shown(longName.outcome))
  const paxName = await update(tarGz([dir('mercury/'), { name: 'PaxHeader/harmless.txt', type: 'x', data: pax('path', 'mercury/../../../pax.txt') }, file('mercury/harmless.txt')]))
  check('a climbing name carried in a pax header is refused though the plain header names a harmless file', refusedWith(paxName.outcome, `${LEAVES}"mercury/../../../pax.txt"`) && !stoodOutside(paxName.home, 'pax.txt'), shown(paxName.outcome))

  for (const name of ['..\\..\\..\\climbed.txt', 'mercury/../../../../climbed.txt', 'C:\\mercury-o03\\evil.txt', '/mercury-o03-absolute/evil.txt', '\\\\host\\share\\evil.txt', 'mercury/ .. / .. / .. / .. /trimmed.txt', 'mercury/\u00a0..\u00a0/\t..\t/\u3000..\u3000/. ./trimmed.txt', 'mercury/file.txt:stream']) {
    const climbed = await update(zip({ 'mercury/ok.txt': 'x', [name]: 'x' }), { windows: true })
    check(`a zip entry named ${JSON.stringify(name)} is refused before PowerShell is looked for`, refusedWith(climbed.outcome, `${LEAVES}${JSON.stringify(name)}`) && !stoodOutside(climbed.home, 'climbed.txt') && !stoodOutside(climbed.home, 'trimmed.txt'), shown(climbed.outcome))
  }

  check('the unpacked ceiling is a round figure of at least 4 GiB', typeof UPDATE_CEILINGS.unpackedBytes === 'number' && UPDATE_CEILINGS.unpackedBytes >= 4 * 1024 ** 3 && UPDATE_CEILINGS.unpackedBytes % 1024 ** 3 === 0, String(UPDATE_CEILINGS.unpackedBytes))
  check('the entries ceiling is a round figure of at least 100,000', typeof UPDATE_CEILINGS.entries === 'number' && UPDATE_CEILINGS.entries >= 100_000 && UPDATE_CEILINGS.entries % 10_000 === 0, String(UPDATE_CEILINGS.entries))
} finally {
  server.closeAllConnections()
  server.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-unchecked-archive: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
export {}
