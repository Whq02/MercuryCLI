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
  feed(data: string): ScanToken[]
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
  if (head === ESC) return /^(?:\[[\x20-\x7e]|\]\d|P>|P[01]\$)/.test(s)
  if (head === ESC + ']') return /^\d/.test(s)
  if (head === ESC + 'P') return /^(?:>|[01]\$)/.test(s)
  if (!head.startsWith(CSI_HEAD) || s === '') return false
  const code = s.charCodeAt(0)
  return x10Mouse && isX10Head(head) ? code >= 0x20 && code !== 0x7f : isCsiByte(code)
}

const REPLY_STRING_HEAD = /^\x1b(?:\]\d+(?:;|$)|P>(?:\||$)|P[01]\$(?:r|$))/

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

type ScanResult = {
  tokens: ScanToken[]
  state: ScanState
  carry: string
  sealed?: boolean
  flushedHead?: string
  terminatorOwed?: boolean
  heldRun?: boolean
}

function probeX10Payload(
  data: string,
  payloadStart: number,
  heldRun: boolean,
): { kind: 'complete' } | { kind: 'wait' } | { kind: 'bad'; at: number } {
  const avail = Math.min(3, data.length - payloadStart)
  for (let k = 0; k < avail; k++) {
    const b = data.charCodeAt(payloadStart + k)
    if (b < 0x20 || (heldRun && b === C0.DEL)) return { kind: 'bad', at: payloadStart + k }
  }
  return avail < 3 ? { kind: 'wait' } : { kind: 'complete' }
}

function flushPending(
  state: ScanState,
  carried: string,
  x10Mouse: boolean,
  policy: FlushPolicy,
  interruptedFlushedHead: string,
  tokens: ScanToken[],
  emit: (kind: TokenKind, value: string) => void,
  getTerminatorOwed: () => boolean,
): ScanResult {
  const isStringState = STRING_INTRODUCER[state] !== undefined

  if (isStringState && carried.length > 0) {
    if (carried.length <= 2) {
      emit('esc', carried)
      return { tokens, state: 'ground', carry: '', flushedHead: carried, terminatorOwed: getTerminatorOwed() }
    }
    const replyProbe = carried.endsWith(ESC) ? carried.slice(0, -1) : carried
    if (policy.stringReplyOwed || isReplyStringHead(replyProbe)) {
      return { tokens, state, carry: carried, terminatorOwed: getTerminatorOwed() }
    }
    if (policy.sealedFlushes === 0) {
      return { tokens, state, carry: carried, sealed: true, terminatorOwed: getTerminatorOwed() }
    }
    if (!policy.fedSinceFlush) {
      return { tokens, state, carry: '', sealed: true, terminatorOwed: getTerminatorOwed() }
    }
    return { tokens, state: 'ground', carry: '', terminatorOwed: getTerminatorOwed() }
  }

  if (state === 'csi' && x10Mouse) {
    if (policy.provisionalBracket && carried === CSI_HEAD) {
      emit('text', '[')
      return { tokens, state: 'ground', carry: '', terminatorOwed: getTerminatorOwed() }
    }
    if (policy.sealedFlushes < CSI_HOLD_FLUSHES) {
      return { tokens, state, carry: carried, sealed: true, heldRun: true, terminatorOwed: getTerminatorOwed() }
    }
    emit('csi', carried)
    return { tokens, state: 'ground', carry: '', flushedHead: carried, terminatorOwed: getTerminatorOwed() }
  }

  if (carried === DOUBLE_ESC) {
    emit('esc', ESC)
    emit('esc', ESC)
    return { tokens, state: 'ground', carry: '', terminatorOwed: getTerminatorOwed() }
  }

  if (carried.length > 0) {
    const kind: TokenKind = KIND_OF_STATE[state] ?? 'esc'
    emit(kind, carried)
    const flushedHead = interruptedFlushedHead || (carried === ESC ? ESC : '')
    return { tokens, state: 'ground', carry: '', flushedHead, terminatorOwed: getTerminatorOwed() }
  }

  return { tokens, state: 'ground', carry: '', terminatorOwed: getTerminatorOwed() }
}

function scan(
  data: string,
  initial: ScanState,
  flush: boolean,
  x10Mouse: boolean,
  policy: FlushPolicy,
): ScanResult {
  const tokens: ScanToken[] = []
  let state: ScanState = 'ground'
  let seqStart = 0
  let headlessString = false
  let heldRun = policy.heldRun
  let terminatorOwed = policy.terminatorOwed
  let debtFromPolicy = policy.terminatorOwed
  let interruptedFlushedHead = ''

  const initialIntro = STRING_INTRODUCER[initial]
  if (
    initialIntro !== undefined &&
    !(data.length >= 2 && data.charCodeAt(0) === C0.ESC && data.charCodeAt(1) === initialIntro)
  ) {
    state = initial
    headlessString = true
  }

  const emit = (kind: TokenKind, value: string): void => {
    if (value.length === 0) return
    if (kind === 'esc' && value === '\x1b\\' && terminatorOwed) {
      terminatorOwed = false
      debtFromPolicy = false
      return
    }
    tokens.push({ kind, value })
    heldRun = false
    if (debtFromPolicy) {
      terminatorOwed = false
      debtFromPolicy = false
    }
  }

  let i = 0
  let headlessTrailingEsc = false
  while (i < data.length) {
    const code = data.charCodeAt(i)

    if (state === 'ground') {
      if (terminatorOwed) {
        if (code === C0.BEL) {
          terminatorOwed = false
          debtFromPolicy = false
          i++
          seqStart = i
          continue
        }
        if (code === C0.ESC && i + 1 < data.length && data.charCodeAt(i + 1) === ESC_TYPE.ST) {
          terminatorOwed = false
          debtFromPolicy = false
          i += 2
          seqStart = i
          continue
        }
      }
      if (code === C0.ESC) {
        if (i > seqStart) emit('text', data.slice(seqStart, i))
        seqStart = i
        state = 'escape'
        i++
        continue
      }
      i++
      continue
    }

    if (state === 'escape') {
      if (code === C0.ESC && i - seqStart === 1) {
        if (i + 1 === data.length) {
          i++
          break
        }
        const next = data.charCodeAt(i + 1)
        if (isMetaPrefixedIntroducer(next) && !isMouseReportHead(data, i + 1, x10Mouse)) {
          i++
          continue
        }
        emit('esc', ESC)
        seqStart = i
        i++
        continue
      }
      if (code === ESC_TYPE.CSI) {
        state = 'csi'
        i++
        continue
      }
      if (code === 0x4f) {
        state = 'ss3'
        i++
        continue
      }
      if (code === ESC_TYPE.OSC) {
        state = 'osc'
        i++
        continue
      }
      if (code === ESC_TYPE.DCS) {
        state = 'dcs'
        i++
        continue
      }
      if (code === ESC_TYPE.APC) {
        state = 'apc'
        i++
        continue
      }
      if (isCSIIntermediate(code)) {
        state = 'escapeIntermediate'
        i++
        continue
      }
      if (isEscFinal(code)) {
        emit('esc', data.slice(seqStart, i + 1))
        state = 'ground'
        i++
        seqStart = i
        continue
      }
      state = 'ground'
      continue
    }

    if (state === 'escapeIntermediate') {
      if (isCSIIntermediate(code)) {
        i++
        continue
      }
      if (isEscFinal(code)) {
        emit('esc', data.slice(seqStart, i + 1))
        state = 'ground'
        i++
        seqStart = i
        continue
      }
      state = 'ground'
      continue
    }

    if (state === 'ss3') {
      if (isCSIFinal(code)) {
        emit('ss3', data.slice(seqStart, i + 1))
        state = 'ground'
        i++
        seqStart = i
        continue
      }
      state = 'ground'
      continue
    }

    if (state === 'csi') {
      if (isCSIParam(code) || isCSIIntermediate(code)) {
        i++
        continue
      }
      if (isCSIFinal(code)) {
        if (x10Mouse && code === 0x4d && i - seqStart === 2) {
          const probe = probeX10Payload(data, i + 1, heldRun)
          if (probe.kind === 'bad') {
            if (heldRun) {
              heldRun = false
              state = 'ground'
              seqStart = probe.at
              i = probe.at
              continue
            }
            emit('csi', data.slice(seqStart, i + 1))
            state = 'ground'
            i++
            seqStart = i
            continue
          }
          if (probe.kind === 'wait') {
            i = data.length
            break
          }
          emit('x10-mouse', data.slice(seqStart, i + 4))
          state = 'ground'
          i += 4
          seqStart = i
          continue
        }
        if (heldRun && data.startsWith('\x1b[<', seqStart) && code !== 0x4d && code !== 0x6d) {
          heldRun = false
          state = 'ground'
          seqStart = i
          continue
        }
        emit('csi', data.slice(seqStart, i + 1))
        state = 'ground'
        i++
        seqStart = i
        continue
      }
      if (heldRun) {
        heldRun = false
        state = 'ground'
        seqStart = i
        continue
      }
      state = 'ground'
      continue
    }

    if (code === C0.BEL) {
      if (!headlessString) emit(KIND_OF_STATE[state]!, data.slice(seqStart, i + 1))
      headlessString = false
      state = 'ground'
      i++
      seqStart = i
      continue
    }

    if (code === C0.ESC) {
      if (i + 1 < data.length && data.charCodeAt(i + 1) === ESC_TYPE.ST) {
        if (!headlessString) emit(KIND_OF_STATE[state]!, data.slice(seqStart, i + 2))
        headlessString = false
        state = 'ground'
        i += 2
        seqStart = i
        continue
      }
      if (i + 1 === data.length) {
        const shouldWait =
          !flush ||
          (x10Mouse &&
            !headlessString &&
            isReplyStringHead(data.slice(seqStart, i)) &&
            !policy.escapeAlone)
        if (shouldWait) {
          if (headlessString) headlessTrailingEsc = true
          break
        }
      }
      if (!headlessString) {
        const run = data.slice(seqStart, i)
        if (isReplyStringHead(run)) {
          terminatorOwed = true
          debtFromPolicy = false
          if (flush && i === data.length - 1) {
            interruptedFlushedHead = data.slice(seqStart, i + 1)
          }
        }
      }
      headlessString = false
      state = 'ground'
      seqStart = i
      continue
    }

    if (isStringBodyByte(code)) {
      i++
      continue
    }

    if (!headlessString) {
      const run = data.slice(seqStart, i)
      if (isReplyStringHead(run)) {
        terminatorOwed = true
        debtFromPolicy = false
      }
    }
    headlessString = false
    state = 'ground'
    seqStart = i
  }

  if (state === 'ground') {
    if (i > seqStart) emit('text', data.slice(seqStart, i))
    return { tokens, state: 'ground', carry: '', terminatorOwed }
  }

  if (!flush) {
    const carry = headlessString ? (headlessTrailingEsc ? ESC : '') : data.slice(seqStart)
    return { tokens, state, carry, terminatorOwed, heldRun }
  }

  const carried = headlessString ? '' : data.slice(seqStart)
  return flushPending(
    state,
    carried,
    x10Mouse,
    policy,
    interruptedFlushedHead,
    tokens,
    emit,
    () => terminatorOwed,
  )
}
