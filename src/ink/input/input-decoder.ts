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
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


export type KeyParseState = Unbuilt

export const INITIAL_STATE: KeyParseState = unbuilt('src/ink/input/input-decoder.ts:32')

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

export function parseMultipleKeypresses(
  prevState: KeyParseState,
  input?: Buffer | string | null,
): [ParsedInput[], KeyParseState] {
  return notBuilt('src/ink/input/input-decoder.ts:72')
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
