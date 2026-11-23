#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'encoding-coherence-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')

let failures = 0
let checks = 0
let encodingFixHint = ''
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${!ok && encodingFixHint ? ` — ${encodingFixHint}` : ''}`)
}
const section = (t: string): void => {
  encodingFixHint = t.startsWith('§1')
    ? 'fix readFileInRange in src/platform/files/readFileInRange.ts so it decodes by the byte-order mark'
    : t.startsWith('§2')
      ? 'fix mintFileAnchor, checkAnchor or normalizeForAnchor in src/tools/engines/change-transaction/snapshotAnchor.ts, or the content readFileSyncWithMetadata in src/platform/files/syncFileRead.ts returns, so the Read-side and edit-side anchors agree'
      : 'fix writeTextContent in src/platform/files/file.ts so it writes the byte-order mark only when keepBom is set and never twice'
  console.log('\n' + '─'.repeat(72) + '\n' + t)
}

const { readFileInRange } = await import('../../src/platform/files/readFileInRange.ts')
const { readFileSyncWithMetadata } = await import('../../src/platform/files/syncFileRead.ts')
const { mintFileAnchor, checkAnchor, normalizeForAnchor } = await import('../../src/tools/engines/change-transaction/snapshotAnchor.ts')
const { writeTextContent } = await import('../../src/platform/files/file.ts')

const BOM8 = Buffer.from([0xef, 0xbb, 0xbf])
const text = 'héllo\r\nwörld — line two\r\nthird'
const utf16Path = join(SCRATCH, 'sixteen.txt')
writeFileSync(utf16Path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
const bom8Path = join(SCRATCH, 'bom8.txt')
writeFileSync(bom8Path, Buffer.concat([BOM8, Buffer.from(text, 'utf8')]))
const plainPath = join(SCRATCH, 'plain.txt')
writeFileSync(plainPath, Buffer.from(text, 'utf8'))

section('§1 the ranged Read decodes by the byte-order mark')
{
  const sixteen = await readFileInRange(utf16Path)
  check('a UTF-16LE file reads as its text (fast path)', sixteen.content === 'héllo\nwörld — line two\nthird', JSON.stringify(sixteen.content.slice(0, 40)))
  check('…with the true line count', sixteen.totalLines === 3 && sixteen.lineCount === 3)
  check('…and no NUL bytes in what the model sees', !sixteen.content.includes('\u0000'))
  const bom8 = await readFileInRange(bom8Path)
  check('a UTF-8-BOM file reads without the mark (fast path)', bom8.content === 'héllo\nwörld — line two\nthird' && bom8.content.charCodeAt(0) !== 0xfeff)
  const plain = await readFileInRange(plainPath)
  check('a plain UTF-8 file is unchanged', plain.content === 'héllo\nwörld — line two\nthird')
  const ranged = await readFileInRange(utf16Path, 1, 1)
  check('a UTF-16LE line range selects the right line', ranged.content === 'wörld — line two' && ranged.lineCount === 1)

  const bigPath = join(SCRATCH, 'big16.txt')
  const bigLine = 'streaming wörld line\r\n'
  const bigCount = Math.ceil((10 * 1024 * 1024 + 4096) / Buffer.byteLength(bigLine, 'utf16le'))
  writeFileSync(bigPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(bigLine.repeat(bigCount), 'utf16le')]))
  const big = await readFileInRange(bigPath, bigCount - 2, 2)
  check('a UTF-16LE file past the fast-path bound streams as its text', big.content === 'streaming wörld line\nstreaming wörld line', JSON.stringify(big.content.slice(0, 60)))
  check('…with the true total line count (streaming path)', big.totalLines === bigCount + 1, String(big.totalLines))
  const bigHead = await readFileInRange(bigPath, 0, 1)
  check('…and the first streamed line carries no mark', bigHead.content === 'streaming wörld line')
  rmSync(bigPath, { force: true })
}

section('§2 the anchor minted over the Read checks against the edit-side read')
{
  for (const [label, path] of [['UTF-16LE', utf16Path], ['UTF-8 BOM', bom8Path], ['plain', plainPath]] as const) {
    const read = await readFileInRange(path)
    const minted = mintFileAnchor(read.content)
    const editSide = readFileSyncWithMetadata(path)
    const verdict = checkAnchor(minted, editSide.content, path)
    check(`${label}: the anchor minted over the Read's content checks OK against the edit-side content`, verdict.ok === true, JSON.stringify(verdict))
    check(`${label}: the edit-side mint equals the Read-side mint`, mintFileAnchor(editSide.content) === minted)
  }
  check('normalizeForAnchor drops a leading mark and CRLF alike', normalizeForAnchor('\uFEFFa\r\nb') === 'a\nb')
  check('normalizeForAnchor leaves an interior U+FEFF alone (content, not a mark)', normalizeForAnchor('a\uFEFFb') === 'a\uFEFFb')
  const changed = checkAnchor(mintFileAnchor('one'), 'two', plainPath)
  check('a real change is still stale', changed.ok === false && changed.reason === 'stale')
}

section('§3 the text writer keeps a byte-order mark it was told about')
{
  const out16 = join(SCRATCH, 'out16.txt')
  writeTextContent(out16, 'new text', 'utf16le', 'LF', { keepBom: true })
  const bytes16 = readFileSync(out16)
  check('UTF-16LE with keepBom opens FF FE', bytes16[0] === 0xff && bytes16[1] === 0xfe)
  check('…and decodes to the text after the mark', bytes16.subarray(2).toString('utf16le') === 'new text')
  const out8 = join(SCRATCH, 'out8.txt')
  writeTextContent(out8, 'new text', 'utf8', 'LF', { keepBom: true })
  const bytes8 = readFileSync(out8)
  check('UTF-8 with keepBom opens EF BB BF', bytes8[0] === 0xef && bytes8[1] === 0xbb && bytes8[2] === 0xbf)
  check('…and decodes to the text after the mark', bytes8.subarray(3).toString('utf8') === 'new text')
  const outPlain = join(SCRATCH, 'outplain.txt')
  writeTextContent(outPlain, 'new text', 'utf8', 'LF')
  check('without keepBom (and off the .ps1 arm) no mark is invented', readFileSync(outPlain).toString('utf8') === 'new text')
  const outTwice = join(SCRATCH, 'outtwice.txt')
  writeTextContent(outTwice, '\uFEFFalready', 'utf8', 'LF', { keepBom: true })
  const twice = readFileSync(outTwice)
  check('a content that already opens with the mark gets exactly one', twice[0] === 0xef && twice.subarray(3).toString('utf8') === 'already')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
