// ============================================================================
//  utils/terminalHandback — the ONE owner of the terminal hand-back: after a
//  deliberate tty child returns, the terminal's foreground process group is
//  this process's again.
//
//  Mercury hands the real terminal to a child on purpose in three places:
//  the external editor (editor.ts, promptEditor.ts) and the built-in
//  terminal panel (terminalPanel.ts). A job-control child — a login shell,
//  a shell-hosted editor — takes the terminal's foreground process group for
//  itself and gives it back on a normal exit. When it is killed nothing
//  gives it back: this process is then a background job of its own
//  terminal, and the next read of it (the next key, a mouse report) stops
//  the whole process group with SIGTTIN — a clean job-control stop since
//  the stop owner (ink/root/stop-continue.ts) restores the terminal first,
//  but still a pause the operator must notice and `fg`. Node has no
//  tcsetpgrp, so the reclaim is one native call in the vendored native pack
//  (native/voice/src/tty.rs, the module beside the voice capture): read the
//  terminal's foreground group, compare it with our own, and set it back
//  with SIGTTOU ignored for the call.
//
//  The call sits in a `finally` at every hand-off site, BEFORE the renderer
//  re-arms raw mode and the alternate screen: a tcsetattr from a background
//  process group is itself a SIGTTOU stop. It never throws. Without the
//  pack, off POSIX, without a terminal, or when the gate is off it answers
//  a receipt with the reason and the road stays what it was — the clean
//  stop and `fg`. The doctor's Terminal profile row states which road this
//  host has (describeTerminalHandback).
// ============================================================================
import { closeSync, openSync } from 'node:fs'

import { flagEnabled } from '../substrate/flagRegistry.js'
import { loadVoiceAddon, type VoiceAddon } from '../services/voice/voicePack.js'
import { logForDebugging } from './debug.js'

/** The slice of the native pack the hand-back uses. */
export type TtyAddon = Pick<VoiceAddon, 'ttyForegroundGroup' | 'ownProcessGroup' | 'reclaimTerminal'>

export type HandbackReason =
  /** The foreground group was already ours — a normal return; no call made. */
  | 'already foreground'
  /** No native pack for this host: the stop + `fg` road stands. */
  | 'pack absent'
  /** MERCURY_TERMINAL_HANDBACK=0. */
  | 'disabled'
  /** Neither stdio descriptor is a terminal and /dev/tty would not open. */
  | 'no terminal'
  /** Off POSIX there is no job control to reclaim from. */
  | 'unsupported'
  /** The native call answered an error (the note carries it). */
  | 'failed'

export type HandbackReceipt = {
  /** The hand-off site (the debug line names it). */
  label: string
  reclaimed: boolean
  reason?: HandbackReason
  note?: string
  /** The terminal's foreground group before / after, when they were read. */
  before?: number
  after?: number
  /** The descriptor the call went through. */
  fd?: number
}

/** The gate: default on; `=0` leaves every child return to the stop + fg road. */
export const TERMINAL_HANDBACK_FLAG = 'MERCURY_TERMINAL_HANDBACK'

// Proof seam: a stand-in addon (an object) or an absent pack (null);
// undefined means the vendored pack.
let addonForTest: TtyAddon | null | undefined = undefined

export function setTerminalHandbackAddonForTest(addon: TtyAddon | null | undefined): void {
  addonForTest = addon
}

type AddonLookup = { addon: TtyAddon } | { addon: null; note: string }

/** The native surface, lazily: the vendored pack through the one loader. */
function ttyAddon(): AddonLookup {
  if (addonForTest !== undefined) {
    return addonForTest === null ? { addon: null, note: 'no native pack (proof stand-in)' } : { addon: addonForTest }
  }
  const load = loadVoiceAddon()
  if (load.state !== 'ok') return { addon: null, note: load.note }
  return { addon: load.addon }
}

/** The descriptor the reclaim goes through: stdout, else stdin, else
 *  /dev/tty opened for the call and closed after. */
function terminalDescriptor(): { fd: number; release: () => void } | null {
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
          /* already closed */
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

/**
 * Reclaim the terminal's foreground process group after a deliberate tty
 * child returned. Call it in the `finally` of every hand-off, before the
 * renderer re-arms. Never throws.
 */
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
  /** The native reclaim is available on this host. */
  native: boolean
  /** The doctor's line: "Terminal hand-back: …". */
  line: string
}

/** The doctor fact: which road a killed editor or panel shell leaves this
 *  host on. Loads nothing but the pack's manifest and the addon itself. */
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
