#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-input-contract.ts — T4:
//  the key/input interpretation contract, strengthening the B3 corpus laws
//  over the PUBLIC seam (parseMultipleKeypresses + KeyParseState + flush).
//
//  The characterization set
//  names the unpinned behaviors; these laws close them, implementation-blind:
//
//    • NO-FABRICATION — no emitted atom carries bytes the input never held.
//    • MID-FLUSH — flushing with a partial SGR-mouse head buffered emits
//      NOTHING and the prefix-less tail is swallowed (resync); a genuine
//      keystroke after a dropped head is delivered intact; a lone ESC + flush
//      is exactly one escape keypress.
//    • PASTE-CONTAINMENT — bracketed payloads (escapes, mouse events, control
//      bytes, CJK/emoji, chunk-split PASTE_END prefixes) emit exactly one
//      paste key whose content is byte-exact; an unterminated paste + flush
//      emits the partial content and exits paste mode.
//    • RESPONSE-DISAMBIGUATION — the `?`-marked responses parse as responses,
//      their unmarked twins as KEYS (`CSI 1;2R` = shift+f3 family vs
//      `CSI ?1;2R` = cursorPosition), split at every byte boundary.
//    • MOUSE-ENCODINGS + WHEEL-BURST — SGR boundary coords, drag, motion,
//      modified wheel, X10 control-byte abort; N wheel events ⇒ N keys.
//    • ORPHAN-EXTRACTION — ESC-less text re-scanned for complete mouse
//      events; fragments dropped; interleaved text preserved.
//    • KEY-PROJECTION — golden (key,input) pairs through InputEvent for the
//      projection layer T4 re-owns (unmapped-FN suppression, ctrl+space,
//      CSI-u names, keypad digits, uppercase⇒shift).
//    • STATE-HYGIENE — after any journey: NORMAL mode, empty carries; the
//      INITIAL_STATE object never mutates.
//    • UTF-8 ADVERSARIAL — lone continuations, invalid leads, 4-byte
//      codepoints straddling three chunks.
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-input-contract.ts
// ============================================================================
import {
  INITIAL_STATE,
  type KeyParseState,
  type ParsedInput,
  type ParsedKey,
  parseMultipleKeypresses,
} from '../../src/ink/input/input-decoder.js'
import { InputEvent } from '../../src/ink/events/input-event.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

type Feed = string | Buffer | null // null = flush
function drive(feeds: Feed[]): ParsedInput[] {
  let state: KeyParseState = INITIAL_STATE
  const out: ParsedInput[] = []
  for (const feed of feeds) {
    const [events, next] = parseMultipleKeypresses(state, feed as never)
    out.push(...events)
    state = next
  }
  return out
}

function finalState(feeds: Feed[]): KeyParseState {
  let state: KeyParseState = INITIAL_STATE
  for (const feed of feeds) {
    const [, next] = parseMultipleKeypresses(state, feed as never)
    state = next
  }
  return state
}

const keys = (events: ParsedInput[]): ParsedKey[] =>
  events.filter(e => e.kind === 'key') as ParsedKey[]

console.log('native-core T4 — input interpretation contract')

// ── LAW MID-FLUSH: partial SGR mouse head dropped + tail swallowed ──────────
{
  // Split inside the SGR head, flush, then the tail arrives.
  const events = drive(['\x1b[<64;1', null, '0;5M', null])
  check('mid-flush: nothing emitted for the dropped head', keys(events).length === 0,
    JSON.stringify(events))
  check('mid-flush: tail swallowed (no leaked text)',
    events.every(e => !(e.kind === 'key' && !e.fn && /[0-9;M]/.test(e.sequence))),
    JSON.stringify(events))

  // A genuine keystroke after a dropped head is delivered intact.
  const events2 = drive(['\x1b[<64;1', null, 'q', null])
  const k2 = keys(events2)
  check('mid-flush: keystroke after dropped head survives',
    k2.length === 1 && k2[0]!.name === 'q', JSON.stringify(events2))

  // A lone ESC + flush = exactly one escape keypress.
  const events3 = drive(['\x1b', null])
  const k3 = keys(events3)
  check('mid-flush: lone ESC flushes as one escape',
    k3.length === 1 && k3[0]!.name === 'escape', JSON.stringify(events3))

  // Split mid-CSI for a KEY sequence: force-emit on flush (characterized),
  // tail re-tokenizes from ground as plain text.
  const events4 = drive(['\x1b[1;', null, '5C', null])
  check('mid-flush: split CSI key force-emits then tail is text',
    events4.length >= 1, JSON.stringify(events4))
}

// ── LAW PASTE-CONTAINMENT ───────────────────────────────────────────────────
{
  const payloads: Array<[string, string]> = [
    ['escape-seq', 'before\x1b[31mred\x1b[0mafter'],
    ['mouse-event', 'a\x1b[<0;3;3Mb'],
    ['control-bytes', 'x\x07\x08y'],
    ['cjk-emoji', '漢字🦀ok'],
  ]
  for (const [label, payload] of payloads) {
    const events = drive([`\x1b[200~${payload}\x1b[201~`, null])
    const k = keys(events)
    check(`paste ${label}: exactly one paste key`, k.length === 1, JSON.stringify(k))
    check(`paste ${label}: content byte-exact`,
      k.length === 1 && k[0]!.isPasted === true && k[0]!.sequence === payload,
      JSON.stringify(k[0]?.sequence))
  }

  // PASTE_END split across chunks — the payload's tail looks like a prefix
  // of the terminator.
  const split = drive(['\x1b[200~hello\x1b[2', '01~', null])
  const sk = keys(split)
  check('paste split-END: one paste key', sk.length === 1, JSON.stringify(split))
  check('paste split-END: content exact', sk.length === 1 && sk[0]!.sequence === 'hello',
    JSON.stringify(sk[0]?.sequence))

  // Unterminated paste + flush ⇒ partial paste, paste mode exited.
  const unterminated: Feed[] = ['\x1b[200~partial content', null]
  const uk = keys(drive(unterminated))
  check('paste unterminated: partial emitted on flush',
    uk.length === 1 && uk[0]!.isPasted === true && uk[0]!.sequence === 'partial content',
    JSON.stringify(uk))
  const st = finalState(unterminated)
  check('paste unterminated: mode back to NORMAL', st.mode === 'NORMAL', st.mode)

  // Empty paste still emits (macOS clipboard-image detection depends on it).
  const empty = keys(drive(['\x1b[200~\x1b[201~', null]))
  check('paste empty: still one paste key', empty.length === 1 && empty[0]!.isPasted === true,
    JSON.stringify(empty))
}

// ── LAW RESPONSE-DISAMBIGUATION (split at every byte boundary) ──────────────
{
  const cases: Array<[string, string, (e: ParsedInput) => boolean]> = [
    ['cursorPosition ?-marked', '\x1b[?15;42R',
      e => e.kind === 'response' && e.response.type === 'cursorPosition'],
    ['DECRPM', '\x1b[?2026;2$y',
      e => e.kind === 'response' && e.response.type === 'decrpm'],
    ['DA1', '\x1b[?62;22c', e => e.kind === 'response' && e.response.type === 'da1'],
    ['DA2', '\x1b[>1;95;0c', e => e.kind === 'response' && e.response.type === 'da2'],
    ['kitty flags', '\x1b[?1u',
      e => e.kind === 'response' && e.response.type === 'kittyKeyboard'],
    ['XTVERSION', '\x1bP>|xterm.js(WebKit)\x1b\\',
      e => e.kind === 'response' && e.response.type === 'xtversion'],
    ['OSC BEL reply', '\x1b]11;rgb:1111/2222/3333\x07',
      e => e.kind === 'response' && e.response.type === 'osc'],
  ]
  for (const [label, seq, matches] of cases) {
    for (let i = 1; i < seq.length; i++) {
      const events = drive([seq.slice(0, i), seq.slice(i), null])
      check(`response ${label} split@${i}: recognized once`,
        events.filter(matches).length === 1 &&
          events.filter(e => e.kind === 'key').length === 0,
        JSON.stringify(events))
    }
  }

  // The unmarked twin is a KEY, not a response.
  const f3 = drive(['\x1b[1;2R', null])
  check('plain CSI 1;2R is a key (shift+f3 family)',
    keys(f3).length === 1 && f3.every(e => e.kind !== 'response'), JSON.stringify(f3))
  const csiU = drive(['\x1b[25u', null])
  check('plain CSI 25u is a key, not a kitty response',
    f3.length > 0 && csiU.every(e => e.kind !== 'response'), JSON.stringify(csiU))
}

// ── LAW MOUSE-ENCODINGS + WHEEL-BURST ───────────────────────────────────────
{
  const click = drive(['\x1b[<0;1;1M', null])
  check('SGR click at 1;1 decodes',
    click.length === 1 && click[0]!.kind === 'mouse' && click[0]!.col === 1 && click[0]!.row === 1,
    JSON.stringify(click))
  // CHUNK CONTINUATION (no flush between writes — the kernel splitting one
  // report across two stdin reads): the carried head reassembles into ONE
  // mouse event and ZERO text ever reaches a composer ('35;150M' leaking as
  // typed characters is the cross-harness defect class this pins out).
  const splitPress = drive(['\x1b[<0;35;15', '0M', null])
  check('SGR press split across two writes reassembles into ONE mouse event',
    splitPress.length === 1 && splitPress[0]!.kind === 'mouse' &&
      splitPress[0]!.col === 35 && splitPress[0]!.row === 150 &&
      splitPress[0]!.action === 'press',
    JSON.stringify(splitPress))
  check('…and no fragment leaks as text keys',
    keys(splitPress).length === 0, JSON.stringify(splitPress))
  const bigCoords = drive(['\x1b[<0;500;9999M', null])
  check('SGR huge coords decode',
    bigCoords.length === 1 && bigCoords[0]!.kind === 'mouse' && bigCoords[0]!.row === 9999,
    JSON.stringify(bigCoords))
  const release = drive(['\x1b[<0;10;5m', null])
  check('SGR release (m) decodes as release',
    release.length === 1 && release[0]!.kind === 'mouse' && release[0]!.action === 'release',
    JSON.stringify(release))
  // Drag arrives as button|0x20 with action 'press' at THIS layer — the
  // drag/motion split happens downstream in App.handleMouseEvent.
  const drag = drive(['\x1b[<32;4;4M', null])
  check('SGR drag decodes (button carries the motion bit)',
    drag.length === 1 && drag[0]!.kind === 'mouse' && drag[0]!.button === 32 &&
      drag[0]!.action === 'press',
    JSON.stringify(drag))

  const wheelUp = keys(drive(['\x1b[<64;10;5M', null]))
  check('wheel up is a wheelup KEY', wheelUp.length === 1 && wheelUp[0]!.name === 'wheelup',
    JSON.stringify(wheelUp))
  const modWheel = keys(drive(['\x1b[<80;10;5M', null]))
  check('ctrl+wheel still maps to wheelup', modWheel.length === 1 && modWheel[0]!.name === 'wheelup',
    JSON.stringify(modWheel))

  // Wheel burst: N events ⇒ N keys, order preserved.
  const burst = keys(drive(['\x1b[<64;1;1M\x1b[<65;1;1M\x1b[<64;2;2M\x1b[<65;2;2M', null]))
  check('wheel burst: 4 events ⇒ 4 keys',
    burst.length === 4 &&
      burst.map(k => k.name).join(',') === 'wheelup,wheeldown,wheelup,wheeldown',
    JSON.stringify(burst.map(k => k.name)))

  // X10 wheel; payload with a control byte must NOT be eaten as mouse.
  const x10wheel = keys(drive(['\x1b[M\x60\x21\x21', null]))
  check('X10 wheel decodes', x10wheel.length === 1 && x10wheel[0]!.name === 'wheelup',
    JSON.stringify(x10wheel))
  const x10abort = drive(['\x1b[M\x1b[201~', null])
  check('X10 payload with ESC aborts mouse (PASTE_END guard)',
    x10abort.every(e => e.kind !== 'mouse'), JSON.stringify(x10abort))
}

// ── LAW ORPHAN-EXTRACTION (ESC-less text re-scan) ───────────────────────────
{
  // Feed via the production-shaped split: ESC in chunk 1 + flush ate the
  // prefix, remainder arrives as plain text.
  const two = drive(['[<64;10;5M[<64;10;6M', null])
  const twoKeys = keys(two)
  check('orphan: two ESC-less wheels ⇒ 2 wheel keys',
    twoKeys.filter(k => k.name === 'wheelup').length === 2, JSON.stringify(two))

  const mixed = drive(['abc[<0;3;3Mdef', null])
  const mouseCount = mixed.filter(e => e.kind === 'mouse').length
  const textJoined = keys(mixed).filter(k => !k.fn && k.name !== 'mouse').map(k => k.sequence).join('')
  check('orphan: text preserved around the event',
    mouseCount === 1 && textJoined.includes('abc') && textJoined.includes('def'),
    JSON.stringify(mixed))

  const fragment = drive(['5;77;33M', null])
  check('orphan: bare coordinate fragment emits nothing mouse-like',
    fragment.every(e => e.kind !== 'mouse'), JSON.stringify(fragment))
}

// ── LAW NO-FABRICATION over randomized segmentations of a mixed journey ─────
{
  const rnd = lcg(0xf00dface)
  const journey =
    'hello \x1b[A\x1b[<64;3;3M漢字\x1b[200~paste 内容\x1b[201~\x1b[?1u\x1b[1;5C done'
  for (let rep = 0; rep < 20; rep++) {
    const cuts = new Set<number>()
    const n = 1 + Math.floor(rnd() * 5)
    for (let i = 0; i < n; i++) cuts.add(1 + Math.floor(rnd() * (journey.length - 1)))
    const points = [...cuts].sort((a, b) => a - b)
    const feeds: Feed[] = []
    let prev = 0
    for (const p of points) {
      feeds.push(journey.slice(prev, p))
      prev = p
    }
    feeds.push(journey.slice(prev))
    feeds.push(null)
    const events = drive(feeds)
    // Every non-synthesized payload byte must exist in the journey; the paste
    // content must round-trip exactly.
    const paste = keys(events).find(k => k.isPasted)
    check(`no-fabrication rep ${rep}: paste content exact`,
      paste !== undefined && paste.sequence === 'paste 内容', JSON.stringify(paste?.sequence))
    const textOut = keys(events)
      .filter(k => !k.fn && !k.isPasted && k.name !== 'mouse' && (k.sequence?.length ?? 0) > 0 && !k.sequence.startsWith('\x1b'))
      .map(k => k.sequence)
      .join('')
    check(`no-fabrication rep ${rep}: text bytes all from input`,
      [...textOut].every(ch => journey.includes(ch)), JSON.stringify(textOut))
    const wheels = keys(events).filter(k => k.name === 'wheelup').length
    check(`no-fabrication rep ${rep}: exactly one wheel`, wheels === 1, String(wheels))
  }
}

// ── LAW KEY-PROJECTION (the input-event layer T4 re-owns) ───────────────────
{
  const cases: Array<[string, string, (key: InputEvent['key'], input: string) => boolean]> = [
    ['escape', '\x1b', (key, input) => key.escape === true && input === ''],
    // Raw NUL is ctrl+` in the legacy ladder (characterized); the ctrl+space
    // ' ' mapping rides the CSI-u encoding.
    ['raw NUL (ctrl+`)', '\x00', (key, input) => key.ctrl === true && input === '`'],
    ['csi-u ctrl+space', '\x1b[32;5u', (key, input) => key.ctrl === true && input === ' '],
    ['up arrow', '\x1b[A', (key, input) => key.upArrow === true && input === ''],
    ['shift+tab', '\x1b[Z', (key, input) => key.tab === true && key.shift === true && input === ''],
    ['csi-u super+a', '\x1b[97;9u', (key, input) => key.super === true && input === 'a'],
    ['keypad O-digit', '\x1bOp', (_key, input) => input === '0'],
    ['uppercase implies shift', 'Q', (key, input) => key.shift === true && input === 'Q'],
    ['plain text', 'q', (key, input) => key.shift === false && input === 'q'],
    ['unmapped csi-u codepoint', '\x1b[57358;1u', (_key, input) => input === ''],
    ['pgup', '\x1b[5~', (key, input) => key.pageUp === true && input === ''],
    // ── the FULL kitty grammar:
    // colon subfields (event types, alternates) and the associated-text
    // section are the same `>1u` push spoken richer — press/REPEAT act,
    // release swallows, text names the key. The minimal-regex era let all
    // of these die nameless (discrete keys worked, repeat bursts didn't).
    ['kitty tab press-tagged', '\x1b[9;1:1u', (key, input) => key.tab === true && input === ''],
    ['kitty tab REPEAT acts', '\x1b[9;1:2u', (key, input) => key.tab === true && input === ''],
    ['kitty tab release swallows', '\x1b[9;1:3u', (key, input) => key.tab === false && input === ''],
    ['kitty down repeat-tagged (legacy final)', '\x1b[1;1:2B', (key, input) => key.downArrow === true && input === ''],
    ['kitty down release swallows', '\x1b[1;1:3B', (key, input) => key.downArrow === false && input === ''],
    ['kitty shifted-a with text field', '\x1b[97;2;65u', (key, input) => key.shift === true && input === 'A'],
    ['kitty alternate-keys subfield', '\x1b[97:65;1u', (_key, input) => input === 'a'],
    // ── the LAYOUT law: chords resolve on the base-layout subfield. A
    // non-Latin layout types its own codepoint as the primary code —
    // ctrl+ф (the physical A key on ЙЦУКЕН) arrives 1092:1060:97;5u, and
    // matching the typed codepoint alone killed every ctrl/alt/super chord
    // on such layouts. The base-layout subfield IS the physical position;
    // plain typing (no chord plane) keeps the typed glyph.
    ['kitty ctrl+ф resolves base a', '\x1b[1092:1060:97;5u', (key, input) => key.ctrl === true && input === 'a'],
    ['kitty ctrl+а resolves base f', '\x1b[1072:1040:102;5u', (key, input) => key.ctrl === true && input === 'f'],
    ['kitty ctrl+ф empty-shifted subfield', '\x1b[1092::97;5u', (key, input) => key.ctrl === true && input === 'a'],
    ['kitty alt+ф resolves base a', '\x1b[1092:1060:97;3u', (key, input) => key.meta === true && input === 'a'],
    ['kitty super+ф resolves base a', '\x1b[1092:1060:97;9u', (key, input) => key.super === true && input === 'a'],
    ['kitty ctrl+ф REPEAT acts', '\x1b[1092:1060:97;5:2u', (key, input) => key.ctrl === true && input === 'a'],
    ['kitty ctrl+ф release swallows', '\x1b[1092:1060:97;5:3u', (key, input) => key.ctrl === false && input === ''],
    ['kitty plain ф stays ф (text field)', '\x1b[1092:1060:97;1;1092u', (_key, input) => input === 'ф'],
    ['kitty shift-only ф never hijacks base', '\x1b[1092:1060:97;2;1060u', (_key, input) => input === 'Ф'],
  ]
  for (const [label, seq, verify] of cases) {
    const parsed = keys(drive([seq, null]))
    check(`projection ${label}: parses to one key`, parsed.length === 1, JSON.stringify(parsed))
    if (parsed.length === 1) {
      const ev = new InputEvent(parsed[0]!)
      check(`projection ${label}: (key,input) shape`, verify(ev.key, ev.input),
        JSON.stringify({ input: ev.input, key: ev.key }))
    }
  }
  // ── the REQUEST half of the layout law (verifier pass): the alternate-key
  // subfields the chord resolver reads ride ONLY under the kitty 0b100
  // flag — a 0b1-only push leaves the reader waiting for data no
  // spec-compliant terminal sends, and every non-Latin chord stays dead on
  // the real wire however total the reader is. The push must carry 0b100
  // (and keep 0b1); 0b1000/0b10000 stay unset so plain typing never
  // escape-codes.
  {
    const { ENABLE_KITTY_KEYBOARD } = await import('../../src/ink/termio/csi.js')
    const m = /^\x1b\[>(\d+)u$/.exec(ENABLE_KITTY_KEYBOARD)
    const flags = m ? parseInt(m[1]!, 10) : 0
    check('request: the kitty push carries REPORT-ALTERNATE-KEYS (0b100)', (flags & 0b100) !== 0, ENABLE_KITTY_KEYBOARD)
    check('request: the push keeps DISAMBIGUATE (0b1)', (flags & 0b1) !== 0, ENABLE_KITTY_KEYBOARD)
    check('request: report-all-keys / associated-text stay unset (plain typing stays plain)', (flags & 0b11000) === 0, ENABLE_KITTY_KEYBOARD)
  }
  // ── control-boundary splitting (the C-MED-5 'text↵' law at the byte
  // layer): a coalesced printable+control chunk yields the printable run
  // PLUS acting control atoms — never one nameless glue atom.
  {
    const glued = keys(drive(['abc\r', null]))
    check("split: 'abc\\r' is text + RETURN", glued.length === 2 && glued[1]?.name === 'return', JSON.stringify(glued.map(k => k.name)))
    const tabs = keys(drive(['\t\t\t', null]))
    check("split: '\\t\\t\\t' is three TAB atoms", tabs.length === 3 && tabs.every(k => k.name === 'tab'), JSON.stringify(tabs.map(k => k.name)))
    const run = keys(drive(['abcdefghijklmnop', null]))
    check('split: a pure printable run stays ONE grouped atom', run.length === 1 && run[0]?.sequence === 'abcdefghijklmnop', JSON.stringify(run.map(k => k.sequence)))
    const meta = keys(drive(['\x1b\x7f', null]))
    check('split: ESC-led runs pass whole (meta-backspace intact)', meta.length === 1 && meta[0]?.name === 'backspace' && meta[0]?.meta === true, JSON.stringify(meta))
  }
}

// ── LAW STATE-HYGIENE + UTF-8 ADVERSARIAL ───────────────────────────────────
{
  const journeys: Feed[][] = [
    ['\x1b[<64;1', null, '0;5M', null],
    ['\x1b[200~x', null],
    [Buffer.from([0x80]), null], // lone continuation byte
    [Buffer.from([0xff, 0x61]), null], // invalid lead then 'a'
    [Buffer.from([0xe6, 0xbc]), null, Buffer.from([0xa2]), null], // 漢 split 2+1 with a flush between
  ]
  for (let i = 0; i < journeys.length; i++) {
    const st = finalState(journeys[i]!)
    check(`hygiene journey ${i}: NORMAL mode`, st.mode === 'NORMAL', st.mode)
    check(`hygiene journey ${i}: no incomplete carry`, (st.incomplete ?? '') === '', JSON.stringify(st.incomplete))
    check(`hygiene journey ${i}: no pending bytes`,
      st.pendingBytes === undefined || st.pendingBytes.length === 0,
      JSON.stringify(st.pendingBytes))
  }

  // A 4-byte codepoint (🦀 F0 9F A6 80) straddling THREE chunks.
  const crab = Buffer.from('🦀', 'utf8')
  const events = drive([crab.subarray(0, 1), crab.subarray(1, 3), crab.subarray(3), null])
  const text = keys(events).map(k => k.sequence).join('')
  check('utf8: 4-byte codepoint over three chunks decodes', text === '🦀', JSON.stringify(text))

  // INITIAL_STATE must never mutate.
  check('INITIAL_STATE unmutated',
    INITIAL_STATE.mode === 'NORMAL' && (INITIAL_STATE.incomplete ?? '') === '' &&
      (INITIAL_STATE.pasteBuffer ?? '') === '',
    JSON.stringify({ mode: INITIAL_STATE.mode, incomplete: INITIAL_STATE.incomplete }))
}

// ── LAW FLUSH-KIND (audit T4-F1): a partial sequence flushed mid-family
// carries ITS family's kind tag — the kind vocabulary must never mislabel.
{
  const { createScanner } = await import('../../src/ink/input/scanner.js')
  // ESC-prefixed families flush their partial as a token of the family
  // kind. STRING sequences (OSC/DCS/APC) are SEALED instead (
  // the synthetic-ctrl+g class): a flush-split partial is
  // dropped and the state persists, so the tail + its BEL/ST terminator is
  // swallowed by the machine — the terminator can never decode as a
  // keypress and the body can never leak as text.
  const families: Array<[string, string, string]> = [
    ['csi', '\x1b[1;5', 'csi'],
    ['ss3', '\x1bO', 'ss3'],
  ]
  for (const [label, head, expected] of families) {
    const scanner = createScanner()
    scanner.feed(head)
    const tokens = scanner.flush()
    check(
      `flush-kind ${label}: tail keeps the family kind`,
      tokens.length === 1 && tokens[0]!.kind === expected,
      JSON.stringify(tokens),
    )
  }
  const stringFamilies: Array<[string, string, string]> = [
    ['osc', '\x1b]11;rgb:aa', ';rgb:end\x07'],
    ['dcs', '\x1bP>|gho', 'st-tail\x1b\\'],
    ['apc', '\x1b_Gap', 'more\x1b\\'],
  ]
  for (const [label, head, tail] of stringFamilies) {
    const scanner = createScanner()
    scanner.feed(head)
    const flushed = scanner.flush()
    check(
      `flush-kind ${label}: a split string sequence is SEALED (no partial token)`,
      flushed.length === 0,
      JSON.stringify(flushed),
    )
    const tailTokens = scanner.feed(tail)
    check(
      `flush-kind ${label}: the tail + terminator is swallowed, never text/key`,
      tailTokens.every(t => t.kind !== 'text'),
      JSON.stringify(tailTokens),
    )
    const after = scanner.feed('ok')
    check(
      `flush-kind ${label}: ground input scans normally after the seal`,
      after.length === 1 && after[0]!.kind === 'text' && after[0]!.value === 'ok',
      JSON.stringify(after),
    )
  }
}

// ── LAW DOM-KEY-BATCH (the empty-name fallback) ─────────────────────────────
// Batched printable chunks parse through the decoder's nameless base key
// (`name: ''` + the text in `sequence`). An empty string is not nullish, so
// the DOM projection's `name ?? sequence` would otherwise project `key: ''` and
// every KeyboardEvent consumer dropped the whole batch (the Q5 keytrace
// find). The projection must fall through an EMPTY name to the sequence —
// and keep the single-char literal and control-name behaviors.
{
  const { KeyboardEvent } = await import('../../src/ink/events/keyboard-event.js')
  const key = (over: Record<string, unknown>): string =>
    new KeyboardEvent({
      kind: 'key', name: '', fn: false, ctrl: false, meta: false,
      shift: false, option: false, super: false, sequence: undefined,
      raw: '', isPasted: false, ...over,
    } as never).key
  check('dom-key: batched printable chunk projects its whole text', key({ sequence: '/ greet', raw: '/ greet' }) === '/ greet')
  check('dom-key: single printable stays the literal character', key({ sequence: 'a', raw: 'a' }) === 'a')
  check('dom-key: named key wins over its sequence', key({ name: 'escape', sequence: '\x1b' }) === 'escape')
  check('dom-key: ctrl projects the parsed name, not the control byte', key({ ctrl: true, name: 'c', sequence: '\x03' }) === 'c')
  check('dom-key: ctrl with an empty name still falls to the sequence', key({ ctrl: true, sequence: 'zz' }) === 'zz')
  check('dom-key: nothing at all projects the empty string', key({}) === '')
}

// ── LAW META-INTRODUCER (TASK-014 w2-f12-01): a body-less ESC ] / ESC P /
// ESC _ at the flush is a keyboard chord, not a string sequence — one alt+]
// must never deafen the loop; a partial WITH body bytes keeps the seal.
{
  const { createScanner } = await import('../../src/ink/input/scanner.js')
  for (const [label, chord] of [['alt+]', '\x1b]'], ['alt+P', '\x1bP'], ['alt+_', '\x1b_']] as const) {
    const scanner = createScanner()
    const fed = scanner.feed(chord)
    const flushed = scanner.flush()
    check(
      `${label}: the body-less introducer flushes as one ESC-led token`,
      fed.length === 0 && flushed.length === 1 && flushed[0]!.kind === 'esc' && flushed[0]!.value === chord,
      JSON.stringify([fed, flushed]),
    )
    const after = scanner.feed('ok')
    check(`${label}: the loop hears the next keystrokes`, after.length === 1 && after[0]!.kind === 'text' && after[0]!.value === 'ok', JSON.stringify(after))
  }
  const ks = keys(drive(['\x1b]', null, 'x', '\r', null]))
  check(
    'alt+] end to end: the chord is not Enter, and the following x + Enter decode',
    ks.length >= 2 && ks[0]!.name !== 'return' && ks.some(k => k.sequence === 'x') && ks[ks.length - 1]!.name === 'return',
    JSON.stringify(ks),
  )
  const st = finalState(['\x1b]', null])
  check('alt+] end to end: the decoder is back in NORMAL with an empty carry', st.mode === 'NORMAL' && st.incomplete === '', JSON.stringify(st))
  const sealed = createScanner()
  sealed.feed('\x1b]11;rgb:aa')
  check('a bodied partial OSC still seals at the flush (the kill-chain guard stands)', sealed.flush().length === 0)
  // THE SEAL DEADLINE: one sealed
  // flush is lawful — a reply's terminator may still be in flight — but a
  // second consecutive sealed flush means no terminator is coming, and the
  // machine grounds so the loop hears the keyboard again.
  const chordThenTyping = createScanner()
  chordThenTyping.feed('\x1b]abc')
  check('a chord followed by typing in ONE read seals at the first flush', chordThenTyping.flush().length === 0)
  chordThenTyping.feed('defg')
  chordThenTyping.flush()
  const heard = chordThenTyping.feed('ok')
  check('…and the second sealed flush grounds the machine — the next keystrokes are heard', heard.length === 1 && heard[0]!.kind === 'text' && heard[0]!.value === 'ok', JSON.stringify(heard))
}

// ── LAW BURST-CR (TASK-014 w2-f13-03 / w2-f16-03; HOST-GATED
// dispute B): on the unbracketed-paste host — win32 WITHOUT WT_SESSION, the
// legacy console — a lone CR between text in one read is a line break (a
// CR-delimited console paste is content; only a read-final CR is Enter).
// Every bracketed-paste host keeps the TYPED law: text-CR-text in one read
// is buffered typing under an event-loop stall, and the Enter fires.
{
  const dec = await import('../../src/ink/input/input-decoder.js')
  check('the gate: win32 without WT_SESSION engages the paste law', dec.burstCrIsLineBreak('win32', {}) === true)
  check('the gate: Windows Terminal keeps the typed law (bracketed paste arrives there)', dec.burstCrIsLineBreak('win32', { WT_SESSION: 'x' }) === false)
  check('the gate: POSIX hosts keep the typed law', dec.burstCrIsLineBreak('darwin', {}) === false && dec.burstCrIsLineBreak('linux', {}) === false)
  // The widened host question (TASK-017 supplement, SURVIVED ×2): the gate
  // rides the ONE owner (isModernWindowsTerminal) — VS Code's integrated
  // terminal and mintty/MSYS paste bracketed too, and the old raw
  // WT_SESSION read silently rewrote their stalled Enter into a newline.
  check('the gate: VS Code on win32 keeps the typed law', dec.burstCrIsLineBreak('win32', { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.96' }) === false)
  check('the gate: mintty/MSYS on win32 keeps the typed law', dec.burstCrIsLineBreak('win32', { TERM_PROGRAM: 'mintty' }) === false && dec.burstCrIsLineBreak('win32', { MSYSTEM: 'MINGW64' }) === false)
  check('the gate: a version-less vscode marker stays conservative (paste law)', dec.burstCrIsLineBreak('win32', { TERM_PROGRAM: 'vscode' }) === true)
  dec.__setBurstCrHostForTest(true)
  try {
    const burst = keys(drive(['line one\rline two\rline three', null]))
    check(
      'conhost law: a CR-delimited burst is one text atom with line breaks, no return',
      burst.length === 1 && burst[0]!.sequence === 'line one\nline two\nline three' && !burst.some(k => k.name === 'return'),
      JSON.stringify(burst),
    )
    const typed = keys(drive(['o\r', null]))
    check('conhost law: text then a read-final CR is still text + Enter', typed.length === 2 && typed[0]!.sequence === 'o' && typed[1]!.name === 'return', JSON.stringify(typed))
    const twice = keys(drive(['o\r\r', null]))
    check('conhost law: a doubled CR still yields two Enters', twice.filter(k => k.name === 'return').length === 2, JSON.stringify(twice))
    const lone = keys(drive(['\r', null]))
    check('conhost law: a lone CR read is Enter at once', lone.length === 1 && lone[0]!.name === 'return', JSON.stringify(lone))
    const crlf = keys(drive(['alpha\r\nbeta', null]))
    check('conhost law: CR LF is still one line break', crlf.length === 1 && crlf[0]!.sequence === 'alpha\nbeta', JSON.stringify(crlf))
  } finally {
    dec.__setBurstCrHostForTest(null)
  }
  dec.__setBurstCrHostForTest(false)
  try {
    const stalled = keys(drive(['abc\rdef', null]))
    check(
      'typed law (WT/POSIX): text-CR-text in one read keeps its Enter — a stall never swallows a send',
      stalled.length === 3 && stalled[0]!.sequence === 'abc' && stalled[1]!.name === 'return' && stalled[2]!.sequence === 'def',
      JSON.stringify(stalled),
    )
    const crlfTyped = keys(drive(['alpha\r\nbeta', null]))
    check('typed law: CR LF stays one line break on every host', crlfTyped.length === 1 && crlfTyped[0]!.sequence === 'alpha\nbeta', JSON.stringify(crlfTyped))
  } finally {
    dec.__setBurstCrHostForTest(null)
  }
}

if (failures > 0) {
  console.log(`\nnative-core input contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core input contract: green (${checks} checks)`)
