#!/usr/bin/env bun

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 the boot capture discards escape sequences WHOLE')
{
  const { __processEarlyChunkForTest, consumeEarlyInput } = await import('../../src/boot/earlyInput.ts')
  const drive = (chunk: string): string => {
    consumeEarlyInput()
    __processEarlyChunkForTest(chunk)
    return consumeEarlyInput()
  }
  check("an up-arrow (ESC [ A) seeds NOTHING — the finder's repro", drive('\u001b[A') === '', 'processChunk behind __processEarlyChunkForTest in src/boot/earlyInput.ts must drop a whole CSI sequence')
  check('a CSI with parameters (ctrl+arrow, ESC [ 1 ; 5 D) seeds nothing', drive('\u001b[1;5D') === '', 'processChunk behind __processEarlyChunkForTest in src/boot/earlyInput.ts must drop a CSI sequence with parameters whole')
  check('an SS3 function key (F1, ESC O P) seeds nothing', drive('\u001bOP') === '', 'processChunk behind __processEarlyChunkForTest in src/boot/earlyInput.ts must drop an SS3 sequence whole')
  check('the sequence is stripped from surrounding typing', drive('hi\u001b[Byo') === 'hiyo', 'processChunk behind __processEarlyChunkForTest in src/boot/earlyInput.ts must strip an escape sequence and keep the typing around it')
  check('a two-char escape (alt+x) is discarded whole', drive('\u001bx') === '', 'processChunk behind __processEarlyChunkForTest in src/boot/earlyInput.ts must drop an ESC plus one character whole')
  check('plain typing still lands', drive('abc') === 'abc', 'processChunk behind __processEarlyChunkForTest in src/boot/earlyInput.ts must keep plain typing')
  check('CR still folds to newline', drive('a\rb') === 'a\nb', 'processChunk behind __processEarlyChunkForTest in src/boot/earlyInput.ts must turn CR into a newline')
}


console.log('§3 paste candidates split on every line-break class')
{
  const { splitPasteCandidates } = await import('../../src/screen/composer/usePasteHandler.ts')
  check(
    "a CR-delimited Windows console paste splits (the finder's two dragged .pngs)",
    JSON.stringify(splitPasteCandidates('C:\\a\\one.png\rC:\\a\\two.png')) === JSON.stringify(['C:\\a\\one.png', 'C:\\a\\two.png']),
    'splitPasteCandidates in src/screen/composer/usePasteHandler.ts must split on a lone CR',
  )
  check('CRLF splits', splitPasteCandidates('a.png\r\nb.png').length === 2, 'splitPasteCandidates in src/screen/composer/usePasteHandler.ts must split on CRLF')
  check('LF still splits', splitPasteCandidates('a.png\nb.png').length === 2, 'splitPasteCandidates in src/screen/composer/usePasteHandler.ts must split on LF')
  check('space-before-absolute-path still splits', splitPasteCandidates('/x/a.png /x/b.png').length === 2, 'splitPasteCandidates in src/screen/composer/usePasteHandler.ts must split on a space before an absolute path')
  check('a single path stays whole', JSON.stringify(splitPasteCandidates('C:\\a\\one.png')) === JSON.stringify(['C:\\a\\one.png']), 'splitPasteCandidates in src/screen/composer/usePasteHandler.ts must return a single path as one candidate')
}

console.log('§4 a held key still fires its single-letter binding (`key-repeat-run-loses-its-name`)')
{
  const { getKeyName, matchesKeystroke } = await import('../../src/screen/keys/match.ts')
  const bare = {
    escape: false, return: false, tab: false, backspace: false, delete: false,
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageUp: false, pageDown: false, wheelUp: false, wheelDown: false,
    home: false, end: false, ctrl: false, shift: false, meta: false, super: false,
  } as never
  check("a coalesced repeat run names its letter ('jjjj' → j; one atom, one step)", getKeyName('jjjj', bare) === 'j', 'getKeyName in src/screen/keys/match.ts must name a run of one repeated letter by that letter')
  check('a held capital folds like a single one', getKeyName('JJJ', bare) === 'j', 'getKeyName in src/screen/keys/match.ts must fold a run of one repeated capital to lower case')
  check('a mixed run stays nameless (a real paste body)', getKeyName('jk', bare) === null && getKeyName('abc', bare) === null, 'getKeyName in src/screen/keys/match.ts must return null for a run of mixed letters')
  check('a control-byte run stays nameless', getKeyName('\x03\x03', bare) === null, 'getKeyName in src/screen/keys/match.ts must return null for a run of control bytes')
  const j = { key: 'j', ctrl: false, shift: false, alt: false, meta: false, super: false } as never
  check('the run MATCHES the binding a single press matches', matchesKeystroke('jjjj', bare, j) && matchesKeystroke('j', bare, j), 'matchesKeystroke in src/screen/keys/match.ts must match a repeat run against the same binding as one press')
}


process.exit(failures === 0 ? 0 : 1)
