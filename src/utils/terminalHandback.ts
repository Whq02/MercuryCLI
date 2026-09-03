import { closeSync, openSync } from 'node:fs'

import { flagEnabled } from '../substrate/flagRegistry.js'
import { loadVoiceAddon, type VoiceAddon } from '../services/voice/voicePack.js'
import { logForDebugging } from './debug.js'

export type TtyAddon = Pick<VoiceAddon, 'ttyForegroundGroup' | 'ownProcessGroup' | 'reclaimTerminal'>

export type HandbackReason =
  | 'already foreground'
  | 'pack absent'
  | 'disabled'
  | 'no terminal'
  | 'unsupported'
  | 'failed'

export type HandbackReceipt = {
  label: string
  reclaimed: boolean
  reason?: HandbackReason
  note?: string
  before?: number
  after?: number
  fd?: number
}

export const TERMINAL_HANDBACK_FLAG = 'MERCURY_TERMINAL_HANDBACK'

let addonForTest: TtyAddon | null | undefined = undefined

export function setTerminalHandbackAddonForTest(addon: TtyAddon | null | undefined): void {
  addonForTest = addon
}

let descriptorForTest: number | 'none' | undefined = undefined

export function setTerminalHandbackDescriptorForTest(fd: number | 'none' | undefined): void {
  descriptorForTest = fd
}

type AddonLookup = { addon: TtyAddon } | { addon: null; note: string }

function ttyAddon(): AddonLookup {
  if (addonForTest !== undefined) {
    return addonForTest === null ? { addon: null, note: 'no native pack (proof stand-in)' } : { addon: addonForTest }
  }
  const load = loadVoiceAddon()
  if (load.state !== 'ok') return { addon: null, note: load.note }
  return { addon: load.addon }
}

function terminalDescriptor(): { fd: number; release: () => void } | null {
  if (descriptorForTest !== undefined) return descriptorForTest === 'none' ? null : { fd: descriptorForTest, release: () => {} }
  if (process.stdout.isTTY) return { fd: 1, release: () => {} }
  if (process.stdin.isTTY) return { fd: 0, release: () => {} }
  try {
    const fd = openSync('/dev/tty', 'r+')
    return {
      fd,
      release: () => {
        try {
          closeSync(fd)
        } catch {
        }
      },
    }
  } catch {
    return null
  }
}

function settle(receipt: HandbackReceipt): HandbackReceipt {
  const where = receipt.fd === undefined ? '' : ` (fd ${receipt.fd})`
  logForDebugging(
    receipt.reclaimed
      ? `terminal hand-back [${receipt.label}]: reclaimed the foreground group ${receipt.before} → ${receipt.after}${where}`
      : `terminal hand-back [${receipt.label}]: ${receipt.reason}${receipt.note ? ` — ${receipt.note}` : ''}${where}`,
  )
  return receipt
}

export function reclaimTerminalAfterChild(label: string): HandbackReceipt {
  try {
    if (process.platform === 'win32') {
      return settle({ label, reclaimed: false, reason: 'unsupported', note: 'no POSIX job control on this platform' })
    }
    if (!flagEnabled(TERMINAL_HANDBACK_FLAG)) {
      return settle({ label, reclaimed: false, reason: 'disabled', note: `${TERMINAL_HANDBACK_FLAG}=0` })
    }
    const lookup = ttyAddon()
    if (lookup.addon === null) return settle({ label, reclaimed: false, reason: 'pack absent', note: lookup.note })
    const terminal = terminalDescriptor()
    if (terminal === null) return settle({ label, reclaimed: false, reason: 'no terminal', note: 'no terminal descriptor to reclaim through' })
    const { fd } = terminal
    try {
      const own = lookup.addon.ownProcessGroup()
      if (typeof own.pgid !== 'number') {
        return settle({ label, reclaimed: false, reason: own.reason === 'unsupported' ? 'unsupported' : 'failed', note: own.reason ?? 'getpgrp answered nothing', fd })
      }
      const foreground = lookup.addon.ttyForegroundGroup(fd)
      if (typeof foreground.pgid !== 'number') {
        return settle({ label, reclaimed: false, reason: foreground.reason === 'unsupported' ? 'unsupported' : 'failed', note: foreground.reason ?? 'tcgetpgrp answered nothing', fd })
      }
      if (foreground.pgid === own.pgid) {
        return settle({ label, reclaimed: false, reason: 'already foreground', before: foreground.pgid, after: foreground.pgid, fd })
      }
      const answer = lookup.addon.reclaimTerminal(fd)
      const before = typeof answer.before === 'number' ? answer.before : foreground.pgid
      const after = typeof answer.after === 'number' ? answer.after : undefined
      if (answer.reclaimed) return settle({ label, reclaimed: true, before, after: after ?? own.pgid, fd })
      return settle({
        label,
        reclaimed: false,
        reason: answer.reason === 'unsupported' ? 'unsupported' : 'failed',
        note: answer.reason ?? `tcsetpgrp left the foreground group at ${String(after)}`,
        before,
        ...(after === undefined ? {} : { after }),
        fd,
      })
    } finally {
      terminal.release()
    }
  } catch (error) {
    return settle({ label, reclaimed: false, reason: 'failed', note: error instanceof Error ? error.message : String(error) })
  }
}

export type HandbackDescription = {
  native: boolean
  line: string
}

export function describeTerminalHandback(): HandbackDescription {
  const stopRoad = 'a killed editor or panel shell leaves a clean job-control stop; fg resumes'
  if (process.platform === 'win32') {
    return { native: false, line: 'Terminal hand-back: not applicable — no POSIX job control on this platform' }
  }
  if (!flagEnabled(TERMINAL_HANDBACK_FLAG)) {
    return { native: false, line: `Terminal hand-back: native reclaim OFF (${TERMINAL_HANDBACK_FLAG}=0) ⇒ stop + fg — ${stopRoad}` }
  }
  if (addonForTest !== undefined) {
    return addonForTest === null
      ? { native: false, line: `Terminal hand-back: pack absent ⇒ stop + fg — ${stopRoad}` }
      : { native: true, line: 'Terminal hand-back: native reclaim available (proof stand-in)' }
  }
  const load = loadVoiceAddon()
  if (load.state !== 'ok') {
    return { native: false, line: `Terminal hand-back: pack absent ⇒ stop + fg — ${stopRoad} (${load.note})` }
  }
  return {
    native: true,
    line: `Terminal hand-back: native reclaim available — ${load.manifest.name} ${load.manifest.version} ${load.manifest.platform} (${load.source}) reclaims the foreground group after a killed editor or panel shell`,
  }
}
