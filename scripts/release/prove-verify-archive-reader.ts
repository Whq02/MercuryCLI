#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { zipSync } from 'fflate'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STEP = join(ROOT, 'scripts', 'release', 'verifyArchive.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : `${detail ? ` — ${detail}` : ''} — to fix: keep scripts/release/verifyArchive.mjs running checkArchiveBeforeUnpack with updateCeilings() from dist/verify-artifact.mjs on the archive before it unpacks it, failing with the archive's name and the reader's own sentence`}`)
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

const folder: TarMember = { name: 'mercury/', type: '5' }
const manifest: TarMember = { name: 'mercury/manifest.json', data: Buffer.from('{}') }
const zip = (names: Record<string, string>): Buffer => Buffer.from(zipSync(Object.fromEntries(Object.entries(names).map(([name, text]) => [name, Buffer.from(text)]))))

const scratch = mkdtempSync(join(tmpdir(), 'mercury-verify-archive-reader-'))

function step(name: string, bytes: Buffer): { status: number | null; out: string; err: string } {
  const archive = join(scratch, name)
  writeFileSync(archive, bytes)
  const run = spawnSync('node', [STEP, '--archive', archive, '--expect', 'unsigned'], { encoding: 'utf8', timeout: 120_000 })
  return { status: run.status, out: run.stdout ?? '', err: run.stderr ?? '' }
}
const said = (run: { status: number | null; out: string; err: string }): string => JSON.stringify({ status: run.status, out: run.out.slice(0, 200), err: run.err.slice(0, 300) })
const failsWith = (run: { status: number | null; err: string }, name: string, sentence: string): boolean => run.status === 1 && run.err.includes(name) && run.err.includes(sentence)

try {
  if (!existsSync(join(ROOT, 'dist', 'verify-artifact.mjs'))) check('dist/verify-artifact.mjs is built', false, 'run bun run build.ts first')
  else {
    const linkOut = step('fixture-link-out.tar.gz', tarGz([folder, manifest, { name: 'mercury/door', type: '2', link: '../../outside' }]))
    check("a tar the reader refuses (a link out of the folder) fails the step with the reader's sentence and the archive's name", failsWith(linkOut, 'fixture-link-out.tar.gz', 'the archive holds a link that leaves the folder it is unpacked into: "mercury/door"'), said(linkOut))

    const unreadable = step('fixture-unreadable.tar.gz', tarGz([folder, { name: 'mercury/x/', data: tarHeader({ name: 'mercury/hidden-pipe', type: '6' }) }]))
    check("a tar the reader calls unreadable fails the step with the reader's sentence and the archive's name", failsWith(unreadable, 'fixture-unreadable.tar.gz', 'a header gives a file the name of a folder'), said(unreadable))

    const notGzip = step('fixture-not-gzip.tar.gz', Buffer.from('this is not an archive\n'))
    check('a file that is no gzip stream fails the step as unreadable, by name', failsWith(notGzip, 'fixture-not-gzip.tar.gz', 'incorrect header check'), said(notGzip))

    const climbing = step('fixture-climbing.zip', zip({ 'mercury/manifest.json': '{}', '..\\..\\climbed.txt': 'x' }))
    check('the form follows the archive on every host: a .zip is read as a zip, and one with a climbing name fails the step', failsWith(climbing, 'fixture-climbing.zip', 'the archive holds an entry that leaves the folder it is unpacked into: "..\\\\..\\\\climbed.txt"'), said(climbing))

    const commented = step('fixture-commented.zip', Buffer.concat([zip({ 'mercury/manifest.json': '{}' }), Buffer.from('a trailing comment')]))
    check("a zip the reader calls unreadable fails the step with the reader's sentence and the archive's name", failsWith(commented, 'fixture-commented.zip', 'the zip does not close with the one plain end record a release zip has'), said(commented))

    const wellFormedTar = step('fixture-well-formed.tar.gz', tarGz([folder, manifest]))
    check('a well-formed tar passes the reader with one line', wellFormedTar.out.includes("fixture-well-formed.tar.gz: an installed updater's archive check passes (2 entries)"), said(wellFormedTar))
    const wellFormedZip = step('fixture-well-formed.zip', zip({ 'mercury/manifest.json': '{}' }))
    check('a well-formed zip passes the reader with one line', wellFormedZip.out.includes("fixture-well-formed.zip: an installed updater's archive check passes (1 entries)"), said(wellFormedZip))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-verify-archive-reader: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
export {}
