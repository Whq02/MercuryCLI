
import { env } from '../../utils/env.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { BEL, ESC, SEP } from './ansi.js'
import type { Action, Color, TabStatusAction } from './display-types.js'

export const OSC_PREFIX = `${ESC}]`
export const ST = `${ESC}\\`

function terminator(): string {
  return env.terminal === 'kitty' ? ST : BEL
}

export function osc(...parts: (string | number)[]): string {
  return `${OSC_PREFIX}${parts.join(SEP)}${terminator()}`
}

export function wrapForMultiplexer(sequence: string): string {
  if (process.env.TMUX) {
    return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`
  }
  if (process.env.STY) {
    return `${ESC}P${sequence}${ESC}\\`
  }
  return sequence
}


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

export const ITERM2 = {
  NOTIFY: 0,
  BADGE: 2,
  PROGRESS: 4,
} as const

export const PROGRESS = {
  CLEAR: 0,
  SET: 1,
  ERROR: 2,
  INDETERMINATE: 3,
} as const

export const CLEAR_ITERM2_PROGRESS = `${OSC_PREFIX}${OSC.ITERM2};${ITERM2.PROGRESS};${PROGRESS.CLEAR};${BEL}`
export const CLEAR_TERMINAL_TITLE = `${OSC_PREFIX}${OSC.SET_TITLE_AND_ICON};${BEL}`


export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52'

export function getClipboardPath(): ClipboardPath {
  if (process.platform === 'darwin' && !process.env.SSH_CONNECTION) return 'native'
  if (process.env.TMUX) return 'tmux-buffer'
  return 'osc52'
}

const SUBPROCESS_TIMEOUT_MS = 2000

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

export function windowsClipInput(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

type NativeRoute = 'pbcopy' | 'wl-copy' | 'xclip' | 'xsel' | 'clip.exe'

const LINUX_TOOLS: ReadonlyArray<{ route: NativeRoute; file: string; args: string[] }> = [
  { route: 'wl-copy', file: 'wl-copy', args: [] },
  { route: 'xclip', file: 'xclip', args: ['-selection', 'clipboard'] },
  { route: 'xsel', file: 'xsel', args: ['--clipboard', '--input'] },
]

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
  sequence: string
  settled: Array<'pbcopy' | 'wl-copy' | 'xclip' | 'xsel' | 'clip.exe' | 'tmux-buffer'>
  osc52Emitted: boolean
  confirmation: string
}

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

  const nativePromise = process.env.SSH_CONNECTION
    ? Promise.resolve<NativeRoute | null>(null)
    : copyNative(text)
  const tmuxBufferLoaded = await tmuxLoadBuffer(text)
  const nativeRoute = await nativePromise

  const settled: ClipboardReceipt['settled'] = []
  if (nativeRoute) settled.push(nativeRoute)
  if (tmuxBufferLoaded) settled.push('tmux-buffer')

  const sequence = tmuxBufferLoaded
    ? wrapForMultiplexer(`${OSC_PREFIX}${OSC.CLIPBOARD};c;${base64}${BEL}`)
    : rawSequence

  const confirmation =
    settled.length > 0
      ? `copied (${settled.join(' + ')})`
      : 'offered to the terminal via OSC 52 — delivery depends on your terminal'

  const receipt: ClipboardReceipt = { sequence, settled, osc52Emitted: true, confirmation }
  for (const listener of [...receiptListeners]) {
    try {
      listener(receipt)
    } catch {
    }
  }
  return receipt
}

export async function setClipboard(text: string): Promise<string> {
  return (await setClipboardWithReceipt(text)).sequence
}


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


export const CLEAR_TAB_STATUS = osc(OSC.TAB_STATUS, 'indicator=;status=;status-color=')

export function supportsTabStatus(): boolean {
  return false
}
