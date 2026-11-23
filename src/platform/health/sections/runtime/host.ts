import chalk from 'chalk'
import { NODE_FLOOR_REASON, NODE_SUPPORT, nodeRuntimeProjection } from '../../../node-runtime/nodePolicy.js'
import { cpus, loadavg } from 'node:os'
import { deviceHeadroom } from '../../../../screen/cockpit/deviceHeadroom.js'
import { basename } from 'node:path'
import { getRipgrepStatus, warmRipgrepStatus } from '../../../shell/ripgrep.js'
import { CHALK_CLAMPED_FOR_MERCURY, CHALK_CLAMPED_FOR_TMUX, CHALK_DISABLED_FOR_NO_COLOR, colorDepthWhy, monochromeThemeActive } from '../../../../screen/renderer/colorize.js'
import { SHELL_READS, type CheckSpec } from '../../healthReport.js'
import { loadAverageSupported } from '../../../host-os/processes.js'

const MB = 1024 * 1024

const mb = (bytes: number) => `${(bytes / MB).toFixed(0)}MB`

export function versionLocksCheck(): CheckSpec {
  return {
    id: 'version-locks',
    label: 'Version locks',
    run: () => ({ status: 'off', evidence: 'pid-based version locking disabled' }),
  }
}

export function crashReportsCheck(): CheckSpec {
  return {
    id: 'crash-reports',
    label: 'Crash reports',
    run: async () => {
      const { crashReportDirDisplay, listCrashReports } = await import('../../../logs/crashReport.js')
      const reports = listCrashReports(3, { strict: true })
      if (reports.length === 0) return { status: 'ok', evidence: 'none recorded' }
      const newest = reports[0]!
      const where = [
        newest.sessionId !== null ? `session ${newest.sessionId.slice(0, 8)}` : null,
        newest.cwd !== null ? `in ${newest.cwd}` : null,
      ]
        .filter((bit): bit is string => bit !== null)
        .join(' ')
      return {
        status: 'info',
        evidence: `${reports.length} recent · newest: ${newest.at} ${newest.origin}${newest.component ? ` in ${newest.component}` : ''} — ${newest.message.slice(0, 60)}${where !== '' ? ` · ${where}` : ''} · ${crashReportDirDisplay()}`,
      }
    },
  }
}

export function runtimeCheck(): CheckSpec {
  return {
    id: 'runtime',
    label: 'Node & ripgrep',
    run: async () => {
      const rt = nodeRuntimeProjection(process.versions.node)
      const { runningRuntime } = await import('../../../update-channel/updateService.js')
      const { runtimeLine } = await import('../../../update-channel/vendoredRuntime.js')
      const which = runningRuntime()
      const nodePart =
        rt.verdict === 'supported'
          ? `${runtimeLine(which)}${which.source === 'vendored' ? '' : ` · supported — ${rt.label} (${rt.range})`}`
          : `${runtimeLine(which)} ${rt.verdict.toUpperCase()} — supported: ${rt.label} (${rt.range})`
      await warmRipgrepStatus()
      const rg = getRipgrepStatus()
      const rgPresent = rg.present
      const evidence = `${nodePart} · ripgrep ${rg.mode} @ ${basename(rg.path)} ${rgPresent ? 'present' : 'MISSING'}${rg.working === false ? ' · probe FAILED' : ''}`
      if (rt.verdict !== 'supported') {
        const belowFloor = rt.verdict === 'too-old' && rt.observed?.startsWith(`${NODE_SUPPORT.major}.`)
        return {
          status: 'fail',
          evidence,
          fix: `Install Node ${NODE_SUPPORT.minimum} or newer in the ${NODE_SUPPORT.major}.x line (${NODE_SUPPORT.label}) from https://nodejs.org and retry${belowFloor ? ` — ${NODE_FLOOR_REASON}` : ''}.`,
        }
      }
      if (!rgPresent || rg.working === false) {
        return {
          status: 'fail',
          evidence,
          fix: 'File search will fail — rebuild (`bun run build.ts`) to restore the bundled ripgrep.',
        }
      }
      return { status: 'ok', evidence }
    },
  }
}

export function shellCheck(): CheckSpec {
  return {
    id: 'shell',
    label: 'Bash tool shell',
    timeoutMs: 30_000,
    run: async () => (await SHELL_READS.shellRecord()).shellRow(),
  }
}

export function colorCheck(): CheckSpec {
  return {
    id: 'color',
    label: 'Terminal color',
    run: () => {
      const level = chalk.level
      if (monochromeThemeActive()) {
        return {
          status: 'info',
          evidence: `no color — ${colorDepthWhy()}; bold and reverse stay (the terminal itself offers chalk level ${level})`,
        }
      }
      if (CHALK_DISABLED_FOR_NO_COLOR || level === 0) {
        return {
          status: 'info',
          evidence: `chalk level 0 — no color (${CHALK_DISABLED_FOR_NO_COLOR ? 'NO_COLOR honored' : 'non-TTY output'})`,
        }
      }
      const applied = process.stdout.isTTY === true
      const appliedNote = applied
        ? ''
        : ' · computed from the environment — stdout is not a TTY, this output itself carries no color'
      if (CHALK_CLAMPED_FOR_TMUX) {
        return {
          status: 'info',
          evidence: `chalk level ${level} — clamped for tmux (accent snaps to the 256 cube)${appliedNote}`,
          fix: 'With `terminal-overrides ,*:Tc` in tmux, export MERCURY_TRUECOLOR=1 to keep exact 24-bit.',
        }
      }
      if (level === 3) {
        return {
          status: applied ? 'ok' : 'info',
          evidence: `chalk level 3 — truecolor · ${colorDepthWhy()} · brand hues exact${appliedNote}`,
        }
      }
      if (level === 1) {
        return {
          status: 'info',
          evidence: `chalk level 1 — basic 16-color ANSI; the brand accent snaps to the nearest of 16${appliedNote}`,
        }
      }
      return {
        status: 'info',
        evidence: `chalk level ${level} — 256-color · ${colorDepthWhy()} · the brand accent renders on the nearest cube${appliedNote}`,
        ...(CHALK_CLAMPED_FOR_MERCURY
          ? {}
          : {
              fix: 'The exact palette needs a terminal with 24-bit color (iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal); MERCURY_TRUECOLOR=1 forces the full depth on a terminal that has it and does not say so.',
            }),
      }
    },
  }
}

export function resourcesCheck(): CheckSpec {
  return {
    id: 'resources',
    label: 'Device headroom',
    run: async () => {
      const { availableB, source } = await deviceHeadroom()
      const cores = Math.max(1, cpus().length)
      const loadKnown = loadAverageSupported()
      const load1 = loadavg()[0] ?? 0
      const perCore = load1 / cores
      const loadText = loadKnown ? `load ${perCore.toFixed(2)}/core` : 'load n/a (win32 has no loadavg)'
      const evidence = `${mb(availableB)} available · ${loadText} (${cores} cores) (${source})`
      const busy = loadKnown ? perCore >= 1.25 : true
      if (availableB < 256 * MB || (availableB < 768 * MB && busy)) {
        return {
          status: 'warn',
          evidence: evidence + ' — headroom is genuinely tight for new agents',
          fix: 'Stop an agent or close memory-heavy apps before starting more.',
        }
      }
      return { status: 'ok', evidence }
    },
  }
}

export function boxLockCheck(): CheckSpec {
  return {
    id: 'box-lock',
    label: 'Box lock',
    run: async () => {
      const { boxLockDir, boxLockStateWords, readBoxLockState } = await import('../../../storage/boxLock.js')
      const dir = boxLockDir()
      if (dir === null) {
        return { status: 'info' as const, evidence: 'no box lock directory is named (MERCURY_BOX_LOCK_DIR) — the box row carries the load and memory only' }
      }
      const state = readBoxLockState(dir)
      if (state === null) {
        return { status: 'warn' as const, evidence: `MERCURY_BOX_LOCK_DIR names ${dir}, which is not there`, fix: 'Point MERCURY_BOX_LOCK_DIR at the coordination directory with-box-lock.sh uses (its BASE= line), or unset it.' }
      }
      return { status: 'ok' as const, evidence: `${dir}: ${boxLockStateWords(state)}` }
    },
  }
}

export function sessionKindCheck(): CheckSpec {
  return {
    id: 'session-kind',
    label: 'Session kind',
    run: async () => {
      const { sessionKindWords } = await import('../../../../daemon/concourse-workers/sessionKind.js')
      const { getFocusedSessionConnector, hasFocusedSession } = await import('../../../../engine/connector/focusedConnector.js')
      if (!hasFocusedSession()) {
        return { status: 'info' as const, evidence: 'no session is focused here — a session is one of two kinds (oculus: a screen belongs to it; headless: unattended), read from its record when a chat is open and named on its own mercury://seat' }
      }
      const sessionId = getFocusedSessionConnector().sessionId()
      const { readSessionWorkers } = await import('../../../../daemon/concourse-workers/concourseWorkers.js')
      const record = Object.values(readSessionWorkers()).find(rec => rec.sessionId === sessionId && rec.endedAt === undefined)
      if (record === undefined) return { status: 'info' as const, evidence: 'the focused session has no record on the daemon (its kind is read from the record)' }
      if (record.kind === undefined) return { status: 'info' as const, evidence: 'the focused session carries no kind on its record: it runs headless until it is resumed from the screen' }
      return { status: 'info' as const, evidence: `the focused session is ${sessionKindWords(record.kind)}` }
    },
  }
}
