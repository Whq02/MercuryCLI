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
  | 'resync'

export type ScannerOptions = {
  x10Mouse?: boolean
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
  let state: ScanState = 'ground'
  let carry = ''
  let sealedFlushes = 0
  let fedSinceFlush = false

  const run = (input: string, flush: boolean): ScanToken[] => {
    const result = scan(carry + input, state, flush, x10Mouse, { sealedFlushes, fedSinceFlush })
    state = result.state
    carry = result.carry
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
    },
    buffer: () => carry,
  }
}

type FlushPolicy = {
  sealedFlushes: number
  fedSinceFlush: boolean
}

function isResponseHead(s: string): boolean {
  return /^\x1b\[[?>]/.test(s)
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
  policy: FlushPolicy,
): { tokens: ScanToken[]; state: ScanState; carry: string; sealed?: boolean } {
  const tokens: ScanToken[] = []
  let state = initial
  let i = 0
  let textStart = 0
  let seqStart = 0
  let seqKind: TokenKind = KIND_OF_STATE[initial] ?? 'esc'

  const flushText = (): void => {
    if (i > textStart) {
      tokens.push({ kind: 'text', value: data.slice(textStart, i) })
    }
    textStart = i
  }

  const emit = (kind: TokenKind): void => {
    const value = data.slice(seqStart, i)
    if (value) tokens.push({ kind, value })
    state = 'ground'
    textStart = i
  }

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
        if (code === 0x3c || (code >= 0x30 && code <= 0x39) || code === 0x3b) {
          i++
          textStart = i
        } else if (code === 0x4d || code === 0x6d) {
          i++
          textStart = i
          state = 'ground'
        } else {
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
        if (
          x10Mouse &&
          code === 0x4d  &&
          i - seqStart === 2 &&
          (i + 1 >= data.length || data.charCodeAt(i + 1) >= 0x20) &&
          (i + 2 >= data.length || data.charCodeAt(i + 2) >= 0x20) &&
          (i + 3 >= data.length || data.charCodeAt(i + 3) >= 0x20)
        ) {
          if (i + 4 <= data.length) {
            i += 4
            emit('x10-mouse')
          } else {
            i = data.length
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

  if (state === 'ground') {
    flushText()
    return { tokens, state, carry: '' }
  }
  if (state === 'resync') {
    return { tokens, state, carry: '' }
  }
  const remaining = data.slice(seqStart)
  if (!flush) {
    return { tokens, state, carry: remaining }
  }
  if (remaining && isPartialMouseHead(remaining, x10Mouse)) {
    const next: ScanState = /^\x1b\[<?[\d;]*$/.test(remaining) ? 'resync' : 'ground'
    return { tokens, state: next, carry: '' }
  }
  if (remaining && (state === 'osc' || state === 'dcs' || state === 'apc')) {
    if (remaining.length <= 2) {
      tokens.push({ kind: 'esc', value: remaining })
      return { tokens, state: 'ground', carry: '' }
    }
    if (policy.sealedFlushes === 0) return { tokens, state, carry: remaining, sealed: true }
    if (!policy.fedSinceFlush) return { tokens, state, carry: '', sealed: true }
    return { tokens, state: 'ground', carry: '' }
  }
  if (remaining && state === 'csi' && policy.sealedFlushes === 0 && isResponseHead(remaining)) {
    return { tokens, state, carry: remaining, sealed: true }
  }
  if (remaining === DOUBLE_ESC) {
    tokens.push({ kind: 'esc', value: ESC }, { kind: 'esc', value: ESC })
    return { tokens, state: 'ground', carry: '' }
  }
  if (remaining) {
    tokens.push({ kind: seqKind, value: remaining })
  }
  return { tokens, state: 'ground', carry: '' }
}
