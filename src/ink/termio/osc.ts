// OSC generation and parsing, multiplexer passthrough, hyperlinks, the tab
// status vocabulary, and the tiered best-effort clipboard delivery whose
// receipt says what actually happened.

import { env } from '../../utils/env.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { BEL, ESC, SEP } from './ansi.js'
import type { Action, Color, TabStatusAction } from './display-types.js'

export const OSC_PREFIX = `${ESC}]`
/** The string terminator. */
export const ST = `${ESC}\\`

/** Kitty beeps on a BEL-terminated OSC. */
function terminator(): string {
  return env.terminal === 'kitty' ? ST : BEL
}

/** `ESC ] <parts joined by ';'> <terminator>`. */
export function osc(...parts: (string | number)[]): string {
  return `${OSC_PREFIX}${parts.join(SEP)}${terminator()}`
}

/**
 * Wrap a sequence for multiplexer passthrough: tmux DCS with every ESC
 * doubled, GNU screen's bare DCS, else unchanged. A bare BEL must never be
 * wrapped (tmux would lose its own bell action), and the user's tmux
 * options are never mutated — a dropped passthrough is no worse than an
 * unwrapped OSC.
 */
export function wrapForMultiplexer(sequence: string): string {
  if (process.env.TMUX) {
    return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`
  }
  if (process.env.STY) {
    return `${ESC}P${sequence}${ESC}\\`
  }
  return sequence
}

// ── command numbers ────────────────────────────────────────────────────────

export const OSC = {
  SET_TITLE_AND_ICON: 0,
  SET_ICON: 1,
  SET_TITLE: 2,
  SET_COLOR: 4,
  SET_CWD: 7,
  HYPERLINK: 8,
  ITERM2: 9,
  SET_FG: 10,
  SET_BG: 11,
  SET_CURSOR_COLOR: 12,
  CLIPBOARD: 52,
  KITTY: 99,
  RESET_COLOR: 104,
  RESET_FG: 110,
  RESET_BG: 111,
  RESET_CURSOR_COLOR: 112,
  SEMANTIC_PROMPT: 133,
  GHOSTTY: 777,
  TAB_STATUS: 21337,
} as const

/** iTerm2 OSC 9 subcommands. */
export const ITERM2 = {
  NOTIFY: 0,
  BADGE: 2,
  PROGRESS: 4,
} as const

/** iTerm2 progress operations. */
export const PROGRESS = {
  CLEAR: 0,
  SET: 1,
  ERROR: 2,
  INDETERMINATE: 3,
} as const

// Exit-path cleanups are always BEL-terminated: terminal detection may no
// longer be trustworthy there.
export const CLEAR_ITERM2_PROGRESS = `${OSC_PREFIX}${OSC.ITERM2};${ITERM2.PROGRESS};${PROGRESS.CLEAR};${BEL}`
export const CLEAR_TERMINAL_TITLE = `${OSC_PREFIX}${OSC.SET_TITLE_AND_ICON};${BEL}`

// ── clipboard ──────────────────────────────────────────────────────────────

export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52'

/** Which route a copy WILL take — synchronous, so a toast can be truthful
 *  without awaiting. SSH_CONNECTION (never SSH_TTY): tmux refreshes it on
 *  attach, so a locally re-attached pane correctly reads as local. */
export function getClipboardPath(): ClipboardPath {
  if (process.platform === 'darwin' && !process.env.SSH_CONNECTION) return 'native'
  if (process.env.TMUX) return 'tmux-buffer'
  return 'osc52'
}

const SUBPROCESS_TIMEOUT_MS = 2000

/** `tmux load-buffer` from stdin; false when not under tmux. `-w` propagates
 *  to the outer terminal's clipboard on tmux ≥3.2 — except under iTerm2,
 *  whose handling of tmux's own OSC 52 crashes over SSH. */
export async function tmuxLoadBuffer(text: string): Promise<boolean> {
  if (!process.env.TMUX) return false
  const args = process.env.LC_TERMINAL === 'iTerm2' ? ['load-buffer', '-'] : ['load-buffer', '-w', '-']
  const result = await execFileNoThrow('tmux', args, {
    useCwd: false,
    timeout: SUBPROCESS_TIMEOUT_MS,
    input: text,
  })
  return result.code === 0
}

/** UTF-16LE with a byte-order mark: the one encoding the console-less
 *  Windows clip child decodes unconditionally. */
export function windowsClipInput(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

type NativeRoute = 'pbcopy' | 'wl-copy' | 'xclip' | 'xsel' | 'clip.exe'

const LINUX_TOOLS: ReadonlyArray<{ route: NativeRoute; file: string; args: string[] }> = [
  { route: 'wl-copy', file: 'wl-copy', args: [] },
  { route: 'xclip', file: 'xclip', args: ['-selection', 'clipboard'] },
  { route: 'xsel', file: 'xsel', args: ['--clipboard', '--input'] },
]

// The first linux tool that works is cached and used alone afterwards; an
// all-fail first attempt caches "none".
let linuxTool: { route: NativeRoute; file: string; args: string[] } | null | undefined

async function runNative(
  file: string,
  args: string[],
  input: string | Buffer,
): Promise<boolean> {
  const result = await execFileNoThrow(file, args, {
    useCwd: false,
    timeout: SUBPROCESS_TIMEOUT_MS,
    input,
  })
  return result.code === 0
}

/** The platform's native clipboard utility; the settled route name, or
 *  null when nothing settled. Failures are silent. */
async function copyNative(text: string): Promise<NativeRoute | null> {
  try {
    switch (process.platform) {
      case 'darwin':
        return (await runNative('pbcopy', [], text)) ? 'pbcopy' : null
      case 'linux': {
        if (linuxTool === null) return null
        if (linuxTool) {
          return (await runNative(linuxTool.file, linuxTool.args, text)) ? linuxTool.route : null
        }
        for (const tool of LINUX_TOOLS) {
          if (await runNative(tool.file, tool.args, text)) {
            linuxTool = tool
            return tool.route
          }
        }
        linuxTool = null
        return null
      }
      case 'win32': {
        const ok = await execFileNoThrow('clip', [], {
          useCwd: false,
          timeout: SUBPROCESS_TIMEOUT_MS,
          input: windowsClipInput(text),
        })
        return ok.code === 0 ? 'clip.exe' : null
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

export interface ClipboardReceipt {
  /** The sequence the caller must write to stdout. */
  sequence: string
  /** Routes that settled with a POSITIVE completion fact. */
  settled: Array<'pbcopy' | 'wl-copy' | 'xclip' | 'xsel' | 'clip.exe' | 'tmux-buffer'>
  osc52Emitted: boolean
  /** The honest confirmation for the UI. */
  confirmation: string
}

/** Settlement listeners (C1 clipboard honesty): a fire-and-forget copy road
 *  (the ink selection layer discards its promise by contract) can still be
 *  toasted truthfully — a surface arms a one-shot listener beside its
 *  predicted toast and corrects the words if the copy settles worse than
 *  predicted. Every setClipboardWithReceipt settlement publishes here. */
type ClipboardReceiptListener = (receipt: ClipboardReceipt) => void
const receiptListeners = new Set<ClipboardReceiptListener>()
export function subscribeClipboardReceipts(listener: ClipboardReceiptListener): () => void {
  receiptListeners.add(listener)
  return () => {
    receiptListeners.delete(listener)
  }
}

export async function setClipboardWithReceipt(text: string): Promise<ClipboardReceipt> {
  const base64 = Buffer.from(text, 'utf8').toString('base64')
  const rawSequence = osc(OSC.CLIPBOARD, 'c', base64)

  // The native copy starts FIRST — after the tmux round-trip it lost races
  // against a fast switch-away-and-paste.
  const nativePromise = process.env.SSH_CONNECTION
    ? Promise.resolve<NativeRoute | null>(null)
    : copyNative(text)
  const tmuxBufferLoaded = await tmuxLoadBuffer(text)
  const nativeRoute = await nativePromise

  const settled: ClipboardReceipt['settled'] = []
  if (nativeRoute) settled.push(nativeRoute)
  if (tmuxBufferLoaded) settled.push('tmux-buffer')

  // Inside the tmux DCS envelope the inner terminator must be BEL: ST
  // carries an ESC that would itself need doubling.
  const sequence = tmuxBufferLoaded
    ? wrapForMultiplexer(`${OSC_PREFIX}${OSC.CLIPBOARD};c;${base64}${BEL}`)
    : rawSequence

  // OSC 52 emission is an offer, not a delivery — the terminal decides.
  const confirmation =
    settled.length > 0
      ? `copied (${settled.join(' + ')})`
      : 'offered to the terminal via OSC 52 — delivery depends on your terminal'

  const receipt: ClipboardReceipt = { sequence, settled, osc52Emitted: true, confirmation }
  for (const listener of [...receiptListeners]) {
    try {
      listener(receipt)
    } catch {
      // A listener must never break a copy.
    }
  }
  return receipt
}

/** The sequence the caller must write. */
export async function setClipboard(text: string): Promise<string> {
  return (await setClipboardWithReceipt(text)).sequence
}

// ── parsing ────────────────────────────────────────────────────────────────

/** XParseColor: `#RRGGBB` or `rgb:R/G/B` with 1–4 hex digits per component,
 *  each scaled from its own precision to 8 bits. */
export function parseOscColor(spec: string): Color | null {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(spec)
  if (hex) {
    const value = hex[1]!
    return {
      type: 'rgb',
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    }
  }
  const rgb = /^rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})$/.exec(spec)
  if (rgb) {
    const scale = (component: string): number =>
      Math.round((parseInt(component, 16) / (16 ** component.length - 1)) * 255)
    return { type: 'rgb', r: scale(rgb[1]!), g: scale(rgb[2]!), b: scale(rgb[3]!) }
  }
  return null
}

/** `key=value` pairs separated by `;` with `\;` and `\\` escapes honoured
 *  on whichever side of the `=` is being accumulated. */
function parseTabStatusPayload(data: string): TabStatusAction {
  const action: TabStatusAction = {}
  let key = ''
  let value = ''
  let inValue = false
  const commit = (): void => {
    if (key === '' && !inValue) return
    const cleared = !inValue || value === ''
    if (key === 'indicator') action.indicator = cleared ? null : parseOscColor(value)
    else if (key === 'status') action.status = cleared ? null : value
    else if (key === 'status-color') action.statusColor = cleared ? null : parseOscColor(value)
    key = ''
    value = ''
    inValue = false
  }
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!
    if (ch === '\\' && i + 1 < data.length) {
      const next = data[i + 1]!
      if (next === ';' || next === '\\') {
        if (inValue) value += next
        else key += next
        i++
        continue
      }
    }
    if (ch === ';') {
      commit()
      continue
    }
    if (ch === '=' && !inValue) {
      inValue = true
      continue
    }
    if (inValue) value += ch
    else key += ch
  }
  commit()
  return action
}

/** Parse OSC content (introducer and terminator already stripped). */
export function parseOSC(content: string): Action | null {
  const separator = content.indexOf(';')
  const command = separator === -1 ? content : content.slice(0, separator)
  const data = separator === -1 ? '' : content.slice(separator + 1)
  switch (Number(command)) {
    case OSC.SET_TITLE_AND_ICON:
      return { type: 'title', action: { type: 'both', title: data } }
    case OSC.SET_ICON:
      return { type: 'title', action: { type: 'iconName', name: data } }
    case OSC.SET_TITLE:
      return { type: 'title', action: { type: 'windowTitle', title: data } }
    case OSC.HYPERLINK: {
      const fields = data.split(';')
      const paramString = fields[0] ?? ''
      const url = fields.slice(1).join(';')
      if (url === '') return { type: 'link', action: { type: 'end' } }
      const params: Record<string, string> = {}
      let count = 0
      for (const pair of paramString.split(':')) {
        const eq = pair.indexOf('=')
        if (eq === -1) continue
        params[pair.slice(0, eq)] = pair.slice(eq + 1)
        count++
      }
      return {
        type: 'link',
        action: { type: 'start', url, params: count > 0 ? params : undefined },
      }
    }
    case OSC.TAB_STATUS:
      return { type: 'tabStatus', action: parseTabStatusPayload(data) }
    default:
      return { type: 'unknown', sequence: `${OSC_PREFIX}${content}` }
  }
}

// ── hyperlinks ─────────────────────────────────────────────────────────────

/** A stable, collision-tolerant id so every wrapped line of one link joins
 *  into one hover target (OSC 8 joins cells only when URI AND id match). */
function linkId(url: string): string {
  let hash = 2166136261
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(36)
}

export function link(url: string, params?: Record<string, string>): string {
  if (url === '') return LINK_END
  const merged: Record<string, string> = { id: linkId(url), ...params }
  const paramString = Object.entries(merged)
    .map(([key, value]) => `${key}=${value}`)
    .join(':')
  return osc(OSC.HYPERLINK, paramString, url)
}

export const LINK_END = osc(OSC.HYPERLINK, '', '')

// ── tab status ─────────────────────────────────────────────────────────────

/** All three fields cleared; the usual terminal-dependent terminator. */
export const CLEAR_TAB_STATUS = osc(OSC.TAB_STATUS, 'indicator=;status=;status-color=')

/** The emission gate: the extension's specification is considered unstable,
 *  so tab-status sequences are never emitted. A policy choice, not a safety
 *  one — terminals discard the sequence silently. */
export function supportsTabStatus(): boolean {
  return false
}
