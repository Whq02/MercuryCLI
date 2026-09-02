#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-kernel.ts — slice-10 kernel-boundary laws.
//
//    · PARITY: the pure-TS reference SHA-256 produces byte-identical
//      digests to the selected node:crypto implementation across a hostile
//      corpus (empty · 1 byte · block boundaries 55/56/64/65 · multibyte
//      UTF-8 · binary bytes · 1MB);
//    · known-answer vectors (FIPS 180-2) hold for BOTH implementations;
//    · capability negotiation reports the honest surface (hash provided;
//      text/search/process/pty named to their owning facilities);
//    · the anchor consumer is byte-identical through the boundary (golden
//      anchors pinned).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const { runtimeKernel, referenceHashKernel } = await import(
  '../../src/services/primitives/runtimeKernel.ts'
)
const { mintFileAnchor, mintRangeAnchor } = await import(
  '../../src/services/changeTransaction/snapshotAnchor.ts'
)

const kernel = runtimeKernel()

console.log('known-answer vectors (FIPS 180-2)')
{
  const vectors: [string, string][] = [
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ]
  for (const [input, want] of vectors) {
    check(`selected: '${input.slice(0, 12)}…'`, kernel.hash.sha256Hex(input) === want)
    check(`reference: '${input.slice(0, 12)}…'`, referenceHashKernel.sha256Hex(input) === want)
  }
}

console.log('parity across a hostile corpus')
{
  const corpus: (string | Uint8Array)[] = [
    '',
    'a',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(64),
    'x'.repeat(65),
    'héllo wörld — ünïcode ☂ 中文 🚫'.repeat(3),
    '\r\n\r\nline\r\n',
    new Uint8Array([0, 1, 2, 255, 254, 128, 127]),
    'M'.repeat(1_000_000),
  ]
  let mismatches = 0
  for (const item of corpus) {
    if (kernel.hash.sha256Hex(item) !== referenceHashKernel.sha256Hex(item)) mismatches++
  }
  check('reference === selected across the corpus', mismatches === 0, `${mismatches} mismatch(es)`)
}

console.log('capability negotiation')
{
  const caps = kernel.capabilities()
  check('hash is provided', caps.hash === true && kernel.hash.id === 'node:crypto')
  check('absent capabilities are explicit with owning facilities named',
    caps.text === false && caps.search === false && caps.process === false && caps.pty === false &&
      Object.keys(caps.notes).length === 4 &&
      caps.notes.text!.includes('cellLayout') && caps.notes.search!.includes('ripgrep'))
}

console.log('the anchor consumer is byte-identical through the boundary')
{
  // Golden anchors minted BEFORE the boundary landed (sha256-derived) —
  // any drift here is a behavior change, not a refactor.
  check('full-file anchor golden', mintFileAnchor('hello\nworld\n') === 'fa:4a1e67f2fe1d', mintFileAnchor('hello\nworld\n'))
  check('range anchor golden', mintRangeAnchor('mid', 3, 1) === 'ra:90ac16783fbc:L3+1', mintRangeAnchor('mid', 3, 1))
  check('CRLF normalization unchanged', mintFileAnchor('hello\r\nworld\r\n') === mintFileAnchor('hello\nworld\n'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
