import chalk from 'chalk'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { browserReadinessCheck, ocrReadinessCheck, SHELL_READS, type CheckSpec } from '../healthReport.js'
import { brushPackRemedyWords, systemBashLabel } from '../../host-os/words.js'

export function interfaceChecks(): CheckSpec[] {
  return [
    {
      id: 'iface-terminal',
      label: 'Terminal profile',
      run: () => {
        const { resolveTerminalProfile } = require('../../../screen/renderer/terminal-session/terminalProfile.js') as typeof import('../../../screen/renderer/terminal-session/terminalProfile.js')
        const { describeTerminalHandback } = require('../../shell/terminalHandback.js') as typeof import('../../shell/terminalHandback.js')
        const handback = describeTerminalHandback()
        const p = resolveTerminalProfile()
        const cols = process.stdout.columns ?? 0
        const rows = process.stdout.rows ?? 0
        const color = chalk.level >= 3 ? 'truecolor' : chalk.level === 2 ? '256-color' : chalk.level === 1 ? '16-color' : 'no-color'
        const missing = p.checks.filter(c => !c.ok)
        const detail = [
          ...p.checks.map(c => `${c.ok ? '●' : c.requirement === 'required' ? '✕' : '○'} ${c.label} (${c.requirement}) — ${c.evidence}${c.ok ? '' : ` · ${c.remediation}`}`),
          handback.line,
        ].join('\n')
        if (!process.stdout.isTTY) {
          return {
            status: 'info' as const,
            evidence: `environmental: stdout is piped/redirected — interactive-terminal requirements do not apply to this run (profile v${p.version} facts retained in detail)`,
            detail,
          }
        }
        const cannotDraw = missing.some(c => c.requirement === 'required' && c.id !== 'win32-first-class-host')
        return {
          status: p.verdict === 'unsupported' ? (cannotDraw ? 'fail' : 'warn') : p.verdict === 'capable' ? 'info' : 'ok',
          evidence: `profile v${p.version} ${p.verdict} · ${cols}x${rows} · ${color}${missing.length ? ` · missing: ${missing.map(c => c.id).join(', ')}` : ''} · hand-back: ${handback.native ? 'native' : 'stop + fg'}`,
          detail,
          ...(p.verdict === 'unsupported'
            ? { fix: missing.find(c => c.requirement === 'required')?.remediation }
            : {}),
        }
      },
    },
    {
      id: 'iface-tokens',
      label: 'Theme tokens',
      run: () => {
        const { THEME_NAMES } = require('../../../screen/theme/theme.js') as typeof import('../../../screen/theme/theme.js')
        const { resolveMercuryTokens, listUnresolvedTokenRoles } = require('../../../screen/theme/mercuryTokens.js') as typeof import('../../../screen/theme/mercuryTokens.js')
        const { getSessionAccent } = require('../../../screen/widgets/sessionAccent.js') as typeof import('../../../screen/widgets/sessionAccent.js')
        const accent = getSessionAccent()
        const unresolved = THEME_NAMES.flatMap(fam =>
          listUnresolvedTokenRoles(resolveMercuryTokens(fam, accent.accent)).map(p => `${fam}.${p}`),
        )
        return unresolved.length === 0
          ? { status: 'ok', evidence: `${THEME_NAMES.length} families resolve every role · accent ${accent.accent} (${accent.key})` }
          : {
              status: 'fail',
              evidence: `${unresolved.length} unresolved role value(s): ${unresolved.slice(0, 3).join(' · ')}`,
              fix: 'A theme family resolved an empty token — the named role would paint without ink. Report which family; /appearance switches away meanwhile.',
            }
      },
    },
    {
      id: 'iface-baseline',
      label: 'Visual baseline',
      run: () => {
        const { readFileSync: rf, existsSync: ex } = require('node:fs') as typeof import('node:fs')
        const { join: j } = require('node:path') as typeof import('node:path')
        const manifestPath = j(process.cwd(), 'design-system', 'live', 'manifest.json')
        if (!ex(manifestPath)) {
          return { status: 'info', evidence: 'no design-system/live/manifest.json in this project (the Mercury repo carries the baseline)' }
        }
        try {
          const m = JSON.parse(rf(manifestPath, 'utf8')) as { sourceSha?: unknown; entries?: unknown; generatedAt?: unknown }
          const entries = Array.isArray(m.entries) ? m.entries : null
          if (entries === null || entries.length === 0) {
            return {
              status: 'info',
              evidence: 'manifest lists no entries — not a certified baseline (regenerate via scripts/ui/generate-visual-baseline.ts)',
            }
          }
          if (typeof m.sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(m.sourceSha)) {
            return {
              status: 'warn',
              evidence: `manifest sourceSha is not a commit sha (${String(m.sourceSha).slice(0, 16)}) — provenance unverifiable`,
            }
          }
          const gridsDir = j(process.cwd(), 'design-system', 'live', 'grids')
          if (!ex(gridsDir)) {
            return {
              status: 'warn',
              evidence: `manifest lists ${entries.length} entries but design-system/live/grids is absent — the baseline's frames are not here`,
            }
          }
          const generatedAt = typeof m.generatedAt === 'string' ? m.generatedAt.slice(0, 10) : 'undated'
          return {
            status: 'ok',
            evidence: `${entries.length} entries @ ${m.sourceSha.slice(0, 8)} · ${generatedAt} · check: bun run scripts/ui/generate-visual-baseline.ts --check`,
          }
        } catch {
          return { status: 'fail', evidence: 'manifest unreadable — regenerate via scripts/ui/generate-visual-baseline.ts' }
        }
      },
    },
    browserReadinessCheck(),
    {
      id: 'iface-voice',
      label: 'Voice input',
      run: async () => {
        const { describeVoiceReadiness } = await import('../../../integrations/voice/voiceSession.js')
        const readiness = describeVoiceReadiness()
        return { status: readiness.ready ? ('ok' as const) : ('info' as const), evidence: readiness.line, detail: readiness.detail }
      },
    },
    {
      id: 'iface-computer-use',
      label: 'Computer use',
      run: async () => {
        const { describeDesktopDriver } = await import('../../../integrations/desktop/nativeDriver.js')
        const facts = await describeDesktopDriver()
        return { status: facts.ready ? ('ok' as const) : ('info' as const), evidence: facts.line, detail: facts.detail, ...(facts.fix ? { fix: facts.fix } : {}) }
      },
    },
    {
      id: 'iface-samples',
      label: 'Samples',
      run: async () => {
        const { samplesEnabled } = await import('../../../integrations/sample-contracts/contracts.js')
        const on = samplesEnabled()
        return {
          status: on ? ('ok' as const) : ('info' as const),
          evidence: on
            ? 'samples on — sample() in Eval cells keeps a page you asked to see; the listener starts on the first sample'
            : "samples off (the default) — the Boot Menu's Samples row or MERCURY_SAMPLES=1 turns them on for new sessions",
        }
      },
    },
    ocrReadinessCheck(),
    {
      id: 'iface-image-processor',
      label: 'Image processor',
      run: async () => {
        const { describeImageProcessor } = await import('../../images/imageProcessor.js')
        const road = await describeImageProcessor()
        return { status: road.ready ? ('ok' as const) : ('warn' as const), evidence: road.line, ...(road.detail ? { detail: road.detail } : {}) }
      },
    },
    {
      id: 'iface-shell-engine',
      label: 'Shell engine',
      timeoutMs: 30_000,
      run: async () => {
        const { engineSessionCeilingPinned, resolveEngineSessionCeiling, resolveShellEngine } = await SHELL_READS.engineSession()
        const { shellEngineArmWords } = await SHELL_READS.engineArm()
        const { getInitialSettings } = await import('../../settings/settings.js')
        const settings = getInitialSettings()
        const setting = settings.shell?.engine ?? 'system'
        const resolved = resolveShellEngine(settings.shell?.engine)
        if (resolved.engine === 'brush') {
          const ceiling = resolveEngineSessionCeiling(settings.shell?.sessions)
          const armed = resolved.arm === 'no-bash' ? 'armed by itself: no bash.exe was found on this machine, so the bundled engine serves the Bash tool' : `armed by ${shellEngineArmWords(resolved.arm)}`
          return {
            status: 'ok' as const,
            evidence: `brush ${resolved.version} (${resolved.platform}, ${resolved.source}) — ${armed} — one persistent process per conversation and one per crewmate, up to ${ceiling} at once; shell state persists between calls; a stop while a command runs resets the session`,
            detail: `setting: ${setting}${flagEnv('MERCURY_SHELL_ENGINE') ? ` · env pin MERCURY_SHELL_ENGINE=${flagEnv('MERCURY_SHELL_ENGINE')}` : ''} · sessions ceiling ${ceiling} (${engineSessionCeilingPinned() ? 'the env pin MERCURY_SHELL_ENGINE_SESSIONS' : 'the shell.sessions setting'})`,
          }
        }
        const wanted = resolved.requested === 'brush'
        const packRemedy = brushPackRemedyWords()
        const { settleShellRecord, shellRecordNow } = await SHELL_READS.shellRecord()
        if (!wanted) {
          const { withDeadline } = await import('../../async/deadline.js')
          await withDeadline(settleShellRecord(), 15_000, () => undefined)
        }
        const record = shellRecordNow()
        const serving = record === null ? 'no shell' : record.origin === 'shipped' ? 'the shipped bash' : record.origin === 'engine' ? 'the bundled engine' : systemBashLabel()
        return {
          status: 'info' as const,
          evidence: wanted ? resolved.reason : `${serving} serves the Bash tool (${shellEngineArmWords(resolved.arm)}); arm the vendored engine with the Shell engine setting or MERCURY_SHELL_ENGINE=brush`,
          ...(wanted ? { fix: packRemedy } : {}),
        }
      },
    },
    {
      id: 'iface-inventory',
      label: 'Interaction inventory',
      run: () => {
        const { existsSync: ex } = require('node:fs') as typeof import('node:fs')
        const { join: j } = require('node:path') as typeof import('node:path')
        const p1 = j(process.cwd(), 'scripts', 'interaction', 'prove-interaction-coverage.ts')
        return ex(p1)
          ? { status: 'ok', evidence: 'interaction-coverage prover present — the inventory gates in the interaction suite' }
          : { status: 'info', evidence: 'not the Mercury repo — the inventory gates in-repo' }
      },
    },
  ]
}
