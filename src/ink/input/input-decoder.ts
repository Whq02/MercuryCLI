import { Buffer } from 'buffer'
import { isLegacyWindowsConsole } from '../../utils/platform/terminal.js'
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
import { hostEnv } from '../../utils/hostEnv.js'


export type KeyParseState = {
  mode: 'NORMAL' | 'IN_PASTE'
  incomplete: string
  pasteBuffer: string
  pendingBytes?: Buffer
  heldCR?: boolean
  _scanner?: Scanner
  stringReplyOwed?: () => boolean
}

export const INITIAL_STATE: KeyParseState = {
  mode: 'NORMAL',
  incomplete: '',
  pasteBuffer: '',
}

let burstCrHostOverride: boolean | null = null

export function __setBurstCrHostForTest(v: boolean | null): void {
  burstCrHostOverride = v
}

export function burstCrIsLineBreak(
  platform: string = process.platform,
  env: Record<string, string | undefined> = hostEnv(),
): boolean {
  if (burstCrHostOverride !== null) return burstCrHostOverride
  return isLegacyWindowsConsole(env, platform)
}

function splitTextRuns(text: string): string[] {
  if (text.length === 0) return []
  if (text.length === 1 || text.charCodeAt(0) === 0x1b) return [text]
  const multiline = text.length > 1 && text.includes('\n')
  const runs: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const isSeparateControl =
      (code < 0x20 || code === 0x7f) &&
      code !== 0x0a &&
      !(multiline && code === 0x09)
    if (isSeparateControl) {
      if (i > start) runs.push(text.slice(start, i))
      runs.push(text[i]!)
      start = i + 1
    }
  }
  if (start < text.length) runs.push(text.slice(start))
  return runs
}

export function parseMultipleKeypresses(
  prevState: KeyParseState,
  input?: Buffer | string | null,
): [ParsedInput[], KeyParseState] {
  const isFlush = input === null
  const normalizedInput: Buffer | string | null = input === undefined ? '' : input
  const { text, pending } = decodeChunk(prevState.pendingBytes, normalizedInput)
  const scanner =
    prevState._scanner ??
    createScanner({ x10Mouse: true, stringReplyOwed: prevState.stringReplyOwed })

  let tokens: ScanToken[]
  if (isFlush) {
    tokens = text.length > 0 ? [...scanner.feed(text), ...scanner.flush()] : scanner.flush()
  } else {
    tokens = scanner.feed(text)
  }

  const results: ParsedInput[] = []
  let mode: 'NORMAL' | 'IN_PASTE' = prevState.mode
  let pasteBuffer = prevState.pasteBuffer
  let heldCR = false

  if (prevState.heldCR) {
    const first = tokens[0]
    const completedByLf =
      mode === 'NORMAL' &&
      first !== undefined &&
      first.kind === 'text' &&
      first.value.startsWith('\n')
    if (!completedByLf) {
      results.push(interpretKey('\r'))
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (mode === 'IN_PASTE') {
      if (token.value === PASTE_END) {
        results.push(createPasteKey(pasteBuffer))
        pasteBuffer = ''
        mode = 'NORMAL'
      } else {
        pasteBuffer += token.value
      }
      continue
    }

    if (token.value === PASTE_START) {
      mode = 'IN_PASTE'
      pasteBuffer = ''
      continue
    }

    if (token.value === PASTE_END) {
      continue
    }

    if (token.kind !== 'text') {
      const response = interpretResponse(token.value)
      if (response !== null) {
        results.push({
          kind: 'response',
          sequence: token.value,
          response,
        })
        continue
      }
      const mouse = interpretMouse(token.value)
      if (mouse !== null) {
        results.push(mouse)
        continue
      }
      results.push(interpretKey(token.value))
      continue
    }

    if (hasOrphanMouseBytes(token.value)) {
      extractOrphanMouseEvents(token.value, results)
      continue
    }

    let chunk = token.value.replace(/\r\n/g, '\n')
    if (burstCrIsLineBreak()) {
      chunk = chunk.replace(/\r(?=[^\r\n])/g, '\n')
    }
    if (
      !isFlush &&
      i === tokens.length - 1 &&
      chunk.length >= 2 &&
      chunk.charCodeAt(chunk.length - 1) === 0x0d &&
      isPlainChar(chunk.charCodeAt(chunk.length - 2))
    ) {
      chunk = chunk.slice(0, -1)
      heldCR = true
    }

    for (const run of splitTextRuns(chunk)) {
      results.push(interpretKey(run))
    }
  }

  if (isFlush && mode === 'IN_PASTE') {
    results.push(createPasteKey(pasteBuffer))
    pasteBuffer = ''
    mode = 'NORMAL'
  }

  const nextState: KeyParseState = {
    mode,
    incomplete: scanner.buffer(),
    pasteBuffer,
    pendingBytes: pending,
    heldCR,
    _scanner: scanner,
    stringReplyOwed: prevState.stringReplyOwed,
  }

  return [results, nextState]
}

function isPlainChar(c: number): boolean {
  return c >= 0x20 && c !== 0x7f
}

export {
  DECRPM_STATUS,
  nonAlphanumericKeys,
  type ParsedInput,
  type ParsedKey,
  type ParsedMouse,
  type ParsedResponse,
  type TerminalResponse,
} from './interpreter.js'
