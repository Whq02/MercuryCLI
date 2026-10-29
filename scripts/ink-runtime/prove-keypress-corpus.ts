#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type KeyParseState,
  type ParsedInput,
} from '../../src/ink/input/input-decoder.js'

const GOLDEN = join(import.meta.dir, 'goldens', 'keypress-corpus.json')
const record = process.argv.includes('--record')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function normalize(ev: ParsedInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(ev as Record<string, unknown>).sort()) {
    const v = (ev as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

function decode(segments: Array<string | number[]>): {
  events: Record<string, unknown>[]
  endState: { mode: string; incomplete: string; pasteBuffer: string }
} {
  let state: KeyParseState = { ...INITIAL_STATE, _tokenizer: undefined }
  const events: ParsedInput[] = []
  for (const seg of segments) {
    const input = typeof seg === 'string' ? seg : Buffer.from(seg)
    const [evs, next] = parseMultipleKeypresses(state, input)
    events.push(...evs)
    state = next
  }
  const [flushed, final] = parseMultipleKeypresses(state, null)
  events.push(...flushed)
  return {
    events: events.map(normalize),
    endState: {
      mode: final.mode,
      incomplete: final.incomplete,
      pasteBuffer: final.pasteBuffer,
    },
  }
}

function semanticTrace(events: Record<string, unknown>[]): unknown[] {
  const trace: unknown[] = []
  let text = ''
  const flushText = () => {
    if (text !== '') {
      trace.push({ text })
      text = ''
    }
  }
  for (const ev of events) {
    const payload = String((ev.raw as string | undefined) ?? (ev.sequence as string | undefined) ?? '')
    if (ev.kind === 'key' && ev.isPasted !== true && !payload.includes('\x1b')) {
      text += payload
      continue
    }
    flushText()
    trace.push(ev)
  }
  flushText()
  return trace
}


const ESC = '\x1b'
const CORPUS: Array<{ name: string; input: string; cbcExempt?: string }> = [
  { name: 'plain-lower', input: 'a' },
  { name: 'plain-upper', input: 'Z' },
  { name: 'plain-digit-space', input: '1 ' },
  { name: 'unicode-2byte', input: 'é' },
  { name: 'unicode-arrow', input: '→' },
  { name: 'unicode-emoji', input: '👍' },
  { name: 'unicode-cjk', input: 'あ' },
  { name: 'unicode-combining', input: 'é' },
  { name: 'ctrl-a', input: '\x01' },
  { name: 'ctrl-c', input: '\x03' },
  { name: 'backspace-bs', input: '\x08' },
  { name: 'backspace-del', input: '\x7f' },
  { name: 'return', input: '\r' },
  { name: 'linefeed', input: '\n' },
  { name: 'tab', input: '\t' },
  { name: 'bare-escape', input: ESC },
  { name: 'arrow-up', input: `${ESC}[A` },
  { name: 'arrow-down', input: `${ESC}[B` },
  { name: 'arrow-right', input: `${ESC}[C` },
  { name: 'arrow-left', input: `${ESC}[D` },
  { name: 'ss3-up', input: `${ESC}OA` },
  { name: 'ss3-f1', input: `${ESC}OP` },
  { name: 'ss3-f2', input: `${ESC}OQ` },
  { name: 'shift-up', input: `${ESC}[1;2A` },
  { name: 'ctrl-right', input: `${ESC}[1;5C` },
  { name: 'alt-left', input: `${ESC}[1;3D` },
  { name: 'home', input: `${ESC}[H` },
  { name: 'end', input: `${ESC}[F` },
  { name: 'delete', input: `${ESC}[3~` },
  { name: 'pageup', input: `${ESC}[5~` },
  { name: 'pagedown', input: `${ESC}[6~` },
  { name: 'insert', input: `${ESC}[2~` },
  { name: 'f1-tilde', input: `${ESC}[11~` },
  { name: 'f5', input: `${ESC}[15~` },
  { name: 'f12', input: `${ESC}[24~` },
  { name: 'shift-tab', input: `${ESC}[Z` },
  { name: 'csiu-shift-enter', input: `${ESC}[13;2u` },
  { name: 'csiu-escape', input: `${ESC}[27u` },
  { name: 'csiu-ctrl-a', input: `${ESC}[97;5u` },
  { name: 'csiu-shift-A', input: `${ESC}[65;2u` },
  { name: 'mok-shift-enter', input: `${ESC}[27;2;13~` },
  { name: 'mok-ctrl-tab', input: `${ESC}[27;5;9~` },
  { name: 'meta-f', input: `${ESC}f` },
  { name: 'meta-b', input: `${ESC}b` },
  { name: 'paste-simple', input: `${ESC}[200~hello world${ESC}[201~` },
  { name: 'paste-empty', input: `${ESC}[200~${ESC}[201~` },
  { name: 'paste-with-escapes', input: `${ESC}[200~a${ESC}[Bc${ESC}[201~` },
  { name: 'paste-multiline', input: `${ESC}[200~one\ntwo\rthree${ESC}[201~` },
  { name: 'mouse-sgr-press', input: `${ESC}[<0;10;5M` },
  { name: 'mouse-sgr-release', input: `${ESC}[<0;10;5m` },
  { name: 'mouse-sgr-wheel-up', input: `${ESC}[<64;10;5M` },
  { name: 'mouse-sgr-wheel-down', input: `${ESC}[<65;10;5M` },
  { name: 'mouse-sgr-motion', input: `${ESC}[<35;3;7M` },
  { name: 'mouse-sgr-right-press', input: `${ESC}[<2;1;1M` },
  { name: 'mouse-x10-press', input: `${ESC}[M\x20\x21\x21` },
  { name: 'response-cpr', input: `${ESC}[24;80R` },
  { name: 'response-da1', input: `${ESC}[?1;2c` },
  { name: 'response-decrpm-sync', input: `${ESC}[?2026;1$y` },
  { name: 'response-dsr-ok', input: `${ESC}[0n` },
  { name: 'response-osc11-bel', input: `${ESC}]11;rgb:1616/2c2c/3939\x07` },
  { name: 'response-osc11-st', input: `${ESC}]11;rgb:1616/2c2c/3939${ESC}\\` },
  { name: 'focus-in', input: `${ESC}[I` },
  { name: 'focus-out', input: `${ESC}[O` },
  {
    name: 'multi-event-chunk',
    input: `abc${ESC}[A${ESC}[<0;3;3Mdef\r`,
  },
  { name: 'ctrl-in-text-run', input: 'a\x01b' },
  {
    name: 'crlf-burst',
    input: 'alpha\r\nbeta\r\ngamma',
    cbcExempt:
      'a lone CR read is Enter on the hot path (holding every lone CR would tax Enter by the flush timeout); the pair is judged per read plus a one-read hold for a CR after text',
  },
  {
    name: 'crlf-burst-trailing',
    input: 'alpha\r\nbeta\r\n',
    cbcExempt: 'same law as crlf-burst',
  },
  { name: 'text-then-return', input: 'o\r' },
  {
    name: 'response-interleaved-typing',
    input: `ab${ESC}[?2026;2$ycd`,
  },
  {
    name: 'burst-wheel-events',
    input: `${ESC}[<64;10;5M${ESC}[<64;10;6M${ESC}[<64;10;7M`,
  },
]

const BYTE_PROBES: Array<{ name: string; whole: number[]; segments: number[][] }> = [
  { name: 'bytesplit-emoji-2+2', whole: [0xf0, 0x9f, 0x91, 0x8d], segments: [[0xf0, 0x9f], [0x91, 0x8d]] },
  { name: 'bytesplit-emoji-1+3', whole: [0xf0, 0x9f, 0x91, 0x8d], segments: [[0xf0], [0x9f, 0x91, 0x8d]] },
  { name: 'bytesplit-emoji-3+1', whole: [0xf0, 0x9f, 0x91, 0x8d], segments: [[0xf0, 0x9f, 0x91], [0x8d]] },
  { name: 'bytesplit-emoji-1+1+1+1', whole: [0xf0, 0x9f, 0x91, 0x8d], segments: [[0xf0], [0x9f], [0x91], [0x8d]] },
  { name: 'bytesplit-eacute-1+1', whole: [0xc3, 0xa9], segments: [[0xc3], [0xa9]] },
  { name: 'bytesplit-cjk-1+2', whole: [0xe3, 0x81, 0x82], segments: [[0xe3], [0x81, 0x82]] },
  { name: 'bytesplit-cjk-2+1', whole: [0xe3, 0x81, 0x82], segments: [[0xe3, 0x81], [0x82]] },
  {
    name: 'bytesplit-text-then-split',
    whole: [0x61, 0xe3, 0x81, 0x82, 0x62],
    segments: [[0x61, 0xe3], [0x81, 0x82, 0x62]],
  },
  {
    name: 'bytesplit-escape-then-split',
    whole: [0x1b, 0x5b, 0x41, 0xc3, 0xa9],
    segments: [[0x1b, 0x5b, 0x41, 0xc3], [0xa9]],
  },
]

const DANGLING_PROBES: Array<{ name: string; segments: number[][] }> = [
  { name: 'bytedangling-lone-lead', segments: [[0xc3]] },
  { name: 'bytedangling-partial-emoji', segments: [[0xf0, 0x9f]] },
]

console.log('bedrock keypress corpus — the production decoder')

type Golden = Record<
  string,
  {
    events: Record<string, unknown>[]
    endState: { mode: string; incomplete: string; pasteBuffer: string }
  }
>
const results: Golden = {}

for (const entry of CORPUS) {
  const whole = decode([entry.input])
  results[entry.name] = whole

  const wholeTrace = JSON.stringify(semanticTrace(whole.events))
  const chars = [...entry.input]
  for (let i = 1; i < chars.length; i++) {
    const split = decode([chars.slice(0, i).join(''), chars.slice(i).join('')])
    if (JSON.stringify(semanticTrace(split.events)) !== wholeTrace) {
      check(
        `chunk-split invariance: ${entry.name} @${i}`,
        false,
        `split(${i}) ⇒ ${JSON.stringify(semanticTrace(split.events))} vs whole ⇒ ${wholeTrace}`,
      )
      break
    }
  }
  if (chars.length > 2 && entry.cbcExempt === undefined) {
    const cbc = decode(chars.map(c => c))
    check(
      `char-by-char invariance: ${entry.name}`,
      JSON.stringify(semanticTrace(cbc.events)) === wholeTrace,
      `cbc ⇒ ${JSON.stringify(semanticTrace(cbc.events))}`,
    )
  } else if (entry.cbcExempt !== undefined) {
    console.log(`  [....] char-by-char invariance: ${entry.name} — exempt: ${entry.cbcExempt}`)
  }

  check(
    `post-flush state clean: ${entry.name}`,
    whole.endState.mode === 'NORMAL' && whole.endState.incomplete === '',
    JSON.stringify(whole.endState),
  )
}

for (const probe of BYTE_PROBES) {
  const split = decode(probe.segments)
  const whole = decode([probe.whole])
  check(
    `byte-split invariance: ${probe.name}`,
    JSON.stringify(semanticTrace(split.events)) ===
      JSON.stringify(semanticTrace(whole.events)),
    `split ⇒ ${JSON.stringify(semanticTrace(split.events))} vs whole ⇒ ${JSON.stringify(semanticTrace(whole.events))}`,
  )
  check(
    `byte-split leaves no pending state: ${probe.name}`,
    split.endState.incomplete === '' && split.endState.mode === 'NORMAL',
    JSON.stringify(split.endState),
  )
  results[probe.name] = split
}
for (const probe of DANGLING_PROBES) {
  const dangling = decode(probe.segments)
  const whole = decode([probe.segments.flat()])
  check(
    `dangling tail flushes like the whole feed: ${probe.name}`,
    JSON.stringify(semanticTrace(dangling.events)) ===
      JSON.stringify(semanticTrace(whole.events)),
    `dangling ⇒ ${JSON.stringify(semanticTrace(dangling.events))} vs whole ⇒ ${JSON.stringify(semanticTrace(whole.events))}`,
  )
  results[probe.name] = dangling
}

console.log(
  `  ${CORPUS.length} corpus entries + ${BYTE_PROBES.length + DANGLING_PROBES.length} byte probes exercised`,
)

if (record) {
  writeFileSync(GOLDEN, JSON.stringify(results, null, 1) + '\n')
  console.log(`  recorded → ${GOLDEN}`)
} else {
  check('golden exists (run --record once)', existsSync(GOLDEN))
  if (existsSync(GOLDEN)) {
    const golden: Golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    check(
      'entry inventory matches',
      JSON.stringify(Object.keys(golden).sort()) ===
        JSON.stringify(Object.keys(results).sort()),
      'corpus drift — regenerate deliberately with --record',
    )
    let mismatches = 0
    for (const name of Object.keys(golden)) {
      if (!results[name]) continue
      if (JSON.stringify(golden[name]) !== JSON.stringify(results[name])) {
        mismatches++
        if (mismatches <= 5)
          console.log(
            `  [FAIL] ${name}:\n    golden ${JSON.stringify(golden[name]!.events)}\n    live   ${JSON.stringify(results[name]!.events)}`,
          )
      }
    }
    check('all decoded sequences match the golden', mismatches === 0, `${mismatches} entries diverged`)
  }
}

if (failures > 0) {
  console.log(`\nbedrock keypress corpus: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock keypress corpus: green')
