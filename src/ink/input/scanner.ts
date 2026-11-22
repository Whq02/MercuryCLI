import { C0, ESC, ESC_TYPE, isEscFinal } from '../termio/ansi.js'
import { isCSIFinal, isCSIIntermediate, isCSIParam } from '../termio/csi.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


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

type ScannerOptions = Unbuilt

export type Scanner = Unbuilt

const KIND_OF_STATE: Partial<Record<ScanState, TokenKind>> = {
  csi: 'csi',
  ss3: 'ss3',
  osc: 'osc',
  dcs: 'dcs',
  apc: 'apc',
}

export function createScanner(options?: ScannerOptions): Scanner {
  return notBuilt('src/ink/input/scanner.ts:47')
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
  return notBuilt('src/ink/input/scanner.ts:167')
}
