
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
  evidence: string
  remediation: string
}

export interface TerminalProfileResolution {
  version: number
  verdict: 'full' | 'capable' | 'unsupported'
  checks: ProfileCheckResult[]
}

export interface ProfileProbe {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  isTTY?: boolean
  syncOutput?: boolean
  extendedKeys?: boolean
  hyperlinks?: boolean
  progress?: boolean
  modernWindowsHost?: boolean
  osRelease?: string
}

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
    ok: platform === 'win32' ? true : term !== 'dumb',
    evidence: `TERM=${term ?? '(unset)'} platform=${platform}`,
    remediation: 'Use a VT-capable terminal (TERM=dumb has no cursor addressing).',
  })

  if (platform === 'win32') {
    const modern = probe.modernWindowsHost ?? isModernWindowsTerminal()
    const release = probe.osRelease ?? (() => {
      try {
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
      ok: conptyEra || modern || Boolean(env.ConEmuANSI) || Boolean(term),
      evidence: `os=${release || '(unknown)'} · ${fingerprints}`,
      remediation: 'Run Mercury on Windows 10 1809+ — every console there is ConPTY-era.',
    })
    const sync = probe.syncOutput ?? syncOutputCapabilityNow()
    const fingerprinted = Boolean(env.WT_SESSION) || env.TERM_PROGRAM === 'vscode'
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
