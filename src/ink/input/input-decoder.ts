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


export type KeyParseState = {
  mode: 'NORMAL' | 'IN_PASTE'
  incomplete: string
  pasteBuffer: string
  pendingBytes?: Buffer
  heldCR?: boolean
  _scanner?: Scanner
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
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (burstCrHostOverride !== null) return burstCrHostOverride
  return platform === 'win32' && !isModernWindowsTerminal(env, platform)
}

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

  const tokens: ScanToken[] = isFlush
    ? [...(text ? scanner.feed(text) : []), ...scanner.flush()]
    : scanner.feed(text)

  const atoms: ParsedInput[] = []
  let inPaste = prevState.mode === 'IN_PASTE'
  let pasteBuffer = prevState.pasteBuffer

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
