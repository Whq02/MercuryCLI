#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-input-unicode-corpus.ts — the input/
//  Unicode fidelity corpus (the native packet's §7 rows) asserted at the
//  PROCESS BOUNDARY — decoder atoms, width-oracle cells, display graphemes,
//  frame-writer bytes, and the in-process Ink rig's dispatched events.
//
//  HOLD-MAC: these are process-boundary proofs. They pin Mercury's OWN
//  bytes and state machines; they do NOT close native Apple/Windows paint.
//  The native receipts (real Terminal.app per the packet §10 schema, the
//  windows-tasks field channel) remain the closing evidence.
//
//    • PASTE LAWS (decoder) — empty paste emits; literal trailing '[I'/'[O'
//      text survives byte-exact; split delimiters reassemble; CRLF payloads
//      are byte-exact; paste+Enter in ONE chunk = paste atom + return atom;
//      a FLUSH always exits paste mode — a consumed bare PASTE_START must
//      never latch IN_PASTE (native-macos-02).
//    • WIDTH ORACLE (stringWidth) — Hebrew niqqud and Arabic harakat are
//      zero-width in BOTH runtimes (the exported oracle, whichever path
//      backs it); spacing Hebrew punctuation (MAQAF) stays width 1; the
//      ⚠/VS15/VS16 selector rows and CJK/flag/ZWJ rows hold.
//    • DISPLAY GRAPHEMES (termio) — the Q-WIDTH carve-out: a base carrying
//      only niqqud/harakat marks takes the BASE's width; every other
//      multi-codepoint grapheme keeps the pinned width-2 default.
//    • FRAME WRITER — a multi-codepoint wide grapheme (flag, ZWJ family)
//      whose two cells exactly fit the final two columns is EMITTED, not
//      dropped (geometry-overflow-10); replay shows it in those cells.
//    • APP RIG (in-process Ink, fake stdio) — the paste-wedge release: a
//      bare PASTE_START flushes (≤ the 500ms paste timeout) as a meaningful
//      empty paste and later keystrokes act; a swallowed backlog delivers
//      as ONE paste atom; usePasteHandler forwards paste text VERBATIM
//      (no '[I'/'[O' suffix guessing — native-macos-01).
//
//  NODE_ENV must NOT be 'test' (lattice bypass in the Ink rig).
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-input-unicode-corpus.ts
// ============================================================================
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.NODE_ENV === 'test') {
  console.error('prove-input-unicode-corpus must not run with NODE_ENV=test (lattice bypass)')
  process.exit(1)
}

// Hermetic home BEFORE any src value-module loads (the proof-hygiene law).
const HERMETIC_HOME = mkdtempSync(join(tmpdir(), 'native-core-unicorpus-'))
process.env.MERCURY_CONFIG_DIR = HERMETIC_HOME
process.env.MERCURY_DAEMON_DIR = join(HERMETIC_HOME, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(HERMETIC_HOME, 'teams')

const {
  INITIAL_STATE,
  parseMultipleKeypresses,
} = await import('../../src/ink/input/input-decoder.js')
type KeyParseState = import('../../src/ink/input/input-decoder.js').KeyParseState
type ParsedInput = import('../../src/ink/input/input-decoder.js').ParsedInput
type ParsedKey = import('../../src/ink/input/input-decoder.js').ParsedKey
const { stringWidth } = await import('../../src/ink/stringWidth.js')
const { Parser } = await import('../../src/ink/termio/display.js')
type Action = import('../../src/ink/termio/display-types.js').Action
const { FrameWriter } = await import('../../src/ink/frame-writer.js')
const { optimizePatches: optimize } = await import('../../src/ink/patch-stream.js')
const { writeDiffToTerminal } = await import('../../src/ink/session/delivery.js')
const { CURSOR_HOME } = await import('../../src/ink/termio/csi.js')
const { composeScene, makeContext } = await import('../ink-runtime/frameHarness.js')
const { AnsiEmulator } = await import('../ink-runtime/ansiEmulator.js')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const ESC = '\u{1b}'

console.log('native-core WAVE C1 — input/Unicode fidelity corpus (process boundary; HOLD-MAC)')

// -- the section-7 text rows, escape-spelled (the raw-control-bytes law) --
const NFD_E = 'e\u{301}' // e + combining acute (NFD)
const ALEPH_SHEVA = '\u{5d0}\u{5b0}' // aleph + sheva (niqqud)
const SHIN_DOT_QAMATS = '\u{5e9}\u{5c1}\u{5b8}' // shin + shin dot + qamats
const MAQAF_PAIR = '\u{5d0}\u{5be}\u{5d1}' // aleph MAQAF bet -- MAQAF is SPACING (width 1)
const BEH_FATHA = '\u{628}\u{64e}' // Arabic beh + fatha (harakat)
const LAM_SUPALEF = '\u{644}\u{670}' // lam + superscript alef
const WARN = '\u{26a0}' // warning sign, text-default
const WARN_EMOJI = '\u{26a0}\u{fe0f}' // warning sign + VS16
const EIGHT_SPOKE = '\u{2733}' // eight-spoked asterisk, text-default
const EIGHT_SPOKE_EMOJI = '\u{2733}\u{fe0f}'
const CJK = '\u{6f22}\u{5b57}' // kanji pair
const FLAG = '\u{1f1e6}\u{1f1fa}' // regional-indicator flag (AU)
const FAMILY = '\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}' // ZWJ family

// ════════════════════════════════════════════════════════════════════════════
//  1. DECODER — the paste corpus at the parseMultipleKeypresses seam
// ════════════════════════════════════════════════════════════════════════════
{
  type Feed = string | Buffer | null
  const drive = (feeds: Feed[]): ParsedInput[] => {
    let state: KeyParseState = INITIAL_STATE
    const out: ParsedInput[] = []
    for (const feed of feeds) {
      const [events, next] = parseMultipleKeypresses(state, feed as never)
      out.push(...events)
      state = next
    }
    return out
  }
  const finalState = (feeds: Feed[]): KeyParseState => {
    let state: KeyParseState = INITIAL_STATE
    for (const feed of feeds) [, state] = parseMultipleKeypresses(state, feed as never)
    return state
  }
  const keys = (events: ParsedInput[]): ParsedKey[] =>
    events.filter(e => e.kind === 'key') as ParsedKey[]
  const paste = (payload: string): string => `${ESC}[200~${payload}${ESC}[201~`

  // Byte-exact containment for the §7 payload rows.
  const rows: Array<[string, string]> = [
    ['empty paste', ''],
    ['literal trailing [I', 'abc[I'],
    ['literal trailing [O', 'abc[O'],
    ['CRLF payload', 'line1\r\nline2'],
    ['NFD accent', `${NFD_E}X`],
    ['niqqud', `${ALEPH_SHEVA}X`],
    ['harakat', `${BEH_FATHA}X`],
    ['CJK + flag + family', `${CJK} ${FLAG} ${FAMILY}`],
  ]
  for (const [label, payload] of rows) {
    const k = keys(drive([paste(payload), null]))
    check(`decoder ${label}: one paste atom, byte-exact`,
      k.length === 1 && k[0]!.isPasted === true && k[0]!.sequence === payload,
      JSON.stringify(k.map(x => x.sequence)))
  }

  // Split delimiters (START and END each split mid-sequence).
  const splitStart = keys(drive([`${ESC}[20`, `0~in${ESC}[201~`, null]))
  check('decoder split-START reassembles', splitStart.length === 1 && splitStart[0]!.sequence === 'in',
    JSON.stringify(splitStart))
  const splitEnd = keys(drive([`${ESC}[200~hello${ESC}[2`, '01~', null]))
  check('decoder split-END reassembles', splitEnd.length === 1 && splitEnd[0]!.sequence === 'hello',
    JSON.stringify(splitEnd))

  // Paste + Enter in ONE chunk: the paste atom then the return atom.
  const withEnter = keys(drive([`${paste('text')}\r`, null]))
  check('decoder paste+Enter one chunk: paste atom then return',
    withEnter.length === 2 && withEnter[0]!.sequence === 'text' && withEnter[0]!.isPasted === true &&
      withEnter[1]!.name === 'return',
    JSON.stringify(withEnter.map(k => [k.name, k.sequence])))

  // THE FLUSH LAW (native-macos-02): a consumed bare PASTE_START + flush
  // exits paste mode, emitting the meaningful EMPTY paste. Pre-fix the
  // decoder kept IN_PASTE forever (flush gated on a nonempty buffer).
  const bare: Feed[] = [`${ESC}[200~`, null]
  const bareKeys = keys(drive(bare))
  check('decoder FLUSH LAW: bare PASTE_START + flush emits the empty paste',
    bareKeys.length === 1 && bareKeys[0]!.isPasted === true && bareKeys[0]!.sequence === '',
    JSON.stringify(bareKeys))
  const bareState = finalState(bare)
  check('decoder FLUSH LAW: paste mode released', bareState.mode === 'NORMAL', bareState.mode)

  // Backlog variant: text swallowed after a bare START flushes as ONE paste.
  const backlog: Feed[] = [`${ESC}[200~`, 'abc', null]
  const backlogKeys = keys(drive(backlog))
  check('decoder FLUSH LAW: swallowed backlog delivers as one paste atom',
    backlogKeys.length === 1 && backlogKeys[0]!.isPasted === true && backlogKeys[0]!.sequence === 'abc',
    JSON.stringify(backlogKeys))
  check('decoder FLUSH LAW: backlog flush releases paste mode',
    finalState(backlog).mode === 'NORMAL', finalState(backlog).mode)
}

// ════════════════════════════════════════════════════════════════════════════
//  2. WIDTH — the pinned oracle (the exported stringWidth, either runtime)
// ════════════════════════════════════════════════════════════════════════════
{
  const rows: Array<[string, string, number]> = [
    ['NFD e+acute + X', `${NFD_E}X`, 2],
    ['NFC precomposed + X', 'éX', 2],
    ['aleph+sheva (niqqud zero-width)', ALEPH_SHEVA, 1],
    ['aleph+sheva + X', `${ALEPH_SHEVA}X`, 2],
    ['shin + shin-dot + qamats', SHIN_DOT_QAMATS, 1],
    ['MAQAF stays SPACING', MAQAF_PAIR, 3],
    ['beh+fatha (harakat zero-width)', BEH_FATHA, 1],
    ['beh+fatha + X', `${BEH_FATHA}X`, 2],
    ['lam + superscript alef', LAM_SUPALEF, 1],
    ['warning sign text-default + X', `${WARN}X`, 2],
    ['warning sign VS16 + X', `${WARN_EMOJI}X`, 3],
    ['eight-spoke text-default', EIGHT_SPOKE, 1],
    ['eight-spoke VS16', EIGHT_SPOKE_EMOJI, 2],
    ['CJK pair', CJK, 4],
    ['flag + X', `${FLAG}X`, 3],
    ['ZWJ family', FAMILY, 2],
  ]
  for (const [label, text, cells] of rows) {
    const got = stringWidth(text)
    check(`width ${label} = ${cells}`, got === cells, `got ${got}`)
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  3. DISPLAY — termio graphemes: the Q-WIDTH carve-out, everything else pinned
// ════════════════════════════════════════════════════════════════════════════
{
  const widthsOf = (text: string): number[] => {
    const actions = new Parser().feed(text) as Action[]
    const t = actions.find(a => a.type === 'text') as
      | Extract<Action, { type: 'text' }>
      | undefined
    return t ? t.graphemes.map(g => g.width) : []
  }
  const rows: Array<[string, string, number[]]> = [
    ['aleph+sheva inherits the base width', `${ALEPH_SHEVA}X`, [1, 1]],
    ['shin + shin-dot + qamats inherits', SHIN_DOT_QAMATS, [1]],
    ['beh+fatha inherits', `${BEH_FATHA}X`, [1, 1]],
    ['lam + superscript alef inherits', LAM_SUPALEF, [1]],
    ['NFD e+acute keeps the Q-WIDTH default', NFD_E, [2]],
    ['CRLF keeps the Q-WIDTH default', '\r\n', [2]],
    ['flag keeps 2', FLAG, [2]],
    ['ZWJ family keeps 2', FAMILY, [2]],
    ['bare aleph is 1', '\u{5d0}', [1]],
    ['CJK is 2,2', CJK, [2, 2]],
  ]
  for (const [label, text, want] of rows) {
    const got = widthsOf(text)
    check(`display ${label} = [${want.join(',')}]`, JSON.stringify(got) === JSON.stringify(want),
      `got [${got.join(',')}]`)
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  4. FRAME WRITER — exact-right-edge wide graphemes paint (never dropped)
// ════════════════════════════════════════════════════════════════════════════
{
  const COLS = 20
  const ROWS = 3
  const serialize = (diff: ReturnType<typeof optimize>): string => {
    let captured = ''
    const fake = {
      stdout: {
        write(s: string) {
          captured += s
          return true
        },
        isTTY: false,
      },
    }
    writeDiffToTerminal(fake as never, diff, true)
    return captured
  }
  const paint = (text: string): { bytes: string; replay: () => InstanceType<typeof AnsiEmulator> } => {
    const ctx = makeContext()
    const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
    const empty = composeScene(
      { name: 'empty', cols: COLS, rows: ROWS, root: { kind: 'box' } },
      ctx, undefined, { altScreen: true },
    )
    const frame = composeScene(
      {
        name: 'edge', cols: COLS, rows: ROWS,
        root: { kind: 'box', style: { flexDirection: 'column' }, children: [{ kind: 'text', text }] },
      },
      ctx, undefined, { altScreen: true },
    )
    const bytes = serialize(optimize(writer.render(empty, frame, true, true)))
    // Replay is LAZY: the code-unit-level emulator cannot carry a
    // multi-codepoint grapheme as one cell — only the single-codepoint
    // guard replays.
    const replay = (): InstanceType<typeof AnsiEmulator> => {
      const emu = new AnsiEmulator(COLS, ROWS, true)
      emu.feed(CURSOR_HOME)
      emu.feed(bytes)
      return emu
    }
    return { bytes, replay }
  }

  // Exact fit: the wide grapheme occupies the FINAL two columns [18,19].
  // The replay emulator is code-unit level, so multi-codepoint graphemes are
  // asserted on BYTES + the addressing law; the single-codepoint wide guard
  // keeps the full cell replay. (An edge-CROSSING wide cell never reaches
  // emitCell: wrap/truncate owns that upstream — and today it chops the
  // grapheme, a width-estate defect outside this corpus's scope.)
  const addressedColumns = (bytes: string): number[] => {
    const cols: number[] = []
    for (const m of bytes.matchAll(/\u{1b}\[(\d+)G/gu)) cols.push(Number(m[1]))
    for (const m of bytes.matchAll(/\u{1b}\[(\d+);(\d+)H/gu)) cols.push(Number(m[2]))
    return cols
  }
  for (const [label, glyph] of [
    ['flag', FLAG],
    ['ZWJ family', FAMILY],
    ['VS16 emoji', WARN_EMOJI],
    ['CJK single-codepoint', '\u{6f22}'],
  ] as Array<[string, string]>) {
    const { bytes } = paint('x'.repeat(COLS - 2) + glyph)
    check(`writer exact-fit ${label}: glyph emitted`, bytes.includes(glyph),
      JSON.stringify(bytes.slice(-120)))
    const over = addressedColumns(bytes).filter(c => c > COLS)
    check(`writer exact-fit ${label}: no addressing beyond the viewport`, over.length === 0,
      `columns ${JSON.stringify(over)}`)
  }
  {
    const emu = paint('x'.repeat(COLS - 2) + '\u{6f22}').replay()
    check('writer exact-fit CJK: replay shows the wide cell in the final two columns',
      emu.grid[0]![COLS - 2] === '\u{6f22}' && emu.grid[0]![COLS - 1] === '',
      JSON.stringify(emu.grid[0]!.slice(COLS - 3)))
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  5. APP RIG — the wedge release + verbatim paste, in-process (fake stdio)
// ════════════════════════════════════════════════════════════════════════════
{
  const React = await import('react')
  const { default: Ink } = await import('../../src/ink/ink.js')
  const { default: instances } = await import('../../src/ink/instances.js')
  const { Text, useInput } = await import('../../src/ink.js')
  const { usePasteHandler } = await import('../../src/hooks/usePasteHandler.js')
  type Key = import('../../src/ink/events/input-event.js').Key
  type InputEvent = import('../../src/ink/events/input-event.js').InputEvent

  class FakeStdout extends EventEmitter {
    isTTY = true
    columns = 80
    rows = 24
    writes: string[] = []
    write(s: string): boolean {
      this.writes.push(s)
      return true
    }
  }
  class FakeStdin extends EventEmitter {
    isTTY = true
    isRaw = false
    private chunks: string[] = []
    setEncoding(): this {
      return this
    }
    setRawMode(v: boolean): this {
      this.isRaw = v
      return this
    }
    ref(): this {
      return this
    }
    unref(): this {
      return this
    }
    read(): string | null {
      return this.chunks.shift() ?? null
    }
    get readableLength(): number {
      return this.chunks.reduce((n, c) => n + c.length, 0)
    }
    push(data: string): void {
      this.chunks.push(data)
      this.emit('readable')
    }
  }
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
  const mount = (element: React.ReactElement): { stdin: FakeStdin; unmount: () => void } => {
    const stdout = new FakeStdout()
    const stdin = new FakeStdin()
    const ink = new Ink({
      stdout: stdout as never,
      stdin: stdin as never,
      stderr: new FakeStdout() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    instances.set(stdout as never, ink)
    ink.render(element)
    return { stdin, unmount: () => ink.unmount() }
  }

  // ── 5a. the wedge release at the dispatched-event boundary ────────────────
  {
    const seen: Array<{ input: string; pasted: boolean }> = []
    const Probe = (): React.ReactElement => {
      useInput((input: string, _key: Key, event: InputEvent) => {
        seen.push({ input, pasted: event.keypress.isPasted === true })
      })
      return React.createElement(Text, null, 'probe')
    }
    const rig = mount(React.createElement(Probe))
    await sleep(130)

    // Bare PASTE_START: the flush (≤500ms paste timeout) releases the mode
    // and delivers the meaningful empty paste. Pre-fix: NOTHING ever arrives
    // and every later keystroke is swallowed (the r2b wedge).
    rig.stdin.push(`${ESC}[200~`)
    await sleep(700)
    check('rig wedge: bare PASTE_START flushes as one empty paste event',
      seen.length === 1 && seen[0]!.pasted === true && seen[0]!.input === '',
      JSON.stringify(seen))
    rig.stdin.push('/')
    await sleep(130)
    check('rig wedge: a keystroke after the release acts normally',
      seen.length === 2 && seen[1]!.input === '/' && seen[1]!.pasted === false,
      JSON.stringify(seen))

    // Backlog: typed text behind a bare START delivers as ONE paste atom.
    seen.length = 0
    rig.stdin.push(`${ESC}[200~`)
    rig.stdin.push('abc')
    await sleep(700)
    check('rig backlog: swallowed text flushes as one paste atom',
      seen.length === 1 && seen[0]!.pasted === true && seen[0]!.input === 'abc',
      JSON.stringify(seen))
    rig.stdin.push('z')
    await sleep(130)
    check('rig backlog: input flows normally after the release',
      seen.length === 2 && seen[1]!.input === 'z' && seen[1]!.pasted === false,
      JSON.stringify(seen))
    rig.unmount()
  }

  // ── 5b. usePasteHandler forwards paste text VERBATIM ──────────────────────
  {
    const pastes: string[] = []
    const PasteProbe = (): React.ReactElement => {
      const { wrappedOnInput } = usePasteHandler({
        onPaste: t => pastes.push(t),
        onInput: () => {},
      })
      useInput(wrappedOnInput)
      return React.createElement(Text, null, 'paste probe')
    }
    const rig = mount(React.createElement(PasteProbe))
    await sleep(130)

    // Literal trailing '[I' / '[O' survive — the scanner owns protocol
    // tokens; the old suffix guessing destroyed real text (native-macos-01).
    rig.stdin.push(`${ESC}[200~grep x[I${ESC}[201~`)
    await sleep(250)
    check('rig paste: literal trailing [I survives verbatim',
      pastes.length === 1 && pastes[0] === 'grep x[I', JSON.stringify(pastes))
    rig.stdin.push(`${ESC}[200~ls [O${ESC}[201~`)
    await sleep(250)
    check('rig paste: literal trailing [O survives verbatim',
      pastes.length === 2 && pastes[1] === 'ls [O', JSON.stringify(pastes))
    rig.stdin.push(`${ESC}[200~hello world${ESC}[201~`)
    await sleep(250)
    check('rig paste: plain paste unchanged',
      pastes.length === 3 && pastes[2] === 'hello world', JSON.stringify(pastes))
    rig.unmount()
  }
}

rmSync(HERMETIC_HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks green`)
process.exit(failures === 0 ? 0 : 1)
