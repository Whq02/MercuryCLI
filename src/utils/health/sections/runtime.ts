import chalk from 'chalk'
import { NODE_FLOOR_REASON, NODE_SUPPORT, nodeRuntimeProjection } from '../../runtime/nodePolicy.js'
import { existsSync, readFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { deviceHeadroom } from '../../cockpit/deviceHeadroom.js'
import { basename, dirname, join } from 'node:path'
import { isInvocationTraceEnabled } from '../../observability/invocationTrace.js'
import { mercuryLspEnabled } from '../../../services/lsp/mercuryLsp.js'
import { probeBuiltinTsServer } from '../../../services/lsp/builtinServers.js'
import { compileDbRemedy, mercuryLspCppEnabled, probeBuiltinClangd, probeCompileDb } from '../../../services/lsp/clangdLane.js'
import { probeGodotEditorReachable, probeGodotLane } from '../../../services/lsp/godotLane.js'
import { getInitializationStatus, getLspServerManager } from '../../../services/lsp/manager.js'
import { getRipgrepStatus, warmRipgrepStatus } from '../../ripgrep.js'
import { CHALK_CLAMPED_FOR_MERCURY, CHALK_CLAMPED_FOR_TMUX, CHALK_DISABLED_FOR_NO_COLOR, colorDepthWhy, monochromeThemeActive } from '../../../ink/colorize.js'
import { mcpGauge } from '../../cockpit/mcpGauge.js'
import { substrateSnapshot } from '../../cockpit/substrateSnapshot.js'
import { describeUntrustedMcpHardening, getMcpPolicyRejects } from '../../../services/mcp/toolPolicy.js'
import { summarizeMcpAuthCurrency } from '../../../services/mcp/auth.js'
import { describeMcpProtocolCurrency } from '../../../services/mcp/protocolRevision.js'
import { extensionsHealthRow } from '../../../extensions/boot.js'
import { healthFixEnabled } from '../../healthFix.js'
import { SHELL_READS, flagAsSet, type CheckSpec } from '../../healthReport.js'

const MB = 1024 * 1024

const mb = (bytes: number) => `${(bytes / MB).toFixed(0)}MB`

function readTsVersion(tsPath: string): string | null {
  try {
    const pkgPath = join(dirname(dirname(tsPath)), 'package.json')
    if (!existsSync(pkgPath)) return null
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

function editOutcomeHealthChecks(): CheckSpec[] {
  try {
    const { editOutcomeLedgerEnabled } =
      require('../../../services/changeTransaction/editOutcomeLedger.js') as typeof import('../../../services/changeTransaction/editOutcomeLedger.js')
    if (!editOutcomeLedgerEnabled()) return []
  } catch {
    return []
  }
  return [
    {
      id: 'edit-outcomes',
      label: 'Edit outcomes',
      run: async () => {
        const { editOutcomeHealthRows, editOutcomeHealthRowsOf } = await import('../../../services/changeTransaction/editOutcomeLedger.js')
        const { processMainOwner } = await import('../../../services/run/resolveOwner.js')
        const { getFocusedSessionConnector, hasFocusedSession } = await import('../../../services/engine-connector/focusedConnector.js')
        const { hasSeatLive } = await import('../../../services/engine-connector/seatLive.js')
        const focused = hasFocusedSession() ? getFocusedSessionConnector() : null
        const seat = focused !== null && hasSeatLive(focused) ? focused : null
        const sessionRows = seat?.editOutcomes?.()
        if (seat !== null && sessionRows === null) return { status: 'off', evidence: "the session's runner reports no edit ledger (an older runner)" }
        const rows = sessionRows !== undefined && sessionRows !== null ? editOutcomeHealthRowsOf(sessionRows) : editOutcomeHealthRows(processMainOwner())
        if (rows.length === 0) return { status: 'ok', evidence: 'no edit attempts this session' }
        return {
          status: 'info',
          evidence: rows
            .map(
              row =>
                `${row.model}: ${row.attempts} attempt(s), ${row.applied} applied${row.topFailure !== null ? `, top failure ${row.topFailure} ×${row.topFailureCount}` : ''}`,
            )
            .join(' · '),
        }
      },
    },
  ]
}

export function runtimeChecks(): CheckSpec[] {
  return [
    {
      id: 'version-locks',
      label: 'Version locks',
      run: () => ({ status: 'off', evidence: 'pid-based version locking disabled' }),
    },
    {
      id: 'crash-reports',
      label: 'Crash reports',
      run: async () => {
        const { crashReportDirDisplay, listCrashReports } = await import('../../crashReport.js')
        const reports = listCrashReports(3)
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
    },
    ...editOutcomeHealthChecks(),
    {
      id: 'runtime',
      label: 'Node & ripgrep',
      run: async () => {
        const rt = nodeRuntimeProjection(process.versions.node)
        const { runningRuntime } = await import('../../../services/privateChannel/updateService.js')
        const { runtimeLine } = await import('../../../services/privateChannel/vendoredRuntime.js')
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
    },
    {
      id: 'shell',
      label: 'Bash tool shell',
      run: async () => {
        const { shellRow } = await SHELL_READS.shellRecord()
        return shellRow()
      },
    },
    {
      id: 'eval-kernels',
      label: 'Eval languages',
      run: async () => {
        const { evalEnabled } = await import('../../../services/eval/contracts.js')
        const { primeEvalAvailability } = await import('../../../services/eval/interpreters.js')
        const { getCwd } = await import('../../cwd.js')
        if (!evalEnabled()) {
          return { status: 'off', evidence: `${flagAsSet('MERCURY_EVAL')} — the Eval tool is out of the catalogue` }
        }
        const rows = await primeEvalAvailability(getCwd())
        const evidence = rows
          .map(row =>
            row.available
              ? `${row.language} ${row.version ?? 'ok'} @ ${row.interpreterPath ?? '?'}`
              : `${row.language} UNAVAILABLE (${row.whyNot ?? 'unknown'})`,
          )
          .join(' · ')
        const availableCount = rows.filter(row => row.available).length
        if (availableCount === 0) {
          return {
            status: 'warn',
            evidence,
            fix: 'No eval language is runnable — the tool is hidden. Install python3 ≥3.10 or make a node binary reachable.',
          }
        }
        if (availableCount < rows.length) {
          return { status: 'info', evidence }
        }
        return { status: 'ok', evidence }
      },
    },
    {
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
    },
    {
      id: 'mcp',
      label: 'MCP policy',
      run: () => {
        const mcp = mcpGauge()
        const policyDesc = mcp.data.mcpPolicyHint
        const policyActive = mcp.data.mcpPolicyActive
        let policyRejects: string[] = []
        try {
          policyRejects = getMcpPolicyRejects()
        } catch {
        }
        const policyRejectFix =
          'MERCURY_MCP_MAX_RISK carries token(s) the parser cannot read (named in the evidence); the unread part keeps the permissive default. Grammar: low|medium|high, plus srv:low per server, comma-separated.'
        if (mcp.state === 'off') {
          return {
            status: policyRejects.length > 0 ? 'warn' : 'off',
            evidence: `no MCP servers configured · policy ${policyDesc} · ${describeUntrustedMcpHardening()}`,
            ...(policyRejects.length > 0 ? { fix: policyRejectFix } : {}),
          }
        }
        if (mcp.state !== 'live') {
          return { status: 'unknown', evidence: mcp.reason ?? 'mcp config unreadable' }
        }
        const hardening = describeUntrustedMcpHardening()
        const currency = describeMcpProtocolCurrency()
        const revLine = currency.line
        const auth = summarizeMcpAuthCurrency()
        const authLine =
          auth === null
            ? 'auth unknown'
            : auth.tokens === 0
              ? 'no oauth tokens'
              : `auth ${auth.tokens} token(s)${auth.expired > 0 ? ` · ${auth.expired} EXPIRED` : ''}${auth.expiringSoon > 0 ? ` · ${auth.expiringSoon} expiring <30m` : ''}`
        const serverList = mcp.data.servers
          .slice(0, 3)
          .map(s => `${s.name} (${s.state})`)
          .join(', ')
        const evidence = `${mcp.data.servers.length} server(s): ${serverList}${mcp.data.servers.length > 3 ? '…' : ''} · policy ${policyDesc} · ${hardening} · ${revLine} · ${authLine}`
        if (policyRejects.length > 0) {
          return { status: 'warn', evidence, fix: policyRejectFix }
        }
        if (auth !== null && auth.expired > 0) {
          return {
            status: 'warn',
            evidence,
            fix: 'Re-authenticate the expired server(s) via /mcp (tokens refresh on next use; this makes the stale ones visible).',
          }
        }
        if (currency.behind) {
          return {
            status: 'warn',
            evidence,
            ...(currency.fix ? { fix: currency.fix } : {}),
          }
        }
        if (!policyActive) {
          return {
            status: 'info',
            evidence,
            fix: 'Tighten if desired: MERCURY_MCP_MAX_RISK=low|medium (or srv:low per server).',
          }
        }
        return { status: 'ok', evidence }
      },
    },
    {
      id: 'extensions',
      label: 'Extensions',
      run: () => {
        const row = extensionsHealthRow()
        if (row.problems.length > 0) {
          return {
            status: 'fail',
            evidence: row.problems.join(' · '),
            fix: 'Fix or remove the record file named under <config home>/extensions; the roster reads empty until then.',
          }
        }
        if (row.status === 'off') return { status: 'off', evidence: 'no extensions installed' }
        if (row.status === 'fail') {
          const brokenIds = row.brokenReasons.map(b => `${b.id} (${b.reason})`).join(', ')
          return {
            status: 'fail',
            evidence: `${row.evidence} — broken: ${brokenIds}`,
            fix: '/extensions shows each reason; a copy whose folder is gone is removed with x.',
            ...(healthFixEnabled() && row.brokenReasons.some(b => b.reason.startsWith('folder missing'))
              ? {
                  remedy: {
                    plan: `remove the installed record(s) whose folder is gone: ${row.brokenReasons.filter(b => b.reason.startsWith('folder missing')).map(b => b.id).join(', ')}`,
                    class: 'safe' as const,
                    apply: async () => {
                      const { uninstall } = await import('../../../extensions/install.js')
                      const gone = row.brokenReasons.filter(b => b.reason.startsWith('folder missing'))
                      for (const b of gone) uninstall(b.id, { keepData: true })
                      return { ok: true, note: `${gone.length} record(s) removed (data folders kept)` }
                    },
                    verify: async () => {
                      const rescan = extensionsHealthRow()
                      const remaining = rescan.brokenReasons.filter(b => b.reason.startsWith('folder missing'))
                      return remaining.length === 0 ? { ok: true, note: rescan.evidence } : { ok: false, note: `${remaining.length} record(s) still point at a missing folder` }
                    },
                  },
                }
              : {}),
          }
        }
        if (row.status === 'warn') {
          return { status: 'warn', evidence: row.evidence, fix: '/extensions shows each partial extension\'s reasons (a missing binary, an unset env var or option, a dead contribution).' }
        }
        return { status: 'ok', evidence: row.evidence }
      },
    },
    {
      id: 'media',
      label: 'Local media',
      run: async () => (await import('../../../services/media/settings.js')).mediaHealth(),
    },
    {
      id: 'lsp',
      label: 'IDE-hands (LspRead)',
      run: async () => {
        if (!mercuryLspEnabled()) {
          return {
            status: 'off',
            evidence: `${flagAsSet('MERCURY_LSP')} — IDE-hands bridge disabled by flag`,
          }
        }
        const probe = probeBuiltinTsServer()
        const tsEvidence = probe.typescriptPath
          ? `typescript@${readTsVersion(probe.typescriptPath) ?? '?'}`
          : 'no workspace typescript'
        const laneSegments: string[] = []
        if (!mercuryLspCppEnabled()) {
          laneSegments.push(`cpp lane off (${flagAsSet('MERCURY_LSP_CPP')})`)
        } else {
          const cpp = probeBuiltinClangd()
          if (!cpp.available || !cpp.clangdPath) {
            laneSegments.push('no clangd')
          } else {
            const db = probeCompileDb()
            laneSegments.push(
              db.compileDb
                ? 'clangd ok · compile DB found'
                : db.cmakeLists
                  ? `clangd ok · ${compileDbRemedy(db)}`
                  : 'clangd ok',
            )
          }
        }
        const godot = probeGodotLane()
        if (!godot.enabled) {
          laneSegments.push('godot lane off (MERCURY_GODOT)')
        } else if (!godot.projectRoot) {
          laneSegments.push('godot armed · no project.godot here')
        } else {
          const reachable = await probeGodotEditorReachable(godot.lspPort)
          laneSegments.push(
            reachable
              ? `godot editor listening :${godot.lspPort}`
              : `godot editor NOT listening :${godot.lspPort} — open the project in the Godot editor (or godot --editor --headless; macOS app bundle: <Godot.app>/Contents/MacOS/Godot)`,
          )
        }
        const lanes = laneSegments.join(' · ')
        const init = getInitializationStatus()
        if (init.status === 'failed') {
          return {
            status: 'fail',
            evidence: `manager init failed: ${init.error.message.slice(0, 120)}`,
            fix: 'Check extension language-server configs / MERCURY_LSP_SERVERS JSON; /extensions reload re-inits.',
          }
        }
        if (init.status === 'not-started' || init.status === 'pending') {
          return {
            status: 'info',
            evidence: `bridge armed · ${tsEvidence} · ${lanes} · manager ${init.status} (probe: builtinServers.probeBuiltinTsServer)`,
          }
        }
        const manager = getLspServerManager()
        const servers = manager ? [...manager.getAllServers().values()] : []
        if (servers.length === 0) {
          return {
            status: 'info',
            evidence: `no LSP server source — ${probe.reason ?? tsEvidence}; ${lanes}`,
            fix: 'Add typescript to the workspace, install clangd, provide MERCURY_LSP_SERVERS, or install an extension that contributes a language server.',
          }
        }
        const errored = servers.filter(s => s.state === 'error')
        const roster = servers
          .map(s => `${s.name} ${s.state === 'stopped' ? 'idle' : s.state}`)
          .join(' · ')
        if (errored.length > 0) {
          return {
            status: 'warn',
            evidence: `${roster} — ${errored[0]!.name}: ${errored[0]!.lastError?.message.slice(0, 100) ?? 'error'}`,
            fix: 'Server errored; it restarts on next use up to maxRestarts. MERCURY_LSP_DEBUG=1 for sidecar stderr.',
            link: '/trace',
          }
        }
        return {
          status: 'ok',
          evidence: `${roster} · ${tsEvidence} · ${lanes} · post-edit diagnostics armed (servers lazy-start on first use)`,
          link: '/trace',
        }
      },
    },
    {
      id: 'editor-door',
      label: 'Editor door',
      run: async () => {
        const { installedEditorExtensions } = await import('../../editorExtensionPackage.js')
        const installed = installedEditorExtensions()
        const evidence = [
          installed.length > 0
            ? `extension installed: ${installed.map(i => `${i.editor} ${i.version}`).join(', ')}`
            : 'extension NOT installed in any VS Code-family editor',
          'acp: mercury acp',
        ].join(' · ')
        if (installed.length > 0) return { status: 'ok' as const, evidence }
        return {
          status: 'info' as const,
          evidence,
          fix: 'mercury bridge install (installs the extension from this build), then reload the editor window; any ACP editor runs mercury acp --stdio directly.',
        }
      },
    },
    {
      id: 'vulcan',
      label: 'Godot control (VULCAN)',
      run: async () => {
        const { vulcanEnabled, vulcanLiteMode } = await import('../../vulcan/vulcanGates.js')
        if (!vulcanEnabled()) {
          return {
            status: 'off' as const,
            evidence: 'MERCURY_GODOT_TOOLS unset — the Godot control surface is disabled (arm it in the boot menu, miscellaneous)',
          }
        }
        const { findGodotProjectRoot } = await import('../../../services/lsp/godotLane.js')
        const root = findGodotProjectRoot()
        let port = 0
        const lite = vulcanLiteMode() ? ' · lite subset' : ''
        if (!root) {
          return {
            status: 'info' as const,
            evidence: `armed (port ${port}${lite}) · no project.godot from cwd — the Godot tool stays out of the catalog here`,
          }
        }
        const { vulcanInstallStatus } = await import('../../../services/vulcan/addonInstaller.js')
        const { probeVulcanEditorPresence, presenceNudge } = await import('../../../services/vulcan/editorPresence.js')
        const s = vulcanInstallStatus(root)
        const presence = await probeVulcanEditorPresence(root)
        port = presence.port
        const { engineWorkerCount } = await import('../../../services/vulcan/engine/service.js')
        const engineWorkers = engineWorkerCount()
        const parts = [
          `project ${root}`,
          s.installed ? `addon installed${s.digestMatch ? '' : s.bundledFiles === 0 ? ' (dev bundle empty)' : ' (out of date — op:"vulcan_install" refreshes it)'}` : 'addon NOT installed',
          s.enabled ? 'addon enabled' : 'addon not enabled',
          presence.reachable ? `bridge up :${port}` : `${presence.words} (:${port} dark)`,
          `engine workers ${engineWorkers.count}${engineWorkers.source === 'flag' ? ' (MERCURY_GODOT_WORKERS)' : ''}`,
        ]
        if (!s.installed || !s.enabled || !presence.reachable) {
          return {
            status: 'warn' as const,
            evidence: parts.join(' · ') + lite,
            fix: presenceNudge(presence, s),
          }
        }
        return { status: 'ok' as const, evidence: parts.join(' · ') + lite }
      },
    },
    {
      id: 'substrate',
      label: 'Substrate & trace',
      run: () => {
        const s = substrateSnapshot()
        const trace = isInvocationTraceEnabled()
        if (s.state !== 'live') {
          return { status: 'unknown', evidence: s.reason ?? 'substrate gates unreadable' }
        }
        return {
          status: 'info',
          evidence: `${s.data.active}/${s.data.total} capabilities on · trace ${trace ? 'recording' : 'off'}`,
          link: trace ? '/trace' : '/capabilities',
        }
      },
    },
    {
      id: 'resources',
      label: 'Device headroom',
      run: async () => {
        const { availableB, source } = await deviceHeadroom()
        const cores = Math.max(1, cpus().length)
        const loadKnown = process.platform !== 'win32'
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
    },
    {
      id: 'box-lock',
      label: 'Box lock',
      run: async () => {
        const { boxLockDir, boxLockStateWords, readBoxLockState } = await import('../../boxLock.js')
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
    },
    {
      id: 'session-kind',
      label: 'Session kind',
      run: async () => {
        const { sessionKindWords } = await import('../../sessionKind.js')
        const { getFocusedSessionConnector, hasFocusedSession } = await import('../../../services/engine-connector/focusedConnector.js')
        if (!hasFocusedSession()) {
          return { status: 'info' as const, evidence: 'no session is focused here — a session is one of two kinds (oculus: a screen belongs to it; headless: unattended), read from its record when a chat is open and named on its own mercury://seat' }
        }
        const sessionId = getFocusedSessionConnector().sessionId()
        const { readSessionWorkers } = await import('../../../daemon/concourseWorkers.js')
        const record = Object.values(readSessionWorkers()).find(rec => rec.sessionId === sessionId && rec.endedAt === undefined)
        if (record === undefined) return { status: 'info' as const, evidence: 'the focused session has no record on the daemon (its kind is read from the record)' }
        if (record.kind === undefined) return { status: 'info' as const, evidence: 'the focused session carries no kind on its record: it runs headless until it is resumed from the screen' }
        return { status: 'info' as const, evidence: `the focused session is ${sessionKindWords(record.kind)}` }
      },
    },
  ]
}
