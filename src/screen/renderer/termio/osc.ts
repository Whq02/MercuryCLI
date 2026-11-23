import { CLIPBOARD_FILE_ROUTE, writeClipboardFile } from './clipboardFile.js'
import { env } from '../../../platform/environment/env.js'
import { execFileNoThrow } from '../../../platform/processes/execFileNoThrow.js'
import { BEL, ESC, SEP } from './ansi.js'
import type { Action, Color, TabStatusAction } from './display-types.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

const OSC_PREFIX = `${ESC}]`
const ST = `${ESC}\\`

function terminator(): string {
  return env.terminal === 'kitty' ? ST : BEL
}

export function osc(...parts: (string | number)[]): string {
  return `${OSC_PREFIX}${parts.join(SEP)}${terminator()}`
}

export function wrapForMultiplexer(sequence: string): string {
  if (hostEnv().TMUX) return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ST}`
  if (hostEnv().STY) return `${ESC}P${sequence}${ST}`
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

const belTerminated = (...parts: (string | number)[]): string => `${OSC_PREFIX}${parts.join(SEP)}${BEL}`
export const CLEAR_ITERM2_PROGRESS = belTerminated(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.CLEAR, '')
export const CLEAR_TERMINAL_TITLE = belTerminated(OSC.SET_TITLE_AND_ICON, '')


type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52'

export function getClipboardPath(): ClipboardPath {
  if (process.platform === 'darwin' && !hostEnv().SSH_CONNECTION) return 'native'
  if (hostEnv().TMUX) return 'tmux-buffer'
  return 'osc52'
}

type CopyReceipt = { text: string; detail?: string }

const COPY_RECEIPT = 'Copied to clipboard'
const ESCAPE_TRANSFER_DETAIL = "check the terminal's clipboard settings if pasting fails"

export function copyReceipt(path: ClipboardPath | 'unsettled'): CopyReceipt {
  switch (path) {
    case 'native':
      return { text: COPY_RECEIPT }
    case 'tmux-buffer':
      return { text: `${COPY_RECEIPT} via tmux`, detail: 'paste with the prefix chord then ]' }
    case 'osc52':
      return { text: `${COPY_RECEIPT} via terminal escape`, detail: ESCAPE_TRANSFER_DETAIL }
    case 'unsettled':
      return { text: 'Copy did not settle — offered via terminal escape instead', detail: ESCAPE_TRANSFER_DETAIL }
  }
}

const SUBPROCESS_TIMEOUT_MS = 2000

async function tmuxLoadBuffer(text: string): Promise<boolean> {
  if (!hostEnv().TMUX) return false
  const args = hostEnv().LC_TERMINAL === 'iTerm2' ? ['load-buffer', '-'] : ['load-buffer', '-w', '-']
  const result = await execFileNoThrow('tmux', args, {
    useCwd: false,
    timeout: SUBPROCESS_TIMEOUT_MS,
    input: text,
  })
  return result.code === 0
}

export function windowsClipInput(text: string): Buffer {
  return Buffer.from(text, 'utf16le')
}

export function windowsPowershellInput(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

export function windowsPowershellEnv(base: NodeJS.ProcessEnv = hostEnv()): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(base)) if (key.toUpperCase() === 'PSMODULEPATH') overrides[key] = undefined
  return overrides
}

const POWERSHELL_TIMEOUT_MS = 5000

type NativeRoute = 'pbcopy' | 'wl-copy' | 'xclip' | 'xsel' | 'clip.exe' | 'powershell'

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
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const result = await execFileNoThrow(file, args, {
    useCwd: false,
    timeout: SUBPROCESS_TIMEOUT_MS,
    input,
    ...(env !== undefined ? { env } : {}),
  })
  return result.code === 0
}

export function pbcopyLocaleEnv(env: NodeJS.ProcessEnv = hostEnv()): NodeJS.ProcessEnv | undefined {
  const effective = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
  return /utf-?8/i.test(effective) ? undefined : { LC_ALL: 'en_US.UTF-8' }
}

export const SET_CLIPBOARD_SCRIPT =
  '$stdin = [Console]::OpenStandardInput(); $bytes = New-Object System.IO.MemoryStream; $stdin.CopyTo($bytes); Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString($bytes.ToArray()))'

async function copyNative(text: string): Promise<NativeRoute | null> {
  try {
    switch (process.platform) {
      case 'darwin':
        return (await runNative('pbcopy', [], text, pbcopyLocaleEnv())) ? 'pbcopy' : null
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
        const set = await execFileNoThrow('powershell', ['-NoProfile', '-NonInteractive', '-Command', SET_CLIPBOARD_SCRIPT], {
          useCwd: false,
          timeout: POWERSHELL_TIMEOUT_MS,
          input: windowsPowershellInput(text),
          env: windowsPowershellEnv(),
        })
        if (set.code === 0) return 'powershell'
        const clip = await execFileNoThrow('clip', [], {
          useCwd: false,
          timeout: SUBPROCESS_TIMEOUT_MS,
          input: windowsClipInput(text),
        })
        return clip.code === 0 ? 'clip.exe' : null
      }
      default:
        return null
    }
  } catch (error) {
    passedOver(error)
    return null
  }
}

const TERMINALS_WITHOUT_OSC52: ReadonlySet<string> = new Set(['Apple_Terminal'])

export function terminalDropsOsc52(env: NodeJS.ProcessEnv = hostEnv()): boolean {
  return TERMINALS_WITHOUT_OSC52.has(env.TERM_PROGRAM ?? '')
}

export interface ClipboardReceipt {
  sequence: string
  settled: Array<NativeRoute | 'tmux-buffer' | typeof CLIPBOARD_FILE_ROUTE>
  osc52Emitted: boolean
  noRoad: boolean
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

function publishClipboardReceipt(receipt: ClipboardReceipt): ClipboardReceipt {
  for (const listener of [...receiptListeners]) {
    try {
      listener(receipt)
    } catch (error) {
      passedOver(error)
    }
  }
  return receipt
}

async function copyByRoads(text: string): Promise<ClipboardReceipt> {
  const written = writeClipboardFile(text)
  if (written !== null) {
    const failed = written === 'failed'
    return {
      sequence: '',
      settled: failed ? [] : [CLIPBOARD_FILE_ROUTE],
      osc52Emitted: false,
      noRoad: failed,
      confirmation: failed ? 'the clipboard file could not be written' : `copied (${CLIPBOARD_FILE_ROUTE})`,
    }
  }
  const native = hostEnv().SSH_CONNECTION ? null : copyNative(text)
  const tmuxLoaded = await tmuxLoadBuffer(text)
  const nativeRoute = await native
  const settled: ClipboardReceipt['settled'] = []
  if (nativeRoute) settled.push(nativeRoute)
  if (tmuxLoaded) settled.push('tmux-buffer')
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  return {
    sequence: tmuxLoaded ? wrapForMultiplexer(belTerminated(OSC.CLIPBOARD, 'c', encoded)) : osc(OSC.CLIPBOARD, 'c', encoded),
    settled,
    osc52Emitted: true,
    noRoad: settled.length === 0 && terminalDropsOsc52(),
    confirmation: settled.length > 0 ? `copied (${settled.join(' + ')})` : 'offered to the terminal via OSC 52 — delivery depends on your terminal',
  }
}

export async function setClipboardWithReceipt(text: string): Promise<ClipboardReceipt> {
  return publishClipboardReceipt(await copyByRoads(text))
}

export async function setClipboard(text: string): Promise<string> {
  return (await setClipboardWithReceipt(text)).sequence
}


function scaledComponent(field: string): number {
  return Math.round((Number.parseInt(field, 16) / (16 ** field.length - 1)) * 255)
}

export function parseOscColor(spec: string): Color | null {
  const fields =
    /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(spec) ??
    /^rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})$/.exec(spec)
  if (!fields) return null
  return { type: 'rgb', r: scaledComponent(fields[1]!), g: scaledComponent(fields[2]!), b: scaledComponent(fields[3]!) }
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

function linkParams(field: string): Record<string, string> | undefined {
  const params: Record<string, string> = {}
  for (const pair of field.split(':')) {
    const equals = pair.indexOf('=')
    if (equals !== -1) params[pair.slice(0, equals)] = pair.slice(equals + 1)
  }
  return Object.keys(params).length > 0 ? params : undefined
}

export function parseOSC(content: string): Action | null {
  const cut = content.indexOf(SEP)
  const data = cut === -1 ? '' : content.slice(cut + 1)
  switch (Number(cut === -1 ? content : content.slice(0, cut))) {
    case OSC.SET_TITLE_AND_ICON:
      return { type: 'title', action: { type: 'both', title: data } }
    case OSC.SET_ICON:
      return { type: 'title', action: { type: 'iconName', name: data } }
    case OSC.SET_TITLE:
      return { type: 'title', action: { type: 'windowTitle', title: data } }
    case OSC.HYPERLINK: {
      const split = data.indexOf(SEP)
      const url = split === -1 ? '' : data.slice(split + 1)
      if (url === '') return { type: 'link', action: { type: 'end' } }
      return { type: 'link', action: { type: 'start', url, params: linkParams(data.slice(0, split)) } }
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
  const pairs = Object.entries({ id: linkId(url), ...params })
  return osc(OSC.HYPERLINK, pairs.map(([key, value]) => `${key}=${value}`).join(':'), url)
}

export const LINK_END = osc(OSC.HYPERLINK, '', '')


export const CLEAR_TAB_STATUS = osc(OSC.TAB_STATUS, 'indicator=', 'status=', 'status-color=')

export function supportsTabStatus(): boolean {
  return false
}
