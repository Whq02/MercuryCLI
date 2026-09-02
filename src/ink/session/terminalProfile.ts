// ============================================================================
//  terminalProfile — the versioned Mercury full-profile contract.
//
//  RESPONSIBILITY: one owner answers "does this host satisfy the complete
//  Mercury design, and if not, exactly what is missing and what to do".
//  Composes the existing capability seams (capabilities.ts — sniffs plus the
//  live DECRQM-upgradeable latches); adds NO new detection of its own beyond
//  the host-class rules the operator fixed:
//
//    · ruling 3 — the full Windows profile requires Windows Terminal stable
//      or the VS Code integrated terminal; a host outside that gets the
//      requirement surface BEFORE the main interface, never a silently
//      degraded cockpit;
//    · rulings 2/17 — nothing here reduces a working host: `required` is the
//      floor the design cannot render without; everything else is
//      `recommended` and only informs the /health report card.
//
//  Deliberately NOT required: color. NO_COLOR / 16-color are SUPPORTED
//  capability families with authored structural equivalents — a no-color
//  operator gets full Mercury, not a warning card.
//
//  Consumers: the boot requirement surface (interactiveHelpers), the /health
//  TERMINAL PROFILE report card (healthReport), and the parity campaign's
//  capture profiles. Table-tested by scripts/cockpit-interaction/prove-terminal-profile.ts
//  through the `probe` overrides — the resolver itself stays pure.
// ============================================================================

import { env as detectedEnv } from '../../utils/env.js'
import {
  isModernWindowsTerminal,
  isProgressReportingAvailable,
  extendedKeysSupportedNow,
  supportsHyperlinks,
  syncOutputStatusNow,
  syncOutputCapabilityNow,
  syncOutputSupportedNow,
} from './capabilities.js'

export const TERMINAL_PROFILE_VERSION = 1

export type ProfileRequirement = 'required' | 'recommended'

export interface ProfileCheckResult {
  id: string
  label: string
  requirement: ProfileRequirement
  ok: boolean
  /** What was consulted — env var, latch, sniff — and what it said. */
  evidence: string
  /** The direct next action when not ok (always present on required rows). */
  remediation: string
}

export interface TerminalProfileResolution {
  version: number
  /** `unsupported` = a required row failed (boot shows the requirement
   *  surface). `capable` = floor met, some recommended capability absent.
   *  `full` = the complete design renders here. */
  verdict: 'full' | 'capable' | 'unsupported'
  checks: ProfileCheckResult[]
}

/** Test seam: every live read is overridable so provers can table-drive the
 *  matrix (win32 hosts, dumb TERM, tty-less) without process surgery. */
export interface ProfileProbe {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  isTTY?: boolean
  syncOutput?: boolean
  extendedKeys?: boolean
  hyperlinks?: boolean
  progress?: boolean
  modernWindowsHost?: boolean
  /** os.release() override — the ConPTY-era row is an OS-build fact. */
  osRelease?: string
}

/** ConPTY shipped in Windows 10 1809 (build 10.0.17763): from that build on,
 *  EVERY console session is ConPTY-era VT-capable — an OS fact, independent
 *  of which host app happens to set env fingerprints. */
const CONPTY_MIN_BUILD = 17763

function isConptyEraBuild(release: string): boolean {
  const m = release.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const major = Number(m[1])
  if (major > 10) return true
  if (major < 10) return false
  return Number(m[3]) >= CONPTY_MIN_BUILD
}

export function resolveTerminalProfile(probe: ProfileProbe = {}): TerminalProfileResolution {
  const env = probe.env ?? process.env
  const platform = probe.platform ?? process.platform
  const isTTY = probe.isTTY ?? Boolean(process.stdout.isTTY)
  const checks: ProfileCheckResult[] = []

  // ── required: the floor the design cannot render without ──────────────────
  checks.push({
    id: 'interactive-tty',
    label: 'interactive terminal',
    requirement: 'required',
    ok: isTTY,
    evidence: `stdout.isTTY=${isTTY}`,
    remediation: 'Run Mercury in an interactive terminal; piped/scripted use goes through -p (print mode).',
  })

  const term = env.TERM
  checks.push({
    id: 'term-vocabulary',
    label: 'cursor-addressable terminal',
    requirement: 'required',
    // win32 ConPTY hosts legitimately run without TERM; the win32 rows below
    // carry the platform's own floor.
    ok: platform === 'win32' ? true : term !== 'dumb',
    evidence: `TERM=${term ?? '(unset)'} platform=${platform}`,
    remediation: 'Use a VT-capable terminal (TERM=dumb has no cursor addressing).',
  })

  if (platform === 'win32') {
    const modern = probe.modernWindowsHost ?? isModernWindowsTerminal()
    const release = probe.osRelease ?? (() => {
      try {
        // Lazy: os is only consulted on win32 (the resolver stays pure
        // elsewhere and the probe overrides it entirely in tests).
        return (require('node:os') as typeof import('node:os')).release()
      } catch {
        return ''
      }
    })()
    const conptyEra = isConptyEraBuild(release)
    const fingerprints = `WT_SESSION=${env.WT_SESSION ? 'set' : 'unset'} TERM_PROGRAM=${env.TERM_PROGRAM ?? '(unset)'}${env.MSYSTEM ? ` MSYSTEM=${env.MSYSTEM}` : ''}`
    checks.push({
      id: 'win32-conpty-host',
      label: 'ConPTY-era console',
      requirement: 'required',
      // The era is an OS-build fact first (10.0.17763+); host-app
      // fingerprints only rescue exotic builds (the friend-path
      // class: this row would otherwise fail on every fingerprint-less console —
      // including the ConPTY consoles its own label names).
      ok: conptyEra || modern || Boolean(env.ConEmuANSI) || Boolean(term),
      evidence: `os=${release || '(unknown)'} · ${fingerprints}`,
      remediation: 'Run Mercury on Windows 10 1809+ — every console there is ConPTY-era.',
    })
    // First-class = Windows Terminal (stable) or the VS Code integrated
    // terminal. WT running as the OS DEFAULT terminal hosts a double-clicked
    // launcher WITHOUT injecting WT_SESSION (upstream: microsoft/terminal
    // #13006 — defterm attaches after the process starts), so the env
    // fingerprint alone calls a real WT window unsupported while the
    // operator is looking at it. Field-confirmed (the friend-path
    // diagnosis): zero env stamps AND "DEC 2026 latch: supported" — a modern
    // VT renderer with no fingerprints is the defterm signature. The DEC
    // 2026 synchronized-output latch is therefore the env-free witness: WT
    // and VS Code answer it, conhost does not. The latch is seeded by the
    // sniff and upgraded by the boot DECRQM probe — resolve() reads it LIVE,
    // so a consumer after the probe (the /health row, the requirement card's
    // re-check) sees the truth even when the boot-time read could not.
    // CAPABILITY, never emission: the operator's MERCURY_NO_SYNC_OUTPUT is
    // a rendering preference — it must not demote the host class the row
    // gates on (TASK-017 S2, no-sync-output-hatch-demotes-host).
    const sync = probe.syncOutput ?? syncOutputCapabilityNow()
    const fingerprinted = Boolean(env.WT_SESSION) || env.TERM_PROGRAM === 'vscode'
    // The witness stays NARROW: a terminal that
    // announces its own non-first-class identity (mintty/MSYS) never rides
    // the latch through — only the fingerprint-LESS case (WT as the default
    // terminal) has no identity to judge, and there DEC 2026 separates WT
    // from conhost.
    const minttyLike = env.TERM_PROGRAM === 'mintty' || Boolean(env.MSYSTEM)
    const firstClass = fingerprinted || (sync && !minttyLike)
    checks.push({
      id: 'win32-first-class-host',
      label: 'full-profile Windows host',
      requirement: 'required',
      ok: firstClass,
      evidence: fingerprinted
        ? fingerprints
        : sync
          ? `${fingerprints} · DEC 2026 live latch: supported (Windows Terminal as the default terminal injects no fingerprint)`
          : `${fingerprints} · DEC 2026 live latch: unsupported`,
      remediation:
        'The full Windows profile runs in Windows Terminal (stable) or the VS Code integrated terminal — PowerShell 7 preferred. You can continue knowingly, but the presentation is not the complete design.',
    })
  }

  // ── recommended: the complete experience ──────────────────────────────────
  const colorterm = env.COLORTERM
  const truecolor =
    colorterm === 'truecolor' || colorterm === '24bit' || Boolean(env.WT_SESSION) ||
    env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'iTerm.app'
  checks.push({
    id: 'truecolor',
    label: '24-bit color',
    requirement: 'recommended',
    ok: truecolor,
    evidence: `COLORTERM=${colorterm ?? '(unset)'}`,
    remediation: 'A truecolor terminal renders the exact brand palette; 256-color hosts get the quantized mapping.',
  })
  const sync = probe.syncOutput ?? syncOutputSupportedNow()
  // Armed/off WITH the deciding reason (probe injections keep their own
  // truth): the operator asking "why is my terminal tearing" or "why is
  // wrapping on under a broken emulator" reads the answer here.
  const syncWhy = probe.syncOutput !== undefined ? 'probe injection' : syncOutputStatusNow().why
  checks.push({
    id: 'synchronized-output',
    label: 'atomic frames (DEC 2026)',
    requirement: 'recommended',
    ok: sync,
    evidence: `${sync ? 'armed' : 'off'} — ${syncWhy}`,
    remediation: 'A synchronized-output terminal paints frames atomically (no tearing under load). MERCURY_NO_SYNC_OUTPUT=1 forces wrapping off on terminals with broken DEC 2026 implementations.',
  })
  const extKeys = probe.extendedKeys ?? extendedKeysSupportedNow()
  checks.push({
    id: 'extended-keys',
    label: 'extended key reporting',
    requirement: 'recommended',
    ok: extKeys,
    evidence: `terminal=${detectedEnv.terminal ?? 'unknown'}`,
    remediation: 'Extended-key terminals distinguish more chords (shift+enter, super bindings).',
  })
  const links = probe.hyperlinks ?? supportsHyperlinks()
  checks.push({
    id: 'hyperlinks',
    label: 'OSC 8 hyperlinks',
    requirement: 'recommended',
    ok: links,
    evidence: links ? 'supported' : 'unsupported',
    remediation: 'Hyperlink-capable terminals make file/evidence references clickable.',
  })
  const progress = probe.progress ?? isProgressReportingAvailable()
  checks.push({
    id: 'progress-reporting',
    label: 'OSC 9;4 progress',
    requirement: 'recommended',
    ok: progress,
    evidence: progress ? 'available' : 'unavailable',
    remediation: 'Progress-capable terminals mirror long-running work in the tab/taskbar.',
  })

  const requiredFailed = checks.some(c => c.requirement === 'required' && !c.ok)
  const allOk = checks.every(c => c.ok)
  return {
    version: TERMINAL_PROFILE_VERSION,
    verdict: requiredFailed ? 'unsupported' : allOk ? 'full' : 'capable',
    checks,
  }
}
