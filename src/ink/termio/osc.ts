import { CLIPBOARD_FILE_ROUTE, writeClipboardFile } from '../../utils/clipboardFile.js'
import { env } from '../../utils/env.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { BEL, ESC, SEP } from './ansi.js'
import type { Action, Color, TabStatusAction } from './display-types.js'
import { passedOver } from '../../utils/passedOver.js'
import { hostEnv } from '../../utils/hostEnv.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

const OSC_PREFIX = `${ESC}]`
const ST = `${ESC}\\`

function terminator(): string {
  return env.terminal === 'kitty' ? ST : BEL
}

export function osc(...parts: (string | number)[]): string {
  return notBuilt('src/ink/termio/osc.ts:17')
}

export function wrapForMultiplexer(sequence: string): string {
  return notBuilt('src/ink/termio/osc.ts:21')
}


export const OSC: Unbuilt = unbuilt('src/ink/termio/osc.ts:32')

export const ITERM2: Unbuilt = unbuilt('src/ink/termio/osc.ts:54')

export const PROGRESS: Unbuilt = unbuilt('src/ink/termio/osc.ts:60')

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

export async function setClipboardWithReceipt(text: string): Promise<ClipboardReceipt> {
  return notBuilt('src/ink/termio/osc.ts:237')
}

export async function setClipboard(text: string): Promise<string> {
  return notBuilt('src/ink/termio/osc.ts:274')
}


export function parseOscColor(spec: string): Color | null {
  return notBuilt('src/ink/termio/osc.ts:279')
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
  return notBuilt('src/ink/termio/osc.ts:340')
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
  return notBuilt('src/ink/termio/osc.ts:386')
}

export const LINK_END: Unbuilt = unbuilt('src/ink/termio/osc.ts:395')


export const CLEAR_TAB_STATUS: Unbuilt = unbuilt('src/ink/termio/osc.ts:398')

export function supportsTabStatus(): boolean {
  return notBuilt('src/ink/termio/osc.ts:400')
}
