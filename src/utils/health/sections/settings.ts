import { FLAG_REGISTRY, flagEnv } from '../../../substrate/flagRegistry.js'
import { realEnvPin } from '../../../substrate/startupMenu.js'
import { getCwd } from '../../cwd.js'
import { listCapabilityKills } from '../../permissions/capabilityGate.js'
import { getEngineModel, getUserSpecifiedModelSetting, parseUserSpecifiedModel, renderModelChip } from '../../model/model.js'
import { describeFrontierDecision, frontierOperatorDecision } from '../../model/frontierPolicy.js'
import { CHOOSE_A_MODEL_WORDS, computedDefault, describeComputedDefault, isChooseAModel } from '../../model/computedDefault.js'
import { providerDisplayName } from '../../../services/providers/routeLaw.js'
import { getInstructionBundle, getInstructionCompositionState } from '../../../services/instructions/engine.js'
import { sharedSourcesNote } from '../../../services/instructions/listing.js'
import { readPromptProvenance } from '../../cockpit/promptProvenance.js'
import { getSettingsWithAllErrors } from '../../settings/allErrors.js'
import { currentHiddenCharacterFindings, hiddenCharacterDetailLines, hiddenCharacterScanCounts } from '../../text/hiddenCharacterFindings.js'
import { summarizeHiddenCodePoints } from '../../text/hiddenCodePoints.js'
import { getEnabledSettingSources } from '../../settings/constants.js'
import { getSettingsForSource } from '../../settings/settings.js'
import { recognizeModelId, unrecognisedModelIdReason } from '../../../services/providers/idSpaces.js'
import { SHELL_READS, unresolvedDefaultRow, relativeToCwd, flagAsSet, type CheckSpec } from '../../healthReport.js'

export function settingsChecks(): CheckSpec[] {
  return [
    {
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
    },
    {
      id: 'settings',
      label: 'Settings',
      run: () => {
        const { errors } = getSettingsWithAllErrors()
        let sourcesLine = 'sources unreadable'
        try {
          sourcesLine = `sources: ${getEnabledSettingSources().join(' + ')}`
        } catch {
        }
        let lockLine = ''
        try {
          const lock = getSettingsForSource('policySettings')?.extensions?.exclusive
          if (lock === true) lockLine = ' · managed extension-only lock: ALL surfaces'
          else if (Array.isArray(lock) && lock.length > 0) lockLine = ` · managed extension-only lock: ${lock.join(', ')}`
        } catch {
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
    },
    {
      id: 'env-limits',
      label: 'Env output limits',
      run: async () => {
        const { validateBoundedIntEnvVar } = await import('../../envValidation.js')
        const { BASH_MAX_OUTPUT_DEFAULT, BASH_MAX_OUTPUT_UPPER_LIMIT, SHELL_MAX_OUTPUT_ENV } = await SHELL_READS.outputLimits()
        const rows: Array<[string, number, number]> = [
          [SHELL_MAX_OUTPUT_ENV, BASH_MAX_OUTPUT_DEFAULT, BASH_MAX_OUTPUT_UPPER_LIMIT],
        ]
        const findings: string[] = []
        for (const [name, def, cap] of rows) {
          const r = validateBoundedIntEnvVar(name, process.env[name], def, cap)
          if (r.status !== 'valid' && r.message) findings.push(`${name}: ${r.message}`)
        }
        if (findings.length === 0) {
          return { status: 'ok', evidence: 'output-limit env rows unset or within bounds' }
        }
        return { status: 'warn', evidence: findings.join(' · ').slice(0, 200) }
      },
    },
    {
      id: 'keybindings',
      label: 'Keybindings',
      run: async () => {
        const { loadKeybindingsSyncWithWarnings } = await import('../../../keybindings/loadUserBindings.js')
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
    },
    {
      id: 'model',
      label: 'Model pins',
      run: () => {
        const session = getEngineModel()
        let pin: string | undefined
        try {
          pin = getSettingsWithAllErrors().settings.engine?.model
        } catch {
          pin = undefined
        }
        if (!isChooseAModel(session) && recognizeModelId(session).kind === 'unrecognised') {
          return {
            status: 'warn',
            evidence: `session model ${session}${pin && pin !== session ? ` · settings pin ${pin}` : ''} — ${unrecognisedModelIdReason(session)}`,
            fix: 'No connected provider family declares this model id. Pick a model from /model, or route it through a custom endpoint that knows the id.',
          }
        }
        if (!pin) {
          return { status: 'ok', evidence: `session model ${unresolvedDefaultRow() ?? (isChooseAModel(session) ? CHOOSE_A_MODEL_WORDS : session)} · no settings pin` }
        }
        let pinResolved = pin
        try {
          pinResolved = parseUserSpecifiedModel(pin)
        } catch {
        }
        if (pinResolved === session) {
          return {
            status: 'ok',
            evidence:
              pin === session
                ? `session model ${session} = settings pin`
                : `session model ${session} = settings pin '${pin}' (resolved)`,
          }
        }
        return {
          status: 'info',
          evidence: `session model ${session} · settings pin ${pin}${pinResolved !== pin ? ` (resolves to ${pinResolved})` : ''} — the live session overrides the pin`,
          detail:
            'The settings pin is not the live session model — crewmates inherit the session. Pass model: explicitly where drift matters.',
        }
      },
    },
    {
      id: 'frontier',
      label: 'Default model',
      run: () => {
        const decision = computedDefault()
        const firstParty = frontierOperatorDecision()
        const order = firstParty.candidates
          .map(c => `${c.family}@${c.rank} ${c.eligible ? 'eligible' : c.code}`)
          .join(' · ')
        const computed =
          decision.source === 'keyless'
            ? describeComputedDefault(decision, providerDisplayName)
            : `fresh-session default ${renderModelChip(decision.setting)} · ${describeComputedDefault(decision, providerDisplayName)}`
        const pinned = getUserSpecifiedModelSetting()
        const { disabledProvidersHealthSummary } = require('../../../services/providers/disabledProviders.js') as typeof import('../../../services/providers/disabledProviders.js')
        const disabledNote = disabledProvidersHealthSummary()?.evidence
        const suffix = disabledNote ? ` · ${disabledNote}` : ''
        if (pinned !== null) {
          let resolved = pinned
          try {
            resolved = parseUserSpecifiedModel(pinned)
          } catch {
            resolved = pinned
          }
          const { getEngineModelOverride } = require('../../../bootstrap/state.js') as typeof import('../../../bootstrap/state.js')
          const pinSource = getEngineModelOverride() !== undefined ? 'the --model flag' : flagEnv('MERCURY_MODEL') ? 'MERCURY_MODEL' : 'the settings pin engine.model'
          return {
            status: 'info' as const,
            evidence: `fresh-session default ${renderModelChip(resolved)} · ${pinSource}${resolved !== pinned ? ` '${pinned}' (resolved)` : ''} — without the pin: ${computed.replace(/^fresh-session default /, '')}${suffix}`,
            detail: `first-party gating: ${describeFrontierDecision(firstParty)} — candidates: ${order}`,
            link: '/model',
          }
        }
        return {
          status: 'info' as const,
          evidence: `${computed}${suffix}`,
          detail: `first-party gating: ${describeFrontierDecision(firstParty)} — candidates: ${order}`,
          link: '/model',
        }
      },
    },
    {
      id: 'instruction-profile',
      label: 'Instruction profile',
      run: async () => {
        const bundle = await getInstructionBundle()
        const { resolution, adapterId, skippedDuplicates, diagnostics, loadReason } =
          getInstructionCompositionState()
        const requested = `${resolution.requested}${
          resolution.requestedOrigin === 'default'
            ? ''
            : ` (${resolution.requestedOrigin})`
        }`
        const nativeCount = bundle.entries.filter(
          e => e.family === 'native',
        ).length
        const actionableDiagnostics = diagnostics.filter(
          d => d.kind !== 'duplicate-content',
        )
        const notes = [
          sharedSourcesNote(bundle.entries),
          skippedDuplicates.length > 0
            ? `${skippedDuplicates.length} identical-content duplicate(s) skipped`
            : null,
          ...actionableDiagnostics.map(
            d => `${d.kind}: ${d.path}${d.parent ? ` (from ${d.parent})` : ''}`,
          ),
        ].filter(Boolean)
        return {
          status: actionableDiagnostics.length > 0
            ? ('warn' as const)
            : ('info' as const),
          evidence:
            `requested ${requested} → resolved ${resolution.resolved} ` +
            `(${adapterId} adapter) · ${bundle.entries.length} source(s)` +
            `${nativeCount > 0 ? ` (${nativeCount} native)` : ''} · ` +
            `digest ${bundle.bundleDigest.slice(0, 12)} · ` +
            `last reload: ${loadReason}` +
            (notes.length > 0 ? ` · ${notes.join(' · ')}` : ''),
          link: '/memory',
        }
      },
    },
    {
      id: 'hidden-characters',
      label: 'Hidden characters',
      run: async () => {
        await getInstructionBundle()
        const skills = require('../../../skills/loadSkillsDir.js') as typeof import('../../../skills/loadSkillsDir.js')
        await skills.getSkillDirCommands(getCwd()).catch(() => [])
        getSettingsWithAllErrors()
        const counts = hiddenCharacterScanCounts()
        const scanned =
          `${counts.instruction} instruction file(s) · ${counts.skill} skill(s) · ${counts.settings} settings file(s) read as written` +
          ` · ${counts.mcp} MCP tool definition(s) stripped at discovery`
        const found = currentHiddenCharacterFindings()
        if (found.length === 0) {
          return { status: 'ok' as const, evidence: `no hidden characters · ${scanned}` }
        }
        const cwd = getCwd()
        const characters = found.reduce((n, record) => n + record.findings.length, 0)
        const files = found.filter(record => record.source !== 'mcp')
        const mcpRead = found.some(record => record.source === 'mcp' && !record.removed)
        const named = found
          .map(record =>
            record.source === 'mcp'
              ? `MCP tool ${record.path} (${summarizeHiddenCodePoints(record.findings)}${record.removed ? ', removed before the model read it' : ''})`
              : `${relativeToCwd(cwd, record.path)} line ${record.findings[0]!.line} (${summarizeHiddenCodePoints(record.findings)})`,
          )
          .join(' · ')
        return {
          status: 'warn' as const,
          evidence: `${characters} hidden character${characters === 1 ? '' : 's'} in ${found.length} place${found.length === 1 ? '' : 's'} — ${named} · ${scanned}`,
          detail: found.flatMap(hiddenCharacterDetailLines).join('\n'),
          fix:
            files.length > 0
              ? 'Open each named line in an editor that shows invisible characters and delete what you did not write; a direction override or zero-width character in an instruction file is read by the model and seen by nobody. Mercury loaded the files as written and changed nothing.'
              : `The MCP server sent hidden characters in a tool definition; consider whether you trust that server. ${mcpRead ? 'Variation selectors survive the discovery strip, so the model reads them as sent.' : 'Mercury stripped them before the model read the definition.'}`,
        }
      },
    },
    {
      id: 'request-context',
      label: 'Request context',
      run: async () => {
        const provenance = readPromptProvenance()
        const bundle = await getInstructionBundle()
        const instructionChars = bundle.entries.reduce(
          (a, e) => a + e.contentLength,
          0,
        )
        if (provenance === null) {
          return {
            status: 'info' as const,
            evidence:
              `no composition recorded yet this session · instructions ` +
              `${bundle.entries.length} source(s) · ${instructionChars} chars`,
          }
        }
        const OVERSIZED_SECTION_CHARS = 20_000
        const oversized = provenance.sections.filter(
          se => se.cacheClass !== 'turn' && se.chars > OVERSIZED_SECTION_CHARS,
        )
        const dupNames = new Map<string, number>()
        for (const se of provenance.sections) {
          dupNames.set(se.name, (dupNames.get(se.name) ?? 0) + 1)
        }
        const duplicated = [...dupNames.entries()].filter(([, n]) => n > 1)
        const top = [...provenance.sections]
          .sort((a, b) => b.chars - a.chars)
          .slice(0, 3)
          .map(se => `${se.name} ${se.chars}`)
          .join(' · ')
        const notes = [
          ...oversized.map(
            se => `oversized always-loaded section ${se.name} (${se.chars} chars — owner ${se.owner})`,
          ),
          ...duplicated.map(([name, n]) => `duplicate section name ${name} ×${n}`),
          provenance.absent.length > 0
            ? `${provenance.absent.length} registry section(s) absent (composed away)`
            : null,
        ].filter(Boolean)
        return {
          status: oversized.length > 0 || duplicated.length > 0
            ? ('warn' as const)
            : ('info' as const),
          evidence:
            `system prompt ${provenance.totalChars} chars / ${provenance.segmentCount} segments ` +
            `(digest ${provenance.digest}) · instructions ${instructionChars} chars / ` +
            `${bundle.entries.length} source(s) · top: ${top}` +
            (notes.length > 0 ? ` · ${notes.join(' · ')}` : ''),
        }
      },
    },
    {
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
    },
    {
      id: 'kills',
      label: 'Killed tools',
      run: async () => {
        const kills = listCapabilityKills()
        const flat: string[] = []
        let unmatched = 0
        let builtinNamesFolded: Set<string> | null = null
        try {
          const { getAllBaseTools } = await import('../../../tools.js')
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
        let capRejects: string[] = []
        try {
          const { getAgentCapParseRejects } = await import('../../permissions/capabilityGate.js')
          capRejects = getAgentCapParseRejects()
        } catch {
          capRejects = []
        }
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
    },
    {
      id: 'wards',
      label: 'Content wards',
      run: async () => {
        const { wardsEnabled, loadProjectWardsWithReport } = await import('../../../guards/wardsGuard.js')
        const { BUILTIN_WARDS } = await import('../../wards/wards.js')
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
    },
    {
      id: 'memory-lifecycle',
      label: 'Memory lifecycle',
      run: async () => {
        const { mnemeEnabled } = await import('../../../mneme/mnemeGates.js')
        if (!mnemeEnabled()) {
          return {
            status: 'off' as const,
            evidence: 'memory is off (memory.enabled is false in settings) — nothing saved or recalled this session',
          }
        }
        const { mnemeStatus } = await import('../../../mneme/mnemeMaintenance.js')
        const st = mnemeStatus()
        const evidence = [
          `memory: ${st.entryCount} current · ${st.buffered + st.pendingConsuming} recent · ${st.historyCount} history · ${st.topicCount} topics`,
          st.running ? 'maintenance running' : st.due ? `maintenance DUE (${st.dueReason})` : 'maintenance idle',
          st.lastConsolidatedAt ? `last ${st.lastConsolidatedAt.slice(0, 16)}` : 'never consolidated',
        ].join(' · ')
        if (st.degraded.length > 0) {
          return {
            status: 'warn' as const,
            evidence,
            detail: st.degraded.join(' · '),
            fix: 'Run maintenance from /memory (the maintenance row) — it reaps dead locks and recovers stranded observations.',
          }
        }
        return { status: 'ok' as const, evidence }
      },
    },
  ]
}
