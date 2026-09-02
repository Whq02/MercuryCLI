import { C0, ESC_TYPE, isEscFinal } from '../termio/ansi.js'
import { isCSIFinal, isCSIIntermediate, isCSIParam } from '../termio/csi.js'

// ============================================================================
//  scanner — the Mercury escape-boundary scanner.
//
//  RESPONSIBILITY: decoded text → a stream of KIND-TAGGED tokens (text · the
//  escape-sequence families · X10 mouse), carrying incomplete sequences
//  between feeds and owning the ONE flush policy for partial input. The
//  interpreter downstream dispatches on the kind the scanner already proved —
//  boundaries are derived exactly once.
//
//  THE FLUSH POLICY (the fast-scroll ESC race, named in one place):
//    · a partially-buffered MOUSE head is DROPPED on flush — it carries no
//      actionable keypress, and force-emitting it parsed as a bare Escape
//      (which INTERRUPTED the model) or leaked garbage;
//    · dropping an SGR head arms `resync`: the event's prefix-less tail
//      (`<?[digits;]*[Mm]`) arriving in a later read is SWALLOWED, never
//      leaked as text; the first non-tail byte bails resync to ground;
//    · a genuine lone ESC still flushes (the user's Escape must interrupt);
//    · any other partial sequence force-emits as-is (characterized).
//
//  CONTRACT: prove-keypress-corpus (whole-feed goldens + split invariance) +
//  prove-input-contract (mid-flush · response splits · orphan preconditions).
// ============================================================================

export type TokenKind =
  | 'text'
  | 'csi'
  | 'ss3'
  | 'osc'
  | 'dcs'
  | 'apc'
  | 'esc' // two-character / intermediate escape (incl. bare ESC on flush)
  | 'x10-mouse'

export type ScanToken = { kind: TokenKind; value: string }

type ScanState =
  | 'ground'
  | 'escape'
  | 'escapeIntermediate'
  | 'csi'
  | 'ss3'
  | 'osc'
  | 'dcs'
  | 'apc'
  | 'resync'

export type ScannerOptions = {
  /** Treat `CSI M` as an X10 mouse prefix consuming 3 payload bytes. Enable
   *  ONLY for stdin — in output streams `\x1b[M` is CSI DL (Delete Lines). */
  x10Mouse?: boolean
}

export type Scanner = {
  feed(input: string): ScanToken[]
  flush(): ScanToken[]
  reset(): void
  buffer(): string
}

/** The token kind a carried run resumes with, per scan state. */
const KIND_OF_STATE: Partial<Record<ScanState, TokenKind>> = {
  csi: 'csi',
  ss3: 'ss3',
  osc: 'osc',
  dcs: 'dcs',
  apc: 'apc',
}

export function createScanner(options?: ScannerOptions): Scanner {
  const x10Mouse = options?.x10Mouse ?? false
  let state: ScanState = 'ground'
  let carry = ''
  // THE SEAL DEADLINE: a partial string sequence may seal ONE flush — a genuine terminal
  // reply lands its terminator within a flush window — but a SECOND
  // consecutive flush that still ends sealed means no terminator is coming
  // (a meta chord followed by fast typing, `ESC ] abc` in one read), and
  // the machine returns to ground so the loop hears the keyboard again.
  // The swallowed body bytes stay dropped, exactly as the seal always
  // dropped them; only the deafness ends.
  let sealedFlushes = 0

  const run = (input: string, flush: boolean): ScanToken[] => {
    const result = scan(carry + input, state, flush, x10Mouse)
    state = result.state
    carry = result.carry
    if (flush) {
      if (state === 'osc' || state === 'dcs' || state === 'apc') {
        sealedFlushes++
        if (sealedFlushes >= 2) {
          state = 'ground'
          carry = ''
          sealedFlushes = 0
        }
      } else {
        sealedFlushes = 0
      }
    } else if (state === 'ground') {
      // Only a feed that RETURNS the machine to ground ends the streak. A
      // feed swallowed as body bytes keeps the deadline armed — the loop
      // feeds every tick, so a reset-on-any-feed made the second sealed
      // flush unreachable and the deafness never ended.
      sealedFlushes = 0
    }
    return result.tokens
  }

  return {
    feed: input => run(input, false),
    flush: () => run('', true),
    reset: () => {
      state = 'ground'
      carry = ''
      sealedFlushes = 0
    },
    buffer: () => carry,
  }
}

/** True iff `s` is the HEAD of an as-yet-incomplete mouse event. A bare lone
 *  ESC is deliberately NOT matched — it may be a genuine Escape keypress. */
function isPartialMouseHead(s: string, x10Mouse: boolean): boolean {
  if (/^\x1b\[<[\d;]*$/.test(s)) return true
  if (s === '\x1b[') return true
  if (x10Mouse && /^\x1b\[M[\s\S]{0,2}$/.test(s)) return true
  return false
}

function scan(
  data: string,
  initial: ScanState,
  flush: boolean,
  x10Mouse: boolean,
): { tokens: ScanToken[]; state: ScanState; carry: string } {
  const tokens: ScanToken[] = []
  let state = initial
  let i = 0
  let textStart = 0
  let seqStart = 0
  // The kind the current escape run will carry when it completes. A carried
  // run re-enters in its state — seed the kind FROM that state (audit T4-F1:
  // OSC/DCS/APC consume the re-fed ESC as a body byte and never re-derive,
  // so a per-call 'esc' default mislabeled their flush tails).
  let seqKind: TokenKind = KIND_OF_STATE[initial] ?? 'esc'

  const flushText = (): void => {
    if (i > textStart) {
      tokens.push({ kind: 'text', value: data.slice(textStart, i) })
    }
    textStart = i
  }

  const emit = (kind: TokenKind): void => {
    const value = data.slice(seqStart, i)
    // The empty emit is the carried-ESC re-anchor no-op (a carry re-entering
    // through the double-escape branch at i === seqStart) — nothing to emit.
    if (value) tokens.push({ kind, value })
    state = 'ground'
    textStart = i
  }

  /** The buffered run turned out not to be a sequence — reprocess it as text
   *  from its start. */
  const revertToText = (): void => {
    state = 'ground'
    textStart = seqStart
  }

  while (i < data.length) {
    const code = data.charCodeAt(i)
    switch (state) {
      case 'ground':
        if (code === C0.ESC) {
          flushText()
          seqStart = i
          seqKind = 'esc'
          state = 'escape'
        }
        i++
        break

      case 'resync':
        // Swallow the prefix-less tail of a flush-dropped SGR mouse head.
        if (code === 0x3c || (code >= 0x30 && code <= 0x39) || code === 0x3b) {
          i++
          textStart = i
        } else if (code === 0x4d || code === 0x6d) {
          i++
          textStart = i
          state = 'ground'
        } else {
          // Not a mouse tail — reprocess this byte in ground.
          state = 'ground'
          textStart = i
        }
        break

      case 'escape':
        if (code === ESC_TYPE.CSI) {
          state = 'csi'
          seqKind = 'csi'
          i++
        } else if (code === ESC_TYPE.OSC) {
          state = 'osc'
          seqKind = 'osc'
          i++
        } else if (code === ESC_TYPE.DCS) {
          state = 'dcs'
          seqKind = 'dcs'
          i++
        } else if (code === ESC_TYPE.APC) {
          state = 'apc'
          seqKind = 'apc'
          i++
        } else if (code === 0x4f /* O */) {
          state = 'ss3'
          seqKind = 'ss3'
          i++
        } else if (isCSIIntermediate(code)) {
          state = 'escapeIntermediate'
          i++
        } else if (isEscFinal(code)) {
          i++
          emit('esc')
        } else if (code === C0.ESC) {
          // Double escape: emit the first, start a new run.
          emit('esc')
          seqStart = i
          seqKind = 'esc'
          state = 'escape'
          i++
        } else {
          revertToText()
        }
        break

      case 'escapeIntermediate':
        if (isCSIIntermediate(code)) {
          i++
        } else if (isEscFinal(code)) {
          i++
          emit('esc')
        } else {
          revertToText()
        }
        break

      case 'csi':
        // X10 mouse: `CSI M` with NO params + 3 payload chars, each ≥0x20.
        // A control byte in any payload slot means CSI-DL adjacency (e.g.
        // PASTE_END right behind) — not a mouse event. Char-counted, not
        // byte-counted: the no-SGR-terminal 162-191-column collapse is a
        // characterized, deliberately-accepted limitation.
        if (
          x10Mouse &&
          code === 0x4d /* M */ &&
          i - seqStart === 2 &&
          (i + 1 >= data.length || data.charCodeAt(i + 1) >= 0x20) &&
          (i + 2 >= data.length || data.charCodeAt(i + 2) >= 0x20) &&
          (i + 3 >= data.length || data.charCodeAt(i + 3) >= 0x20)
        ) {
          if (i + 4 <= data.length) {
            i += 4
            emit('x10-mouse')
          } else {
            i = data.length // incomplete — carried below
          }
          break
        }
        if (isCSIFinal(code)) {
          i++
          emit('csi')
        } else if (isCSIParam(code) || isCSIIntermediate(code)) {
          i++
        } else {
          revertToText()
        }
        break

      case 'ss3':
        if (code >= 0x40 && code <= 0x7e) {
          i++
          emit('ss3')
        } else {
          revertToText()
        }
        break

      case 'osc':
      case 'dcs':
      case 'apc':
        if (code === C0.BEL) {
          i++
          emit(state as TokenKind)
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2
          emit(state as TokenKind)
        } else {
          i++
        }
        break
    }
  }

  // End of input.
  if (state === 'ground') {
    flushText()
    return { tokens, state, carry: '' }
  }
  if (state === 'resync') {
    // Mid-swallow: nothing buffered; the state itself persists across reads
    // AND flushes until the tail terminates or a real byte bails it.
    return { tokens, state, carry: '' }
  }
  const remaining = data.slice(seqStart)
  if (!flush) {
    return { tokens, state, carry: remaining }
  }
  // FLUSH with a partial sequence buffered — the policy block.
  if (remaining && isPartialMouseHead(remaining, x10Mouse)) {
    const next: ScanState = /^\x1b\[<?[\d;]*$/.test(remaining) ? 'resync' : 'ground'
    return { tokens, state: next, carry: '' }
  }
  // A partial STRING sequence (OSC/DCS/APC) must never flush to ground:
  // its unterminated tail arrives in the next read, where the body bytes
  // would leak as text and the BEL terminator would decode as a SYNTHETIC
  // ctrl+g keypress (the externalEditor kill-chain class, field
  // intake E). Drop the partial and STAY in the string state — the machine
  // swallows the tail through its real BEL/ST terminator.
  if (remaining && (state === 'osc' || state === 'dcs' || state === 'apc')) {
    // A body-less introducer at the flush — ESC ] · ESC P · ESC _ with
    // NOTHING behind it — is a keyboard meta chord (alt+] on Windows
    // Terminal), not a string sequence: a terminal's own reply carries its
    // body in the same write. Sealing that shape kept the machine in the
    // string state for good, every later keystroke swallowed as body bytes
    // with no terminator ever coming — one alt+] deafened the input loop
    // (TASK-014 w2-f12-01). It passes as an ESC-led token; a partial WITH
    // body bytes keeps the seal above.
    if (remaining.length <= 2) {
      tokens.push({ kind: 'esc', value: remaining })
      return { tokens, state: 'ground', carry: '' }
    }
    return { tokens, state, carry: '' }
  }
  if (remaining) {
    tokens.push({ kind: seqKind, value: remaining })
  }
  return { tokens, state: 'ground', carry: '' }
}
