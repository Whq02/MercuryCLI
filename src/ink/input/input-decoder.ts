import { Buffer } from 'buffer'
import { isModernWindowsTerminal } from '../session/capabilities.js'
import { PASTE_END, PASTE_START } from '../termio/csi.js'
import { decodeChunk } from './byte-decoder.js'
import {
  createScanner,
  type Scanner,
  type ScanToken,
} from './scanner.js'
import {
  createPasteKey,
  extractOrphanMouseEvents,
  hasOrphanMouseBytes,
  interpretKey,
  interpretMouse,
  interpretResponse,
  type ParsedInput,
} from './interpreter.js'

// ============================================================================
//  input-decoder — the Mercury input pipeline.
//
//  RESPONSIBILITY: compose the three input owners — the BYTE DECODER
//  (UTF-8 tails), the SCANNER (escape boundaries + the flush policy), the
//  INTERPRETER (tokens → typed atoms) — plus bracketed-paste assembly, behind
//  the exact public seam the app consumes:
//
//      parseMultipleKeypresses(state, chunk | null) → [atoms, state]
//
//  null = flush (the caller owns TIMING: App's 50ms/500ms timers). Paste
//  rules: sequences inside a paste are literal text; PASTE_END always emits —
//  an EMPTY paste is meaningful (macOS clipboard-image detection); a flush
//  mid-paste ALWAYS exits paste mode, emitting the partial content (empty
//  included — a bare PASTE_START must never latch the mode).
//
//  THE CRLF-PASTE LAW: inside a text run CR LF is a line break and a lone CR
//  is Enter; a chunk-final CR after text in the SAME read is held one read
//  (an LF completes the pair) or until the flush (Enter) — a lone "\r" read
//  is Enter at once with no hold, so the corpus binds the CRLF entries by the
//  two-chunk split law, never the char-by-char law (a paste never arrives one
//  byte per read; holding every lone CR would tax the most-pressed key).
//  THE BURST CLAUSE (HOST-GATED): on the unbracketed-paste host — win32
//  WITHOUT WT_SESSION, the legacy console — a lone CR with text on both
//  sides inside one read is a line break too: that shape is a CR-delimited
//  paste there, never typing. Every bracketed-paste host keeps the Enter —
//  text-CR-text in one read is TYPING buffered across an event-loop stall,
//  and swallowing that send cost more than the paste fix bought. A conhost paste split by the kernel exactly at a
//  CR still reads that CR as Enter (recorded residual).
//
//  CONTRACT: the B3 keypress corpus (byte-exact goldens + split invariance)
//  + prove-query-mux + prove-input-contract (mid-flush · paste containment ·
//  response disambiguation · orphan extraction · state hygiene · UTF-8).
// ============================================================================

export type KeyParseState = {
  mode: 'NORMAL' | 'IN_PASTE'
  incomplete: string
  pasteBuffer: string
  /** Incomplete UTF-8 tail carried between chunks (the B3 law). */
  pendingBytes?: Buffer
  /** A chunk-final CR after text, held back one chunk (or until the flush):
   *  CR LF is a line break and a lone CR is Enter — the CRLF-paste law — so
   *  the pair must be judged whole even when a read boundary splits it. */
  heldCR?: boolean
  /** The scanner instance rides the state so a session's carry survives. */
  _scanner?: Scanner
}

export const INITIAL_STATE: KeyParseState = {
  mode: 'NORMAL',
  incomplete: '',
  pasteBuffer: '',
}

let burstCrHostOverride: boolean | null = null

/** Proof seam: pin both hosts' CR laws from one process. */
export function __setBurstCrHostForTest(v: boolean | null): void {
  burstCrHostOverride = v
}

/**
 * THE BURST-CLAUSE HOST GATE: a lone CR between text is a PASTE shape only
 * where bracketed paste never arrives — the legacy Windows console. Windows
 * Terminal and every POSIX terminal Mercury supports honour the
 * bracketed-paste request, so text-CR-text there is typed input buffered
 * across an event-loop stall and the Enter must fire.
 *
 * The host question is the ONE owner's (TASK-017 supplement, SURVIVED ×2:
 * the gate read raw WT_SESSION while the profile owner already knew that
 * is not a WT witness): isModernWindowsTerminal also clears VS Code's
 * integrated terminal and mintty/MSYS — first-class hosts whose pastes
 * arrive bracketed, where the CR rewrite silently turned Enter into a
 * newline and the turn never sent. WT as the OS default terminal (no
 * WT_SESSION, no env marker at all) still reads legacy here — that
 * residual needs the profile's runtime probe, recorded as a lead.
 */
export function burstCrIsLineBreak(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (burstCrHostOverride !== null) return burstCrHostOverride
  return platform === 'win32' && !isModernWindowsTerminal(env, platform)
}

/** Split a coalesced text run at CONTROL boundaries (TASK-009 F3 class,
 * printable runs stay grouped (the paste-ish whole-string
 *  insert semantics), C0/DEL bytes emit as their OWN atoms so their key
 *  names act — 'abc\r' in one chunk is text + return (the C-MED-5 "text↵"
 *  law at the byte layer), '\t\t' steps twice, 'abc\x03' still interrupts;
 *  the glued form was one NAMELESS atom that neither inserted nor acted.
 *  An ESC-led run (a scanner revert — '\x1b\b' meta forms) passes whole:
 *  the interpreter's literal ladder owns those spellings.
 *  LF stays IN the run: by the CRLF-paste law and its host-gated burst
 *  clause, \r\n pairs and conhost lone-CRs are already CONVERTED to \n as
 *  embedded line breaks — content with insert semantics, never a key act —
 *  and splitting them here re-minted the Enter the ruling removed (each
 *  pasted line went out as its own turn). A lone LF read (ctrl-J's byte,
 *  arriving alone — terminals send Enter as CR) still names its key via the
 *  single-char pass-through. */
function splitControlRuns(value: string): string[] {
  if (value.length < 2 || value.charCodeAt(0) === 0x1b) return [value]
  const out: string[] = []
  let run = ''
  for (const ch of value) {
    const c = ch.codePointAt(0)!
    if ((c < 0x20 && c !== 0x0a) || c === 0x7f) {
      if (run) {
        out.push(run)
        run = ''
      }
      out.push(ch)
    } else {
      run += ch
    }
  }
  if (run) out.push(run)
  return out
}

export function parseMultipleKeypresses(
  prevState: KeyParseState,
  input: Buffer | string | null = '',
): [ParsedInput[], KeyParseState] {
  const isFlush = input === null

  const { text, pending } = decodeChunk(prevState.pendingBytes, input)
  const scanner = prevState._scanner ?? createScanner({ x10Mouse: true })

  // A flush first scans any decoded pending tail, then drains the carry.
  const tokens: ScanToken[] = isFlush
    ? [...(text ? scanner.feed(text) : []), ...scanner.flush()]
    : scanner.feed(text)

  const atoms: ParsedInput[] = []
  let inPaste = prevState.mode === 'IN_PASTE'
  let pasteBuffer = prevState.pasteBuffer

  // THE CRLF-PASTE LAW. A Windows clipboard on a host without bracketed
  // paste arrives as plain bytes with CR LF line endings; split at control
  // boundaries, the first CR was Enter and dispatched line one as a turn
  // while the rest stranded in the composer. CR LF is a line break (the LF
  // the LF-paste path already treats as content), a lone CR is Enter. A
  // chunk-final CR after text is HELD until the next chunk (an LF completes
  // the pair — the CR vanishes into the break) or the flush (Enter, ~50ms
  // later) — a read boundary inside the pair never changes what the bytes
  // mean, and every chunking decodes to one semantic trace.
  if (prevState.heldCR) {
    const first = tokens[0]
    const pairCompletes =
      first !== undefined && first.kind === 'text' && !inPaste && first.value.startsWith('\n')
    if (!pairCompletes) atoms.push(interpretKey('\r'))
  }
  let heldCR = false

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'text') {
      if (inPaste) {
        pasteBuffer += token.value
      } else if (hasOrphanMouseBytes(token.value)) {
        extractOrphanMouseEvents(token.value, atoms)
      } else {
        let value = token.value.replace(/\r\n/g, '\n')
        // THE BURST CLAUSE of the CRLF-paste law, HOST-GATED: on the
        // unbracketed-paste host a lone CR BETWEEN text in one read is a
        // line break, not Enter — a CR-delimited conhost paste dispatched
        // line one as a turn and glued the rest (TASK-014 w2-f13-03 /
        // w2-f16-03). On every bracketed-paste host that byte shape is
        // TYPING buffered across an event-loop stall, and the Enter fires
        // A CR at the end of the read keeps the
        // Enter law below on either host.
        if (burstCrIsLineBreak()) value = value.replace(/\r(?=[^\r\n])/g, '\n')
        if (
          !isFlush &&
          i === tokens.length - 1 &&
          value.length >= 2 &&
          value.endsWith('\r') &&
          isPlainChar(value.charCodeAt(value.length - 2))
        ) {
          value = value.slice(0, -1)
          heldCR = true
        }
        for (const seg of splitControlRuns(value)) atoms.push(interpretKey(seg))
      }
      continue
    }
    // Sequence-family tokens.
    if (token.value === PASTE_START) {
      inPaste = true
      pasteBuffer = ''
    } else if (token.value === PASTE_END) {
      atoms.push(createPasteKey(pasteBuffer))
      inPaste = false
      pasteBuffer = ''
    } else if (inPaste) {
      pasteBuffer += token.value
    } else {
      const response = interpretResponse(token.value)
      if (response) {
        atoms.push({ kind: 'response', sequence: token.value, response })
        continue
      }
      const mouse = interpretMouse(token.value)
      if (mouse) {
        atoms.push(mouse)
        continue
      }
      atoms.push(interpretKey(token.value))
    }
  }

  // A flush ALWAYS exits paste mode: the partial
  // content emits as the paste, and an EMPTY partial still emits — the empty
  // paste is meaningful (see the header). Gating this on a nonempty buffer
  // latched IN_PASTE after a consumed bare PASTE_START, and every later
  // keystroke buffered forever.
  if (isFlush && inPaste) {
    atoms.push(createPasteKey(pasteBuffer))
    inPaste = false
    pasteBuffer = ''
  }

  return [
    atoms,
    {
      mode: inPaste ? 'IN_PASTE' : 'NORMAL',
      incomplete: scanner.buffer(),
      pasteBuffer,
      pendingBytes: pending,
      heldCR,
      _scanner: scanner,
    },
  ]
}

/** A printable code unit (the byte before a held CR must be text, never a
 *  control — 'abc\r' holds, '\t\r' does not). */
function isPlainChar(c: number): boolean {
  return c >= 0x20 && c !== 0x7f
}

// The atom vocabulary + tables are the interpreter's exports — re-exported
// here so consumers import the ONE pipeline seam.
export {
  DECRPM_STATUS,
  nonAlphanumericKeys,
  type ParsedInput,
  type ParsedKey,
  type ParsedMouse,
  type ParsedResponse,
  type TerminalResponse,
} from './interpreter.js'
