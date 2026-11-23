import { FLAG_REGISTRY, flagEnv } from '../../../substrate/flagRegistry.js'
import { realEnvPin } from '../../../substrate/startupMenu.js'
import { getCwd } from '../../../files/cwd.js'
import { errorMessage } from '../../../errors/errors.js'
import { getAgentCapParseRejects, listCapabilityKills } from '../../../../permissions/rules/capabilityGate.js'
import { getSettingsWithAllErrors } from '../../../settings-faults/allErrors.js'
import { getEnabledSettingSources } from '../../../settings/settingSources.js'
import { getSettingsForSource } from '../../../settings/settings.js'
import { SHELL_READS, flagAsSet, type CheckSpec } from '../../healthReport.js'
import { passedOver } from '../../../errors/passedOver.js'

export function managedPolicyCheck(): CheckSpec {
  return {
    id: 'managed-policy',
    label: 'Managed policy',
    run: async () => {
      const { detectManagedSettingsWarnings, managedPolicyPath, managedPolicyPresent } = await import('../../healthDiagnostic.js')
      const warnings = detectManagedSettingsWarnings()
      if (warnings.length > 0) {
        return { status: 'warn', evidence: warnings.map(w => w.issue).join(' · '), fix: warnings.map(w => w.fix).join('\n') }
      }
      const policy = managedPolicyPath()
      return managedPolicyPresent()
        ? { status: 'ok', evidence: `managed policy at ${policy} read clean` }
        : { status: 'info', evidence: `no managed policy (nothing at ${policy})` }
    },
  }
}

export function settingsCheck(): CheckSpec {
  return {
    id: 'settings',
    label: 'Settings',
    run: () => {
      const { errors } = getSettingsWithAllErrors()
      let sourcesLine = 'sources unreadable'
      try {
        sourcesLine = `sources: ${getEnabledSettingSources().join(' + ')}`
      } catch (error) {
        passedOver(error)
      }
      let lockLine = ''
      try {
        const lock = getSettingsForSource('policySettings')?.extensions?.exclusive
        if (lock === true) lockLine = ' · managed extension-only lock: ALL surfaces'
        else if (Array.isArray(lock) && lock.length > 0) lockLine = ` · managed extension-only lock: ${lock.join(', ')}`
      } catch (error) {
        lockLine = ` · managed extension-only lock unreadable (${errorMessage(error)})`
      }
      if (errors.length === 0) {
        return {
          status: 'ok',
          evidence: `${sourcesLine}${lockLine} · 0 validation errors (getSettingsWithAllErrors)`,
        }
      }
      const first = errors[0]
      const firstLine = first
        ? [first.file, first.path, first.message].filter(Boolean).join(' · ')
        : 'unreadable'
      return {
        status: 'warn',
        evidence: `${errors.length} settings validation error(s) — first: ${firstLine.slice(0, 120)}`,
        fix: 'Fix the named settings file; run /health again for the refreshed list.',
      }
    },
  }
}

export function envLimitsCheck(): CheckSpec {
  return {
    id: 'env-limits',
    label: 'Env output limits',
    run: async () => {
      const { validateBoundedIntEnvVar } = await import('../../../environment/envValidation.js')
      const { BASH_MAX_OUTPUT_DEFAULT, BASH_MAX_OUTPUT_UPPER_LIMIT, SHELL_MAX_OUTPUT_ENV } = await SHELL_READS.outputLimits()
      const rows: Array<[string, number, number]> = [
        [SHELL_MAX_OUTPUT_ENV, BASH_MAX_OUTPUT_DEFAULT, BASH_MAX_OUTPUT_UPPER_LIMIT],
      ]
      const findings: string[] = []
      for (const [name, def, cap] of rows) {
        const r = validateBoundedIntEnvVar(name, flagEnv(name), def, cap)
        if (r.status !== 'valid' && r.message) findings.push(`${name}: ${r.message}`)
      }
      if (findings.length === 0) {
        return { status: 'ok', evidence: 'output-limit env rows unset or within bounds' }
      }
      return { status: 'warn', evidence: findings.join(' · ').slice(0, 200) }
    },
  }
}

export function keybindingsCheck(): CheckSpec {
  return {
    id: 'keybindings',
    label: 'Keybindings',
    run: async () => {
      const { loadKeybindingsSyncWithWarnings } = await import('../../../../screen/keys/loadUserBindings.js')
      const warnings = loadKeybindingsSyncWithWarnings().warnings
      if (warnings.length === 0) {
        return { status: 'ok', evidence: 'no keybinding-file warnings this session' }
      }
      return {
        status: 'warn',
        evidence: `${warnings.length} keybinding warning(s) — first: ${String(
          (warnings[0] as { message?: string })?.message ?? 'unreadable',
        ).slice(0, 140)}`,
        fix: 'Fix the named binding in the keybindings settings file.',
      }
    },
  }
}

export function flagsCheck(): CheckSpec {
  return {
    id: 'flags',
    label: 'Env overrides',
    run: () => {
      const present = FLAG_REGISTRY.filter(f => flagEnv(f.env) !== undefined)
      const set = present.filter(f => f.selfStamped !== true)
      const stamped = present.filter(f => f.selfStamped === true)
      const overrides = set.filter(f => realEnvPin(f.env) !== null)
      const bootApplied = set.filter(f => realEnvPin(f.env) === null)
      const shortValue = (f: { env: string }): string => `${f.env}=${String(flagEnv(f.env)).slice(0, 12)}`
      const stampNote =
        (stamped.length > 0 ? ` · self-stamped (not an override): ${stamped.map(shortValue).join(', ')}` : '') +
        (bootApplied.length > 0 ? ` · saved boot defaults (boot-env.json, not an override): ${bootApplied.map(shortValue).join(', ')}` : '')
      if (overrides.length === 0) {
        return {
          status: 'ok',
          evidence: `no env overrides — all ${FLAG_REGISTRY.length} registered flags at their defaults${stampNote}`,
        }
      }
      const show = overrides
        .slice(0, 4)
        .map(f => {
          const value = String(flagEnv(f.env))
          return `${f.env}=${value.length > 12 ? `${value.slice(0, 12)}…` : value}`
        })
        .join(', ')
      return {
        status: 'info',
        evidence: `${overrides.length} flag(s) overridden in env: ${show}${overrides.length > 4 ? ` … +${overrides.length - 4} more` : ''}${stampNote}`,
        detail: overrides.map(f => `${f.env}=${String(flagEnv(f.env)).slice(0, 40)} (${f.kind})`).join(' · '),
        link: '/capabilities',
      }
    },
  }
}

export function killsCheck(): CheckSpec {
  return {
    id: 'kills',
    label: 'Killed tools',
    run: async () => {
      const kills = listCapabilityKills()
      const flat: string[] = []
      let unmatched = 0
      let builtinNamesFolded: Set<string> | null = null
      try {
        const { getAllBaseTools } = await import('../../../../tools/kit/toolList.js')
        builtinNamesFolded = new Set(
          getAllBaseTools().flatMap(t => [t.name, ...(t.aliases ?? [])]).map(n => n.toLowerCase()),
        )
      } catch {
        builtinNamesFolded = null
      }
      for (const [agent, tools] of Object.entries(kills)) {
        for (const tool of tools) {
          const spelled = agent === '*' || agent === '' ? tool : `${agent}:${tool}`
          const isWild = tool === '*'
          const isMcpShaped = tool.startsWith('mcp__')
          if (!isWild && !isMcpShaped && builtinNamesFolded && !builtinNamesFolded.has(tool.toLowerCase())) {
            unmatched++
            flat.push(`${spelled} (no such builtin — read as an MCP server name)`)
          } else {
            flat.push(spelled)
          }
        }
      }
      const capRejects = getAgentCapParseRejects()
      const capClause =
        capRejects.length > 0
          ? ` · agent-cap posture: ${capRejects.length} unreadable part(s) FAIL CLOSED at max-risk=low (${capRejects.slice(0, 3).map(t => JSON.stringify(t)).join(', ')}${capRejects.length > 3 ? '…' : ''})`
          : ''
      const capFix =
        'MERCURY_AGENT_CAP carries part(s) the parser cannot read; each clamps its agent to max-risk=low until fixed. Grammar: agent:max-risk=low|medium|high or agent:deny-cat=exec,net — semicolon-separated.'
      if (flat.length === 0) {
        if (capRejects.length > 0) {
          return {
            status: 'warn',
            evidence: `no tools killed (capabilityGate registry empty)${capClause}`,
            fix: capFix,
          }
        }
        return { status: 'ok', evidence: 'no tools killed (capabilityGate registry empty)' }
      }
      return {
        status: unmatched > 0 || capRejects.length > 0 ? 'warn' : 'info',
        evidence: `${flat.length} killed: ${flat.slice(0, 4).join(', ')}${flat.length > 4 ? '…' : ''}${capClause}`,
        fix:
          unmatched > 0
            ? 'Operator-armed — clear MERCURY_KILL to restore the listed tools. An entry marked "no such builtin" kills a builtin only if spelled like its name; scope a server kill unambiguously as mcp__<server>.'
            : capRejects.length > 0
              ? capFix
              : 'Operator-armed — clear MERCURY_KILL to restore the listed tools.',
      }
    },
  }
}

export function wardsCheck(): CheckSpec {
  return {
    id: 'wards',
    label: 'Content wards',
    run: async () => {
      const { wardsEnabled, loadProjectWardsWithReport } = await import('../../../../permissions/guards/wardsGuard.js')
      const { BUILTIN_WARDS } = await import('../../../../permissions/wards/wards.js')
      if (!wardsEnabled()) {
        return { status: 'off', evidence: `${flagAsSet('MERCURY_WARDS')} set — content wards off for this session` }
      }
      const report = loadProjectWardsWithReport(getCwd())
      const evidence = `builtin ${BUILTIN_WARDS.length} · project ${report.rules.length} rule(s)${
        report.problems.length > 0
          ? ` · ${report.problems.length} problem(s): ${report.problems.slice(0, 3).join(' | ')}${report.problems.length > 3 ? '…' : ''}`
          : ''
      }`
      if (report.problems.length > 0) {
        return {
          status: 'warn',
          evidence,
          fix: 'Fix the named entries in .mercury/wards.json — a dropped rule guards nothing, and a salvaged one may not match what you meant. Grammar: [{name, teach, scope: edit|bash, patterns: [regex…], flags?}].',
        }
      }
      return { status: 'ok', evidence }
    },
  }
}
