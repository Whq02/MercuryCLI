import { isInvocationTraceEnabled } from '../../../observability/invocationTrace.js'
import { mcpGauge } from '../../../../screen/cockpit-gauges/mcpGauge.js'
import { substrateSnapshot } from '../../../../screen/cockpit-gauges/substrateSnapshot.js'
import { describeUntrustedMcpHardening, getMcpPolicyRejects } from '../../../../integrations/mcp-shapes/toolPolicy.js'
import { summarizeMcpAuthCurrency } from '../../../../integrations/mcp/auth.js'
import { describeMcpProtocolCurrency } from '../../../../integrations/mcp/protocolRevision.js'
import { extensionsHealthRow } from '../../../../integrations/extensions/boot.js'
import { healthFixEnabled } from '../../healthFix.js'
import { flagAsSet, type CheckSpec } from '../../healthReport.js'

export function evalKernelsCheck(): CheckSpec {
  return {
    id: 'eval-kernels',
    label: 'Eval languages',
    run: async () => {
      const { evalEnabled } = await import('../../../../tools/engines/eval-kernels/contracts.js')
      const { primeEvalAvailability } = await import('../../../../tools/engines/eval-kernels/interpreters.js')
      const { getCwd } = await import('../../../files/cwd.js')
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
  }
}

export function mcpCheck(): CheckSpec {
  return {
    id: 'mcp',
    label: 'MCP policy',
    run: () => {
      const mcp = mcpGauge()
      const policyDesc = mcp.data.mcpPolicyHint
      const policyActive = mcp.data.mcpPolicyActive
      const policyRejects = getMcpPolicyRejects()
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
  }
}

export function extensionsCheck(): CheckSpec {
  return {
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
                    const { uninstall } = await import('../../../../integrations/extensions/install.js')
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
  }
}

export function mediaCheck(): CheckSpec {
  return {
    id: 'media',
    label: 'Local media',
    run: async () => (await import('../../../../integrations/media/settings.js')).mediaHealth(),
  }
}

export function vulcanCheck(): CheckSpec {
  return {
    id: 'vulcan',
    label: 'Godot control (VULCAN)',
    run: async () => {
      const { vulcanEnabled, vulcanLiteMode } = await import('../../../../integrations/vulcan/vulcanGates.js')
      if (!vulcanEnabled()) {
        return {
          status: 'off' as const,
          evidence: 'MERCURY_GODOT_TOOLS unset — the Godot control surface is disabled (arm it in the boot menu, miscellaneous)',
        }
      }
      const { findGodotProjectRoot } = await import('../../../../integrations/lsp/godotLane.js')
      const root = findGodotProjectRoot()
      let port = 0
      const lite = vulcanLiteMode() ? ' · lite subset' : ''
      if (!root) {
        return {
          status: 'info' as const,
          evidence: `armed (port ${port}${lite}) · no project.godot from cwd — the Godot tool stays out of the catalog here`,
        }
      }
      const { vulcanInstallStatus } = await import('../../../../integrations/vulcan/addonInstaller.js')
      const { probeVulcanEditorPresence, presenceNudge } = await import('../../../../integrations/vulcan/editorPresence.js')
      const s = vulcanInstallStatus(root)
      const presence = await probeVulcanEditorPresence(root)
      port = presence.port
      const { engineWorkerCount } = await import('../../../../integrations/vulcan/engine/service.js')
      const engineWorkers = engineWorkerCount()
      const parts = [
        `project ${root}`,
        s.installed ? `addon installed${s.digestMatch ? '' : s.bundledFiles === 0 ? ' (dev bundle empty)' : ' (out of date — op:"vulcan_install" refreshes it)'}` : 'addon NOT installed',
        s.projectReadError ? `project.godot could not be read (${s.projectReadError})` : s.enabled ? 'addon enabled' : 'addon not enabled',
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
  }
}

export function substrateCheck(): CheckSpec {
  return {
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
  }
}
