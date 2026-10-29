import { C0, ESC, ESC_TYPE, isEscFinal } from '../termio/ansi.js'
import { isCSIFinal, isCSIIntermediate, isCSIParam } from '../termio/csi.js'


export type TokenKind =
  | 'text'
  | 'csi'
  | 'ss3'
  | 'osc'
  | 'dcs'
  | 'apc'
  | 'esc'
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

type ScannerOptions = {
  x10Mouse?: boolean
  stringReplyOwed?: () => boolean
}

export type Scanner = {
  feed(input: string): ScanToken[]
  flush(): ScanToken[]
  reset(): void
  buffer(): string
}

const KIND_OF_STATE: Partial<Record<ScanState, TokenKind>> = {
  csi: 'csi',
  ss3: 'ss3',
  osc: 'osc',
  dcs: 'dcs',
  apc: 'apc',
}

export function createScanner(options?: ScannerOptions): Scanner {
  const x10Mouse = options?.x10Mouse ?? false
  const stringReplyOwed = options?.stringReplyOwed
  let state: ScanState = 'ground'
  let carry = ''
  let sealedFlushes = 0
  let fedSinceFlush = false
  let flushedHead = ''
  let terminatorOwed = false
  let heldRun = false
  let provisionalBracket = false
  let escapeAlone = false

  const run = (input: string, flush: boolean): ScanToken[] => {
    const head = flushedHead
    const reanchor = head !== '' && !flush && state === 'ground' && isReplyBody(head, input, x10Mouse)
    if (!flush) escapeAlone = input === ESC && STRING_INTRODUCER[state] !== undefined
    const result = scan((reanchor ? head : '') + carry + input, state, flush, x10Mouse, {
      sealedFlushes,
      fedSinceFlush,
      stringReplyOwed: flush && stringReplyOwed?.() === true,
      terminatorOwed,
      heldRun,
      provisionalBracket,
      escapeAlone,
    })
    state = result.state
    carry = result.carry
    terminatorOwed = result.terminatorOwed === true
    heldRun = result.heldRun === true
    provisionalBracket = reanchor && head === ESC && input === '[' && state === 'csi'
    flushedHead = flush ? result.flushedHead ?? (result.tokens.length === 0 ? head : '') : input === '' ? head : ''
    if (flush) {
      sealedFlushes = result.sealed ? sealedFlushes + 1 : 0
      fedSinceFlush = false
    } else {
      fedSinceFlush = true
      if (state === 'ground') sealedFlushes = 0
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
      fedSinceFlush = false
      flushedHead = ''
      terminatorOwed = false
      heldRun = false
      provisionalBracket = false
      escapeAlone = false
    },
    buffer: () => carry,
  }
}

type FlushPolicy = {
  sealedFlushes: number
  fedSinceFlush: boolean
  stringReplyOwed: boolean
  terminatorOwed: boolean
  heldRun: boolean
  provisionalBracket: boolean
  escapeAlone: boolean
}

const CSI_HOLD_FLUSHES = 2

const STRING_INTRODUCER: Partial<Record<ScanState, number>> = {
  osc: ESC_TYPE.OSC,
  dcs: ESC_TYPE.DCS,
  apc: ESC_TYPE.APC,
}

const CSI_HEAD = ESC + '['

function isCsiByte(code: number): boolean {
  return code >= 0x20 && code <= 0x7e
}

function isX10Head(head: string): boolean {
  return head.length >= 3 && head.length <= 5 && head.charCodeAt(2) === 0x4d
}

function isReplyBody(head: string, s: string, x10Mouse: boolean): boolean {
  if (head.length > 2 && head.endsWith(ESC)) return s.startsWith('\\')
  if (head === ESC) return /^(?:\[[\x20-\x7e]|\]\d|P>)/.test(s)
  if (head === ESC + ']') return /^\d/.test(s)
  if (head === ESC + 'P') return s.startsWith('>')
  if (!head.startsWith(CSI_HEAD) || s === '') return false
  const code = s.charCodeAt(0)
  return x10Mouse && isX10Head(head) ? code >= 0x20 && code !== 0x7f : isCsiByte(code)
}

const REPLY_STRING_HEAD = /^\x1b(?:\]\d+(?:;|$)|P>(?:\||$))/

function isReplyStringHead(s: string): boolean {
  return REPLY_STRING_HEAD.test(s)
}

function isStringBodyByte(code: number): boolean {
  return code >= 0x20 && code !== 0x7f
}

function isMetaPrefixedIntroducer(code: number): boolean {
  return code === ESC_TYPE.CSI || code === 0x4f
}

function isMouseReportHead(data: string, at: number, x10Mouse: boolean): boolean {
  if (data.charCodeAt(at) !== ESC_TYPE.CSI) return false
  const marker = data.charCodeAt(at + 1)
  return marker === 0x3c || (x10Mouse && marker === 0x4d)
}

const DOUBLE_ESC = ESC + ESC

function scan(
  data: string,
  initial: ScanState,
  flush: boolean,
  x10Mouse: boolean,
  policy: FlushPolicy,
): { tokens: ScanToken[]; state: ScanState; carry: string; sealed?: boolean; flushedHead?: string; terminatorOwed?: boolean; heldRun?: boolean } {
  const tokens: ScanToken[] = []
  let state = initial
  let heldRun = policy.heldRun
  let i = 0
  let textStart = 0
  let seqStart = 0
  let seqKind: TokenKind = KIND_OF_STATE[initial] ?? 'esc'
  let terminatorOwed = policy.terminatorOwed
  let terminatorOwedNow = false
  let releasedAtFlush = ''

  const flushText = (): void => {
    if (i > textStart) {
      tokens.push({ kind: 'text', value: data.slice(textStart, i) })
      terminatorOwed = false
    }
    textStart = i
  }

  const emit = (kind: TokenKind): void => {
    const value = data.slice(seqStart, i)
    if (value) {
      if (value === ESC + '\\' && (terminatorOwed || terminatorOwedNow)) {
        terminatorOwed = false
        terminatorOwedNow = false
      } else {
        tokens.push({ kind, value })
        terminatorOwed = false
      }
    }
    state = 'ground'
    textStart = i
    heldRun = false
  }

  const releaseStringBody = (): void => {
    const head = data.slice(seqStart, i)
    if (isReplyStringHead(head)) {
      terminatorOwedNow = true
      if (flush && data.charCodeAt(i) === C0.ESC && i + 1 >= data.length) releasedAtFlush = head + ESC
    }
    state = 'ground'
    textStart = i
  }

  const revertToText = (): void => {
    state = 'ground'
    textStart = seqStart
  }

  const dropHeldRun = (at: number): void => {
    state = 'ground'
    textStart = at
    i = at
    heldRun = false
  }

  const emitString = (): void => {
    const headed =
      data.charCodeAt(seqStart) === C0.ESC && data.charCodeAt(seqStart + 1) === STRING_INTRODUCER[state]
    if (headed) {
      emit(state as TokenKind)
      return
    }
    state = 'ground'
    textStart = i
  }

  while (i < data.length) {
    const code = data.charCodeAt(i)
    switch (state) {
      case 'ground':
        if (code === C0.ESC) {
          if ((terminatorOwed || terminatorOwedNow) && data.charCodeAt(i + 1) === ESC_TYPE.ST) {
            terminatorOwed = false
            terminatorOwedNow = false
            i += 2
            textStart = i
            break
          }
          flushText()
          seqStart = i
          seqKind = 'esc'
          state = 'escape'
        } else if (code === C0.BEL && (terminatorOwed || terminatorOwedNow)) {
          terminatorOwed = false
          terminatorOwedNow = false
          i++
          textStart = i
          break
        }
        i++
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
        } else if (code === 0x4f ) {
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
          if (
            i + 1 >= data.length ||
            (isMetaPrefixedIntroducer(data.charCodeAt(i + 1)) && !isMouseReportHead(data, i + 1, x10Mouse))
          ) {
            i++
            break
          }
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
        if (x10Mouse && code === 0x4d  && i - seqStart === 2) {
          const payloadEnd = Math.min(i + 4, data.length)
          let control = -1
          for (let at = i + 1; at < payloadEnd && control === -1; at++) {
            const slot = data.charCodeAt(at)
            if (slot < 0x20 || (heldRun && slot === 0x7f)) control = at
          }
          if (control === -1) {
            if (i + 4 <= data.length) {
              i += 4
              emit('x10-mouse')
            } else {
              i = data.length
            }
            break
          }
          if (heldRun) {
            dropHeldRun(control)
            break
          }
        }
        if (isCSIFinal(code)) {
          if (heldRun && data.charCodeAt(seqStart + 2) === 0x3c && code !== 0x4d && code !== 0x6d) {
            dropHeldRun(i)
            break
          }
          i++
          emit('csi')
        } else if (isCSIParam(code) || isCSIIntermediate(code)) {
          i++
        } else if (heldRun && i > seqStart) {
          dropHeldRun(i)
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
          emitString()
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2
          emitString()
        } else if (
          code === C0.ESC &&
          i + 1 >= data.length &&
          (!flush || (x10Mouse && !policy.escapeAlone && isReplyStringHead(data.slice(seqStart, i))))
        ) {
          i++
        } else if (code === C0.ESC || !isStringBodyByte(code)) {
          releaseStringBody()
        } else {
          i++
        }
        break
    }
  }
  if (state === 'ground') {
    flushText()
    return { tokens, state, carry: '', terminatorOwed: terminatorOwed || terminatorOwedNow }
  }
  const owed = terminatorOwed || terminatorOwedNow
  const remaining = data.slice(seqStart)
  if (!flush) {
    return { tokens, state, carry: remaining, terminatorOwed: owed, heldRun }
  }
  if (remaining && (state === 'osc' || state === 'dcs' || state === 'apc')) {
    if (remaining.length <= 2 && remaining.charCodeAt(0) === C0.ESC) {
      tokens.push({ kind: 'esc', value: remaining })
      return { tokens, state: 'ground', carry: '', flushedHead: remaining, terminatorOwed: owed }
    }
    if (policy.stringReplyOwed || isReplyStringHead(remaining)) return { tokens, state, carry: remaining, terminatorOwed: owed }
    if (policy.sealedFlushes === 0) return { tokens, state, carry: remaining, sealed: true, terminatorOwed: owed }
    if (!policy.fedSinceFlush) return { tokens, state, carry: '', sealed: true, terminatorOwed: owed }
    return { tokens, state: 'ground', carry: '', terminatorOwed: owed }
  }
  if (remaining && state === 'csi' && x10Mouse) {
    if (policy.provisionalBracket && remaining === CSI_HEAD) {
      tokens.push({ kind: 'text', value: '[' })
      return { tokens, state: 'ground', carry: '', terminatorOwed: owed }
    }
    if (policy.sealedFlushes < CSI_HOLD_FLUSHES) {
      return { tokens, state, carry: remaining, sealed: true, terminatorOwed: owed, heldRun: true }
    }
    tokens.push({ kind: 'csi', value: remaining })
    return { tokens, state: 'ground', carry: '', flushedHead: remaining, terminatorOwed: owed }
  }
  if (remaining === DOUBLE_ESC) {
    tokens.push({ kind: 'esc', value: ESC }, { kind: 'esc', value: ESC })
    return { tokens, state: 'ground', carry: '', terminatorOwed: owed }
  }
  if (remaining) {
    tokens.push({ kind: seqKind, value: remaining })
  }
  return { tokens, state: 'ground', carry: '', flushedHead: releasedAtFlush || (remaining === ESC ? ESC : ''), terminatorOwed: owed }
}
