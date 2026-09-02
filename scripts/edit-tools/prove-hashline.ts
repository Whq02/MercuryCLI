#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-hashline.ts — per-line content-hash anchors
//  (the hashline layer): the pure core laws.
//
//  Laws:
//    L. pure line-anchor math — mint/format/parse round-trip · the
//       presentation sibling is row-for-row the plain shape with hashes
//       spliced in · identical lines share a hash and never an address
//       (position is the disambiguator) · CRLF/BOM/NFC/backslash-u hash
//       domain · neighborhood answers clamp and cap · relocation
//       candidates are distance-ordered and bounded
//
//    R. the anchored read mode through the REAL FileReadTool — plain reads
//       byte-identical (strip the hashes, get the plain bytes; param
//       absent, gate =0, and the schema key itself all pinned) · file-state
//       registration parity · self-verifying rows · absolute numbering in
//       windows with the ra: tail · CRLF/BOM end-to-end · the teaching line
//       rides the gate
//
//    E. hash-qualified hunks through the REAL FileEditTool — presented-
//       prefix round-trip · fully-qualified batches carry their own
//       staleness contract (expected_anchor optional; mixed batches still
//       demand it) · THE STALENESS LAW: a diverged/oob endpoint refuses
//       typed with current neighborhood anchors + moved_to candidates and
//       writes NOTHING (batch atomicity) · twins/escape-class/CRLF/BOM
//       end-to-end (the escape class carries the NUL arm: a backslash-
//       u0000 spelling round-trips as six characters, never a raw byte —
//       the live incident class) · file-state parity with the
//       exact-string lane · gate =0 restores today's exact refusals
//
//    N. read-free chaining — an anchor-addressed success answers fresh
//       anchors for every touched region of the UPDATED content (deltas
//       carried, deletions answer the seam) and a chained edit re-aims
//       straight off the answer; plain-hunk and exact-string result text
//       stays byte-identical
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-hashline.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hashline-home-'))
process.env.MERCURY_SIMPLE = '1'
delete process.env.MERCURY_LINE_ANCHORS
delete process.env.MERCURY_CHANGE_RECEIPTS

// self-reexec probe: print the live Read input-schema keys and exit (the
// schema is lazily built ONCE per process, so gate-shape checks need a
// fresh process per env value; the gate value rides argv — Bun spawnSync
// drops env-object mutations, argv never lies)
if (process.argv.includes('--print-read-schema-keys')) {
  const gateArg = process.argv.find(a => a.startsWith('--gate='))
  if (gateArg) process.env.MERCURY_LINE_ANCHORS = gateArg.slice('--gate='.length)
  const { FileReadTool: tool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const shape = (tool as { inputSchema: { shape?: Record<string, unknown> } }).inputSchema.shape ?? {}
  console.log(JSON.stringify(Object.keys(shape)))
  process.exit(0)
}

const {
  LINE_ANCHOR_HEX,
  addAnchoredLineNumbers,
  anchorDomainLines,
  findRelocationCandidates,
  formatLineAnchor,
  mintLineHash,
  neighborhoodRows,
  parseHashedLinesSpelling,
  parseLineRef,
  verifyLineRef,
} = await import('../../src/services/changeTransaction/lineAnchors.ts')
const { addLineNumbers, stripLineNumberPrefix } = await import('../../src/utils/file.ts')
const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — hashline proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

// Escape-class raw material built WITHOUT escape literals in this source
// (the banked lesson: the Edit tool rewrites backslash-u spellings — the
//  memory card edit-tool-rewrites-backslash-u-escapes; scripts spell
//  control bytes via fromCharCode, never as an escape literal).
const BACKSLASH = String.fromCharCode(92)
const LITERAL_ESC_SPELLING = `${BACKSLASH}u001b` // the six characters
const RAW_ESC = String.fromCharCode(27) // the one byte
const LITERAL_NUL_SPELLING = `${BACKSLASH}u0000`
const LITERAL_BEL_SPELLING = `${BACKSLASH}u0007`
const BOM = String.fromCharCode(0xfeff)
const E_ACUTE_NFC = String.fromCharCode(0xe9)
const E_ACUTE_NFD = `e${String.fromCharCode(0x301)}`

// ── L. pure line-anchor math ────────────────────────────────────────────────
section('L. pure line-anchor math')
{
  const h = mintLineHash('const x = 1')
  check('L1 mint shape', new RegExp(`^[0-9a-f]{${LINE_ANCHOR_HEX}}$`).test(h))
  check('L1b mint deterministic + content-sensitive', mintLineHash('const x = 1') === h && mintLineHash('const x = 2') !== h)

  const ref = parseLineRef(formatLineAnchor(12, 'const x = 1'))
  check('L2 format/parse round-trip', ref !== null && ref.line === 12 && ref.hash === h)
  check('L2b parse refuses non-refs', parseLineRef('12') === null && parseLineRef(`12#${h}x`) === null && parseLineRef('0#abcd') === null)

  const content = 'alpha\nbeta\ngamma'
  const anchored = addAnchoredLineNumbers({ content, startLine: 1, compact: true })
  const rows = anchored.split('\n')
  const domain = anchorDomainLines(content)
  check('L3 anchored rows carry parseable self-verifying prefixes', rows.length === 3 && rows.every((row, i) => {
    const m = /^(\d+#[0-9a-f]+)\t(.*)$/.exec(row)
    if (!m) return false
    const parsed = parseLineRef(m[1]!)
    return parsed !== null && parsed.line === i + 1 && verifyLineRef(domain, parsed).ok && m[2] === domain[i]
  }))

  const stripHashes = (s: string): string => s.replace(/#[0-9a-f]{4}(\t|→)/g, '$1')
  check('L4 compact anchored minus hashes == plain compact', stripHashes(anchored) === addLineNumbers({ content, startLine: 1 }))
  const legacyAnchored = addAnchoredLineNumbers({ content, startLine: 999998, compact: false })
  const legacyRows = legacyAnchored.split('\n')
  check(
    'L4b legacy pad law (11-wide prefix; 6-digit-and-up unpadded)',
    legacyRows[0] === `999998#${mintLineHash('alpha')}→alpha` &&
      addAnchoredLineNumbers({ content: 'x', startLine: 7, compact: false }) === `     7#${mintLineHash('x')}→x`,
  )

  const twins = 'a\n}\nb\n}\nc'
  const twinDomain = anchorDomainLines(twins)
  const closeBrace = mintLineHash('}')
  check('L5 identical lines share a hash, never an address', formatLineAnchor(2, '}') === `2#${closeBrace}` && formatLineAnchor(4, '}') === `4#${closeBrace}` && formatLineAnchor(2, '}') !== formatLineAnchor(4, '}'))
  check('L5b position is the authority', verifyLineRef(twinDomain, { line: 4, hash: closeBrace }).ok)
  const misaim = verifyLineRef(twinDomain, { line: 3, hash: closeBrace })
  check('L5c a mis-aimed position refuses with the current hash', !misaim.ok && misaim.ok === false && misaim.currentHash === mintLineHash('b'))
  const oob = verifyLineRef(twinDomain, { line: 9, hash: closeBrace })
  check('L5d out-of-bounds refuses with currentHash null', !oob.ok && oob.ok === false && oob.currentHash === null)

  const crlfDomain = anchorDomainLines('x\r\ny\r\n')
  check('L6 CRLF anchors in the LF domain (final newline not a line)', crlfDomain.length === 2 && crlfDomain[0] === 'x' && mintLineHash(crlfDomain[1]!) === mintLineHash('y'))
  check('L6b domain edges', anchorDomainLines('').length === 0 && anchorDomainLines('\n').length === 1 && anchorDomainLines('a').length === 1)

  const bomDomain = anchorDomainLines(`${BOM}hello\nworld`)
  const bomRow = addAnchoredLineNumbers({ content: `${BOM}hello\nworld`, startLine: 1, compact: true }).split('\n')[0]!
  check('L7 a leading BOM never reaches line 1', bomDomain[0] === 'hello' && bomRow === `1#${mintLineHash('hello')}\thello`)

  check('L8 codepoint-different content hashes differently (no NFC)', mintLineHash(E_ACUTE_NFC) !== mintLineHash(E_ACUTE_NFD))

  const escLine = `data: '${LITERAL_ESC_SPELLING}[1;2D'`
  check('L9 the backslash-u spelling and the raw byte are distinct content', mintLineHash(escLine) !== mintLineHash(`data: '${RAW_ESC}[1;2D'`))
  const escDomain = anchorDomainLines(`send:\n${escLine}\nend`)
  check('L9b an escape-bearing line verifies by its own anchor', verifyLineRef(escDomain, { line: 2, hash: mintLineHash(escLine) }).ok)
  // The NUL arm (fresh box evidence: the exact-string Edit AND
  // Write tools rewrote a backslash-u0000 spelling into a LITERAL NUL
  // byte, corrupting the file to binary-detected).
  const nulLine = `const nul = '${LITERAL_NUL_SPELLING}'`
  check(
    'L9c the backslash-u0000 spelling and the NUL byte are distinct content',
    mintLineHash(nulLine) !== mintLineHash(`const nul = '${String.fromCharCode(0)}'`) &&
      mintLineHash(`x ${LITERAL_BEL_SPELLING}`) !== mintLineHash(`x ${String.fromCharCode(7)}`),
  )

  const sixty = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
  const sixtyDomain = anchorDomainLines(sixty)
  const hood = neighborhoodRows(sixtyDomain, 30, 31)
  check('L10 neighborhood = span ± context', hood.length === 6 && hood[0] === `28#${mintLineHash('line 28')}\tline 28` && hood[5]!.startsWith('33#'))
  const edge = neighborhoodRows(sixtyDomain, 1, 1)
  check('L10b neighborhood clamps at the file edge', edge.length === 3 && edge[0]!.startsWith('1#'))
  const capped = neighborhoodRows(sixtyDomain, 5, 56)
  check('L10c neighborhood caps with a middle elision', capped.length === 30 && capped.some(r => r.includes('more line(s)')) && capped[0]!.startsWith('3#') && capped[29]!.startsWith('58#'))

  const moved = Array.from({ length: 60 }, (_, i) => (i === 4 || i === 46 ? 'const target = 1' : `filler ${i + 1}`)).join('\n')
  const movedDomain = anchorDomainLines(moved)
  const targetHash = mintLineHash('const target = 1')
  check('L11 relocation candidates are distance-ordered', JSON.stringify(findRelocationCandidates(movedDomain, targetHash, 42)) === JSON.stringify([47, 5]))
  check('L11b relocation radius bounds the search', findRelocationCandidates(movedDomain, targetHash, 42, 3).length === 0 && JSON.stringify(findRelocationCandidates(movedDomain, targetHash, 42, 5)) === JSON.stringify([47]))
  check('L11c relocation cap holds', findRelocationCandidates(anchorDomainLines('same\nsame\nsame\nsame\nsame'), mintLineHash('same'), 3).length === 3)

  const blanks = anchorDomainLines('a\n\nb\n\nc')
  check('L12 empty lines hash stably and disambiguate by position', mintLineHash('') === mintLineHash('') && blanks[1] === '' && blanks[3] === '' && formatLineAnchor(2, '') !== formatLineAnchor(4, ''))

  const ph = mintLineHash('x')
  check('L13 plain spellings are not hash-shaped (null — the plain grammar owns them)', parseHashedLinesSpelling('12') === null && parseHashedLinesSpelling('12-18') === null)
  const single = parseHashedLinesSpelling(`12#${ph}`)
  const range = parseHashedLinesSpelling(`12#${ph}-18#${mintLineHash('y')}`)
  check('L13b single and range parse whole', single !== null && single.ok && single.ok === true && single.start.line === 12 && single.end.line === 12 && range !== null && range.ok && range.ok === true && range.end.line === 18)
  const half = parseHashedLinesSpelling(`12#${ph}-18`)
  check('L13c a half-qualified range refuses typed', half !== null && !half.ok && half.ok === false && half.message.includes('BOTH endpoint anchors'))
  const badHex = parseHashedLinesSpelling('12#ZZZZ')
  check('L13d bad hex refuses typed, never falls through', badHex !== null && !badHex.ok)
  const backwards = parseHashedLinesSpelling(`18#${ph}-12#${ph}`)
  check('L13e a backwards range refuses', backwards !== null && !backwards.ok && backwards.ok === false && backwards.message.includes('ends before'))
  const twoDash = parseHashedLinesSpelling(`1#${ph}-2#${ph}-3#${ph}`)
  check('L13f two dashes refuse', twoDash !== null && !twoDash.ok)
}

// ── R. the anchored read mode through the real tool ─────────────────────────
section('R. the anchored read mode (real FileReadTool)')
{
  type ReadStamp = { content: string; timestamp: number; offset: number | undefined; limit: number | undefined }
  const makeReadContext = (readFileState: Map<string, ReadStamp>) =>
    ({
      readFileState,
      userModified: false,
      updateFileHistoryState: () => {},
      dynamicSkillDirTriggers: new Set<string>(),
      nestedMemoryAttachmentTriggers: new Set<string>(),
      abortController: new AbortController(),
      getAppState: () => ({
        toolPermissionContext: getEmptyToolPermissionContext(),
      }),
    }) as never as { readFileState: Map<string, ReadStamp> }

  const readViaTool = async (
    path: string,
    ctx: ReturnType<typeof makeReadContext>,
    extra: Record<string, unknown> = {},
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    try {
      const result = await (FileReadTool as unknown as { call: Function }).call(
        { file_path: path, ...extra },
        ctx,
        null,
        { uuid: '00000000-0000-0000-0000-000000000001', message: { id: 'msg_fixture' } },
      )
      const block = (
        FileReadTool as unknown as { mapToolResultToToolResultBlockParam: Function }
      ).mapToolResultToToolResultBlockParam(result.data, 'toolu_read')
      return { ok: true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const fixtures = mkdtempSync(join(tmpdir(), 'hashline-fixture-'))
  const plainFile = join(fixtures, 'plain.txt')
  writeFileSync(plainFile, 'one\ntwo\nthree\nfour\nfive\n')
  const crlfFile = join(fixtures, 'crlf.txt')
  writeFileSync(crlfFile, 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n')
  const bomFile = join(fixtures, 'bom.txt')
  writeFileSync(bomFile, `${BOM}hello\nworld\n`)

  const stateA = new Map<string, ReadStamp>()
  const ctxA = makeReadContext(stateA)
  const plainRead = await readViaTool(plainFile, ctxA)
  const stateB = new Map<string, ReadStamp>()
  const ctxB = makeReadContext(stateB)
  const anchoredRead = await readViaTool(plainFile, ctxB, { line_anchors: true })

  const stripHashes = (s: string): string => s.replace(/#[0-9a-f]{4}(\t|→)/g, '$1')
  check('R1 plain read carries no anchors and the fa: tail', plainRead.ok && plainRead.ok === true && !/\d#[0-9a-f]{4}\t/.test(plainRead.text) && plainRead.text.includes('(anchor: fa:'))
  check(
    'R1b anchored minus hashes == the plain read, tail included (byte identity)',
    plainRead.ok && anchoredRead.ok && anchoredRead.ok === true && plainRead.ok === true && stripHashes(anchoredRead.text) === plainRead.text,
  )

  const entryA = stateA.get(plainFile)
  const entryB = stateB.get(plainFile)
  check(
    'R2 file-state parity: the anchored read records EXACTLY the plain entry',
    entryA !== undefined &&
      entryB !== undefined &&
      entryA.content === entryB.content &&
      entryA.offset === entryB.offset &&
      entryA.limit === entryB.limit &&
      entryA.timestamp === entryB.timestamp,
  )

  const domain = anchorDomainLines(entryB?.content ?? '')
  const anchoredRows = (anchoredRead.ok && anchoredRead.ok === true ? anchoredRead.text : '')
    .split('\n')
    .filter(row => /^\d+#/.test(row))
  // The plain read presents the after-final-newline position as a numbered
  // empty line (row 6 here); the anchored twin mirrors it row-for-row. Its
  // anchor addresses NOTHING in the edit domain (countLines: 5) — the pin
  // is that real rows verify and the phantom row REFUSES typed instead of
  // aliasing a line that does not exist.
  check(
    'R3 anchored rows mirror the plain rows; content rows self-verify against the recorded content',
    anchoredRows.length === 6 &&
      anchoredRows.slice(0, 5).every(row => {
        const m = /^(\d+#[0-9a-f]+)\t(.*)$/.exec(row)
        if (!m) return false
        const ref = parseLineRef(m[1]!)
        return ref !== null && verifyLineRef(domain, ref).ok
      }),
  )
  const phantomRef = parseLineRef(anchoredRows[5]!.split(String.fromCharCode(9))[0]!)
  const phantomCheck = phantomRef === null ? null : verifyLineRef(domain, phantomRef)
  check(
    'R3c the phantom after-final-newline row refuses out-of-bounds, never aliases',
    phantomRef !== null && phantomRef.line === 6 && phantomCheck !== null && !phantomCheck.ok && phantomCheck.ok === false && phantomCheck.currentHash === null,
  )
  check(
    'R3b the stripper knows the anchored prefix',
    stripLineNumberPrefix(`3#${mintLineHash('three')}\tthree`) === 'three' && stripLineNumberPrefix('3\tthree') === 'three',
  )

  const stateW = new Map<string, ReadStamp>()
  const windowRead = await readViaTool(plainFile, makeReadContext(stateW), { line_anchors: true, offset: 2, limit: 2 })
  const windowRows = (windowRead.ok && windowRead.ok === true ? windowRead.text : '').split('\n')
  check(
    'R4 a windowed anchored read numbers absolutely and keeps the ra: tail',
    windowRead.ok &&
      windowRead.ok === true &&
      windowRows[0] === `2#${mintLineHash('two')}\ttwo` &&
      windowRows[1] === `3#${mintLineHash('three')}\tthree` &&
      windowRead.text.includes('(anchor: ra:') &&
      windowRead.text.includes(':L2+2)'),
  )

  const crlfRead = await readViaTool(crlfFile, makeReadContext(new Map()), { line_anchors: true })
  const lfRead = anchoredRead
  check(
    'R5 a CRLF file anchors byte-identically to its LF twin (rows carry no CR)',
    crlfRead.ok && crlfRead.ok === true && lfRead.ok && lfRead.ok === true &&
      !crlfRead.text.includes(String.fromCharCode(13)) &&
      crlfRead.text.split('\n').filter(r => /^\d+#/.test(r)).join('\n') ===
        lfRead.text.split('\n').filter(r => /^\d+#/.test(r)).join('\n'),
  )

  const bomRead = await readViaTool(bomFile, makeReadContext(new Map()), { line_anchors: true })
  check(
    'R6 a BOM never reaches line 1 of an anchored read',
    bomRead.ok && bomRead.ok === true && bomRead.text.split('\n')[0] === `1#${mintLineHash('hello')}\thello`,
  )

  process.env.MERCURY_LINE_ANCHORS = '0'
  const gatedOff = await readViaTool(plainFile, makeReadContext(new Map()), { line_anchors: true })
  check(
    'R7 gate =0 ⇒ the opt-in never leaks (plain rows even when the param is passed)',
    gatedOff.ok && gatedOff.ok === true && !/\d#[0-9a-f]{4}\t/.test(gatedOff.text) && stripHashes(gatedOff.text) === gatedOff.text,
  )
  const promptOff = await (FileReadTool as unknown as { prompt: Function }).prompt()
  delete process.env.MERCURY_LINE_ANCHORS
  const promptOn = await (FileReadTool as unknown as { prompt: Function }).prompt()
  check(
    'R8 the teaching line rides the gate',
    !String(promptOff).includes('line_anchors') && String(promptOn).includes('line_anchors') && String(promptOn).includes('N#hhhh'),
  )

  const probe = (gate: string | null): string[] => {
    const args = [process.argv[1]!, '--print-read-schema-keys']
    if (gate !== null) args.push(`--gate=${gate}`)
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' })
    try {
      return JSON.parse(String(run.stdout).trim().split('\n').pop() ?? '[]') as string[]
    } catch {
      return [`<probe failed: ${String(run.stderr).slice(0, 200)}>`]
    }
  }
  const keysDefault = probe(null)
  const keysOff = probe('0')
  check('R9 schema keys: default-on carries line_anchors', keysDefault.includes('line_anchors'), keysDefault.join(','))
  check(
    'R9b schema keys: =0 is the exact base field set',
    JSON.stringify(keysOff) === JSON.stringify(['file_path', 'offset', 'limit', 'pages']),
    keysOff.join(','),
  )
}

// ── the shared edit harness (sections E and N) ──────────────────────────────
type EditStamp = { content: string; timestamp: number; offset: number | undefined; limit: number | undefined }
const makeEditContext = () => {
  const readFileState = new Map<string, EditStamp>()
  return {
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as never as { readFileState: Map<string, EditStamp> }
}
const primeRead = (ctx: { readFileState: Map<string, EditStamp> }, path: string): void => {
  ctx.readFileState.set(path, {
    content: readFileSync(path, 'utf8').replaceAll(String.fromCharCode(13, 10), '\n'),
    timestamp: Date.now() + 60_000,
    offset: undefined,
    limit: undefined,
  })
}
const editViaTool = async (
  input: Record<string, unknown>,
  ctx: ReturnType<typeof makeEditContext>,
): Promise<
  { ok: true; effect: Record<string, unknown>; text: string } | { ok: false; error: string }
> => {
  const validation = await (FileEditTool as unknown as { validateInput: Function }).validateInput(input, ctx)
  if (validation.result === false) {
    return { ok: false, error: String(validation.message) }
  }
  try {
    const result = await (FileEditTool as unknown as { call: Function }).call(input, ctx, null, {
      uuid: '00000000-0000-0000-0000-000000000002',
      message: { id: 'msg_fixture' },
    })
    const block = (
      FileEditTool as unknown as { mapToolResultToToolResultBlockParam: Function }
    ).mapToolResultToToolResultBlockParam(result.data, 'toolu_edit')
    return {
      ok: true,
      effect: result.effect,
      text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── E. hash-qualified hunks through the real Edit door ──────────────────────
section('E. hash-qualified hunks (real FileEditTool)')
{
  const fixtures = mkdtempSync(join(tmpdir(), 'hashline-edit-fixture-'))
  const anchorFor = (text: string): string => mintLineHash(text)

  // E1: round-trip from the PRESENTED prefix.
  const fileA = join(fixtures, 'a.ts')
  writeFileSync(fileA, 'const a = 1\nconst b = 2\nconst c = 3\n')
  const presented = addAnchoredLineNumbers({ content: readFileSync(fileA, 'utf8'), startLine: 1, compact: true })
  const row2prefix = presented.split('\n')[1]!.split(String.fromCharCode(9))[0]!
  const ctx1 = makeEditContext()
  primeRead(ctx1, fileA)
  const e1 = await editViaTool({ file_path: fileA, hunks: [{ lines: row2prefix, replace: 'const b = 20' }] }, ctx1)
  check('E1 a presented prefix round-trips into an applied edit', e1.ok && e1.ok === true && readFileSync(fileA, 'utf8') === 'const a = 1\nconst b = 20\nconst c = 3\n')
  check('E1b the effect is the anchored-hunk lane', e1.ok && e1.ok === true && String(e1.effect.evidence).includes('anchored hunk'))

  // E2: a fully-qualified batch needs no expected_anchor; mixed still does.
  const fileB = join(fixtures, 'b.txt')
  writeFileSync(fileB, 'one\ntwo\nthree\nfour\nfive\n')
  const ctx2 = makeEditContext()
  primeRead(ctx2, fileB)
  const e2 = await editViaTool(
    {
      file_path: fileB,
      hunks: [
        { lines: `2#${anchorFor('two')}`, replace: 'TWO' },
        { lines: `4#${anchorFor('four')}-5#${anchorFor('five')}`, replace: 'TAIL' },
      ],
    },
    ctx2,
  )
  check('E2 fully anchor-qualified batch applies without expected_anchor', e2.ok && e2.ok === true && readFileSync(fileB, 'utf8') === 'one\nTWO\nthree\nTAIL\n')
  const fileB2 = join(fixtures, 'b2.txt')
  writeFileSync(fileB2, 'one\ntwo\nthree\n')
  const ctx2b = makeEditContext()
  primeRead(ctx2b, fileB2)
  const e2b = await editViaTool(
    { file_path: fileB2, hunks: [{ lines: `2#${anchorFor('two')}`, replace: 'TWO' }, { lines: '3', replace: 'THREE' }] },
    ctx2b,
  )
  check(
    'E2b a MIXED batch still demands expected_anchor (and teaches the alternative)',
    !e2b.ok && e2b.ok === false && e2b.error.includes('hunks require expected_anchor') && e2b.error.includes('anchor-qualify EVERY hunk'),
  )
  check('E2c the mixed refusal wrote nothing', readFileSync(fileB2, 'utf8') === 'one\ntwo\nthree\n')

  // E3: THE STALENESS LAW — self-drift refuses typed with the recovery.
  const fileC = join(fixtures, 'c.txt')
  writeFileSync(fileC, 'alpha\nbravo-v2\ncharlie\n')
  const ctx3 = makeEditContext()
  primeRead(ctx3, fileC)
  const e3 = await editViaTool(
    { file_path: fileC, hunks: [{ lines: `2#${anchorFor('bravo-v1')}`, replace: 'x' }] },
    ctx3,
  )
  check(
    'E3 a diverged anchor refuses typed and answers the current anchors',
    !e3.ok &&
      e3.ok === false &&
      e3.error.includes('stale line anchor') &&
      e3.error.includes(`current: 2#${anchorFor('bravo-v2')}`) &&
      e3.error.includes('current anchors (lines 1-3):') &&
      e3.error.includes(`2#${anchorFor('bravo-v2')}\tbravo-v2`) &&
      e3.error.includes('Nothing was written'),
  )
  check('E3b the stale refusal wrote nothing', readFileSync(fileC, 'utf8') === 'alpha\nbravo-v2\ncharlie\n')

  // E4: a line that MOVED is answered as moved_to, still refused.
  const fileD = join(fixtures, 'd.txt')
  writeFileSync(fileD, 'inserted-1\ninserted-2\nkeep\nconst target = 9\ntail\n')
  const ctx4 = makeEditContext()
  primeRead(ctx4, fileD)
  const e4 = await editViaTool(
    { file_path: fileD, hunks: [{ lines: `2#${anchorFor('const target = 9')}`, replace: 'x' }] },
    ctx4,
  )
  check(
    'E4 a moved line is refused WITH the moved_to candidate',
    !e4.ok && e4.ok === false && e4.error.includes(`moved_to: 4#${anchorFor('const target = 9')}`),
  )

  // E5: batch atomicity — one stale hunk, zero writes, named exactly.
  const fileE = join(fixtures, 'e.txt')
  writeFileSync(fileE, 'l1\nl2\nl3\nl4\nl5\n')
  const ctx5 = makeEditContext()
  primeRead(ctx5, fileE)
  const e5 = await editViaTool(
    {
      file_path: fileE,
      hunks: [
        { lines: `1#${anchorFor('l1')}`, replace: 'L1' },
        { lines: `3#${anchorFor('stale-spelling')}`, replace: 'L3' },
        { lines: `5#${anchorFor('l5')}`, replace: 'L5' },
      ],
    },
    ctx5,
  )
  check('E5 one stale hunk refuses the WHOLE batch, naming it', !e5.ok && e5.ok === false && e5.error.includes('hunk 2:') && e5.error.includes('stale line anchor'))
  check('E5b atomicity: zero writes', readFileSync(fileE, 'utf8') === 'l1\nl2\nl3\nl4\nl5\n')

  // E6: identical twins address uniquely by position.
  const fileF = join(fixtures, 'f.ts')
  writeFileSync(fileF, 'if (a) {\n}\nif (b) {\n}\n')
  const ctx6 = makeEditContext()
  primeRead(ctx6, fileF)
  const e6 = await editViaTool(
    { file_path: fileF, hunks: [{ lines: `4#${anchorFor('}')}`, replace: '} // b-close' }] },
    ctx6,
  )
  check('E6 the SECOND twin edits; the first is untouched', e6.ok && e6.ok === true && readFileSync(fileF, 'utf8') === 'if (a) {\n}\nif (b) {\n} // b-close\n')

  // E7: the escape class killed by construction (the memory-card disease
  // edit-tool-rewrites-backslash-u-escapes: an exact-string old_string
  // carrying the six-character spelling never matches; the anchor address
  // carries no old_string at all).
  const fileG = join(fixtures, 'g.ts')
  const escRow = `  data: '${LITERAL_ESC_SPELLING}[1;2D',`
  writeFileSync(fileG, `send([\n${escRow}\n])\n`)
  const ctx7 = makeEditContext()
  primeRead(ctx7, fileG)
  const e7 = await editViaTool(
    { file_path: fileG, hunks: [{ lines: `2#${anchorFor(escRow)}`, replace: `  data: shiftLeft(),` }] },
    ctx7,
  )
  check('E7 an escape-bearing line edits by anchor without any old_string', e7.ok && e7.ok === true && readFileSync(fileG, 'utf8') === `send([\n  data: shiftLeft(),\n])\n`)

  // E7b: the NUL arm end-to-end (the live incident class: a
  // backslash-u0000 spelling rewritten to a raw control byte turns a text
  // file binary-detected). An anchor-addressed edit of a NUL-spelling line
  // — with the spelling in the REPLACEMENT body too — round-trips the six
  // characters AS characters: no 0x00 byte, no 0x1b byte, the sibling
  // line untouched byte-exact. Byte checks ride Buffer, deliberately: a
  // shell `grep -c $'\x00'` is vacuous (bash truncates at the NUL).
  const fileG2 = join(fixtures, 'g2.ts')
  const nulRow = `const nul = '${LITERAL_NUL_SPELLING}'`
  const belRow = `const bel = '${LITERAL_BEL_SPELLING}'`
  writeFileSync(fileG2, `${nulRow}\n${belRow}\n`)
  const ctx7b = makeEditContext()
  primeRead(ctx7b, fileG2)
  const e7b = await editViaTool(
    {
      file_path: fileG2,
      hunks: [{ lines: `1#${anchorFor(nulRow)}`, replace: `${nulRow} // kept as characters` }],
    },
    ctx7b,
  )
  const g2bytes = readFileSync(fileG2)
  check(
    'E7b a NUL-spelling line round-trips as six characters — the file stays text',
    e7b.ok &&
      e7b.ok === true &&
      !g2bytes.includes(0) &&
      !g2bytes.includes(27) &&
      g2bytes.toString('utf8') === `${nulRow} // kept as characters\n${belRow}\n`,
  )

  // E8: file-state parity with the exact-string lane.
  const twinX = join(fixtures, 'twin-x.txt')
  const twinY = join(fixtures, 'twin-y.txt')
  writeFileSync(twinX, 'one\ntwo\nthree\n')
  writeFileSync(twinY, 'one\ntwo\nthree\n')
  const ctxX = makeEditContext()
  const ctxY = makeEditContext()
  primeRead(ctxX, twinX)
  primeRead(ctxY, twinY)
  const eX = await editViaTool({ file_path: twinX, old_string: 'two', new_string: 'TWO' }, ctxX)
  const eY = await editViaTool({ file_path: twinY, hunks: [{ lines: `2#${anchorFor('two')}`, replace: 'TWO' }] }, ctxY)
  const stampX = ctxX.readFileState.get(twinX)
  const stampY = ctxY.readFileState.get(twinY)
  check(
    'E8 post-edit read-state parity with the exact-string lane',
    eX.ok && eY.ok &&
      stampX !== undefined &&
      stampY !== undefined &&
      stampX.content === stampY.content &&
      stampX.offset === stampY.offset &&
      stampX.limit === stampY.limit &&
      stampX.content === 'one\nTWO\nthree\n',
  )

  // E9: gate =0 restores today's exact refusals (live read, same process).
  const fileH = join(fixtures, 'h.txt')
  writeFileSync(fileH, 'one\ntwo\n')
  const ctx9 = makeEditContext()
  primeRead(ctx9, fileH)
  process.env.MERCURY_LINE_ANCHORS = '0'
  const e9 = await editViaTool(
    { file_path: fileH, expected_anchor: mintFileAnchor(readFileSync(fileH, 'utf8')), hunks: [{ lines: `2#${anchorFor('two')}`, replace: 'TWO' }] },
    ctx9,
  )
  check(
    "E9 gate =0 ⇒ the hash spelling refuses with today's exact parse message",
    !e9.ok && e9.ok === false && e9.error.includes(`hunk 1: lines '2#${anchorFor('two')}' does not parse — use "N" or "N-M" (1-based, inclusive)`),
  )
  const e9b = await editViaTool({ file_path: fileH, hunks: [{ lines: `2#${anchorFor('two')}`, replace: 'TWO' }] }, ctx9)
  check(
    'E9b gate =0 ⇒ the anchor requirement keeps its short form',
    !e9b.ok && e9b.ok === false && e9b.error.includes('hunks require expected_anchor') && !e9b.error.includes('anchor-qualify'),
  )
  delete process.env.MERCURY_LINE_ANCHORS

  // E10: CRLF preserved end-to-end.
  const fileI = join(fixtures, 'i.txt')
  const CRLF = String.fromCharCode(13, 10)
  writeFileSync(fileI, `one${CRLF}two${CRLF}three${CRLF}`)
  const ctx10 = makeEditContext()
  primeRead(ctx10, fileI)
  const e10 = await editViaTool({ file_path: fileI, hunks: [{ lines: `2#${anchorFor('two')}`, replace: 'TWO' }] }, ctx10)
  check('E10 CRLF endings survive an anchored edit', e10.ok && e10.ok === true && readFileSync(fileI, 'utf8') === `one${CRLF}TWO${CRLF}three${CRLF}`)

  // E11: a BOM'd file keeps its BOM and line 1 addresses by the visible text.
  const fileJ = join(fixtures, 'j.txt')
  writeFileSync(fileJ, `${BOM}hello\nworld\n`)
  const ctx11 = makeEditContext()
  primeRead(ctx11, fileJ)
  const e11 = await editViaTool({ file_path: fileJ, hunks: [{ lines: `1#${anchorFor('hello')}`, replace: 'HELLO' }] }, ctx11)
  check('E11 a BOM file edits by the visible line-1 anchor and keeps its BOM', e11.ok && e11.ok === true && readFileSync(fileJ, 'utf8') === `${BOM}HELLO\nworld\n`)
  // The sibling root-fix pin: the PLAIN hunks lane had the same defect
  // (line-1 replace spliced the raw text and silently dropped the mark —
  // a byte the model never observed); the owner now plans over the
  // BOM-stripped body and re-attaches on write for both spellings.
  const fileJ2 = join(fixtures, 'j2.txt')
  writeFileSync(fileJ2, `${BOM}hello\nworld\n`)
  const ctx11b = makeEditContext()
  primeRead(ctx11b, fileJ2)
  const e11b = await editViaTool(
    { file_path: fileJ2, expected_anchor: mintFileAnchor(readFileSync(fileJ2, 'utf8')), hunks: [{ lines: '1', replace: 'HELLO' }] },
    ctx11b,
  )
  check('E11b the plain-spelling hunk keeps the BOM too (root fix, not a hashline special)', e11b.ok && e11b.ok === true && readFileSync(fileJ2, 'utf8') === `${BOM}HELLO\nworld\n`)

  // E12: a provided stale file anchor still refuses FIRST (belt kept).
  const fileK = join(fixtures, 'k.txt')
  writeFileSync(fileK, 'one\ntwo\n')
  const ctx12 = makeEditContext()
  primeRead(ctx12, fileK)
  const e12 = await editViaTool(
    { file_path: fileK, expected_anchor: 'fa:000000000000', hunks: [{ lines: `2#${anchorFor('two')}`, replace: 'TWO' }] },
    ctx12,
  )
  check('E12 a stale expected_anchor beside fresh line anchors still refuses first', !e12.ok && e12.ok === false && e12.error.includes('Stale anchor'))

  // E13: out-of-bounds hash ref gets the recovery-bearing refusal.
  const fileL = join(fixtures, 'l.txt')
  writeFileSync(fileL, 'one\ntwo\n')
  const ctx13 = makeEditContext()
  primeRead(ctx13, fileL)
  const e13 = await editViaTool({ file_path: fileL, hunks: [{ lines: `9#${anchorFor('two')}`, replace: 'x' }] }, ctx13)
  check(
    'E13 an out-of-bounds ref answers the tail neighborhood, not a bare count',
    !e13.ok && e13.ok === false && e13.error.includes('the file has 2 line(s)') && e13.error.includes(`2#${anchorFor('two')}\ttwo`),
  )
}

// ── N. read-free chaining off the success answer ────────────────────────────
section('N. read-free chaining (the success answer)')
{
  const fixtures = mkdtempSync(join(tmpdir(), 'hashline-chain-fixture-'))
  const anchorFor = (text: string): string => mintLineHash(text)

  // N1: the success text answers fresh anchors for the touched region, and
  // a SECOND edit re-aims straight off that answer — no re-read anywhere.
  const fileA = join(fixtures, 'chain.txt')
  writeFileSync(fileA, 'head\nalpha\nbeta\ngamma\ntail\n')
  const ctx = makeEditContext()
  primeRead(ctx, fileA)
  const n1 = await editViaTool(
    {
      file_path: fileA,
      hunks: [{ lines: `2#${anchorFor('alpha')}`, replace: 'alpha-1\nalpha-2\nalpha-3' }],
    },
    ctx,
  )
  check(
    'N1 the success answers fresh anchors for the grown region',
    n1.ok &&
      n1.ok === true &&
      n1.text.includes('fresh anchors:') &&
      n1.text.includes('lines 2-4 now:') &&
      n1.text.includes(`3#${anchorFor('alpha-2')}\talpha-2`),
  )
  const answered = n1.ok && n1.ok === true ? /(\d+#[0-9a-f]+)\talpha-3/.exec(n1.text)?.[1] : undefined
  const n1b = answered
    ? await editViaTool({ file_path: fileA, hunks: [{ lines: answered, replace: 'ALPHA-3' }] }, ctx)
    : { ok: false as const, error: 'no answered anchor found' }
  check(
    'N1b a chained edit re-aims off the answered anchor without any re-read',
    n1b.ok && n1b.ok === true && readFileSync(fileA, 'utf8') === 'head\nalpha-1\nalpha-2\nALPHA-3\nbeta\ngamma\ntail\n',
  )

  // N2: multi-span deltas — the second region's numbering carries the
  // first span's growth, and both blocks verify against the updated file.
  const fileB = join(fixtures, 'delta.txt')
  writeFileSync(fileB, 'one\ntwo\nthree\nfour\nfive\n')
  const ctxB = makeEditContext()
  primeRead(ctxB, fileB)
  const n2 = await editViaTool(
    {
      file_path: fileB,
      hunks: [
        { lines: `2#${anchorFor('two')}`, replace: 'two-a\ntwo-b' },
        { lines: `4#${anchorFor('four')}`, replace: 'FOUR' },
      ],
    },
    ctxB,
  )
  check(
    'N2 later regions speak post-delta coordinates',
    n2.ok &&
      n2.ok === true &&
      n2.text.includes('lines 2-3 now:') &&
      n2.text.includes('lines 5-5 now:') &&
      n2.text.includes(`5#${anchorFor('FOUR')}\tFOUR`),
  )

  // N3: a deletion answers the seam.
  const fileC = join(fixtures, 'del.txt')
  writeFileSync(fileC, 'keep-1\ndrop\nkeep-2\n')
  const ctxC = makeEditContext()
  primeRead(ctxC, fileC)
  const n3 = await editViaTool(
    { file_path: fileC, hunks: [{ lines: `2#${anchorFor('drop')}`, replace: '' }] },
    ctxC,
  )
  check(
    'N3 a deletion answers the seam anchors',
    n3.ok && n3.ok === true && n3.text.includes('(around the removal) now:') && n3.text.includes(`2#${anchorFor('keep-2')}\tkeep-2`),
  )

  // N4: the plain-spelling lane keeps today's exact result bytes.
  const fileD = join(fixtures, 'plain.txt')
  writeFileSync(fileD, 'one\ntwo\n')
  const ctxD = makeEditContext()
  primeRead(ctxD, fileD)
  const n4 = await editViaTool(
    {
      file_path: fileD,
      expected_anchor: mintFileAnchor(readFileSync(fileD, 'utf8')),
      hunks: [{ lines: '2', replace: 'TWO' }],
    },
    ctxD,
  )
  check(
    'N4 plain hunks keep the pre-hashline result text exactly',
    n4.ok && n4.ok === true && n4.text === `The file ${fileD} has been updated successfully.` && !n4.text.includes('fresh anchors'),
  )

  // N5: the exact-string lane result text is untouched too.
  const fileE = join(fixtures, 'exact.txt')
  writeFileSync(fileE, 'one\ntwo\n')
  const ctxE = makeEditContext()
  primeRead(ctxE, fileE)
  const n5 = await editViaTool({ file_path: fileE, old_string: 'two', new_string: 'TWO' }, ctxE)
  check(
    'N5 the exact-string result text is byte-identical to the plain surface',
    n5.ok && n5.ok === true && n5.text === `The file ${fileE} has been updated successfully.`,
  )
}

console.log('')
if (failures > 0) {
  console.error(`prove-hashline: ${failures} RED`)
  process.exit(1)
}
console.log('prove-hashline: GREEN')
