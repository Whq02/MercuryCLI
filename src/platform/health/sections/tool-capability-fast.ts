import { getCwd } from '../../files/cwd.js'
import { skillsRefusedEvidence, type CheckSpec } from '../healthReport.js'

function skillsRefusedCheck(): CheckSpec {
  return {
    id: 'skills-refused',
    label: 'Skill files',
    run: () => skillsRefusedEvidence(getCwd()),
  }
}

async function settleCatalogueGates(): Promise<void> {
  const [{ settleDapAdapterProbes }, { primeEvalAvailability }] = await Promise.all([import('../../../integrations/debugger/dapClient.js'), import('../../../tools/engines/eval-kernels/interpreters.js')])
  await Promise.all([settleDapAdapterProbes(), primeEvalAvailability(getCwd())])
}

export function toolCapabilityFastChecks(): CheckSpec[] {
  return [
    skillsRefusedCheck(),
    {
      id: 'capability-census',
      label: 'Capability census',
      run: async () => {
        const { buildToolCensus, censusGapLines, CENSUS_NO_REASON, CENSUS_VERSION } = await import('../../../permissions/capability-census/census.js')
        await settleCatalogueGates()
        const c = buildToolCensus()
        const s = c.summary
        const undeclared = c.rows.filter(r => r.declared === null).map(r => r.name)
        const gaps = censusGapLines(c)
        const reasonless = gaps.filter(g => g.reason === CENSUS_NO_REASON).flatMap(g => g.tools)
        const detail = gaps
          .map(g => `${g.support === 'conditional' ? 'conditional' : 'off'} · ${g.tools.join(', ')} — ${g.reason}`)
          .join('\n')
        const status =
          undeclared.length > 0 || s.unclassified.length > 0 ? ('fail' as const) : reasonless.length > 0 ? ('warn' as const) : ('ok' as const)
        return {
          status,
          evidence:
            `census v${CENSUS_VERSION} · ${s.tools} tool(s): ${s.bySupport.available} available · ` +
            `${s.bySupport.conditional} conditional · ${s.bySupport.unavailable} unavailable · ` +
            `${s.operations} operation(s)` +
            (undeclared.length > 0 ? ` · UNDECLARED: ${undeclared.join(', ')}` : '') +
            (s.unclassified.length > 0 ? ` · UNCLASSIFIED: ${s.unclassified.join(', ')}` : '') +
            (reasonless.length > 0 ? ` · NO REASON DECLARED: ${reasonless.join(', ')}` : ''),
          ...(detail.length > 0 ? { detail } : {}),
          ...(undeclared.length + s.unclassified.length + reasonless.length > 0
            ? { fix: 'Declare the tool’s capability contract (gate/conditions for a gated tool).' }
            : {}),
        }
      },
    },
    {
      id: 'tools-withheld',
      label: 'Tools withheld',
      run: async () => {
        const [{ withheldTools, withheldToolsLine }, { settleDapAdapterProbes }] = await Promise.all([import('../../../engine/tool-dispatch/withheldTools.js'), import('../../../integrations/debugger/dapClient.js')])
        await settleDapAdapterProbes()
        const list = withheldTools()
        if (list.length === 0) return { status: 'ok' as const, evidence: withheldToolsLine(list) }
        const remedies = list.filter(w => w.remedy !== undefined).map(w => `${w.tool}: ${w.remedy}`)
        return {
          status: 'info' as const,
          evidence: withheldToolsLine(list),
          detail: list.map(w => `${w.tool} — needs ${w.dependency}: ${w.why}`).join('\n'),
          ...(remedies.length > 0 ? { fix: remedies.join(' · ') } : {}),
        }
      },
    },
    {
      id: 'capability-integrations',
      label: 'Lifecycle integrations',
      run: async () => {
        const { buildToolCensus } = await import('../../../permissions/capability-census/census.js')
        await settleCatalogueGates()
        const s = buildToolCensus().summary
        return {
          status: 'ok' as const,
          evidence:
            `${s.withTransactionIntegration} declare transactions · ${s.withExecutionIntegration} declare executions · ` +
            `${s.withResourceOutputs} declare mercury:// outputs · ${s.withProof} name a focused proof · ` +
            `units covered: ${s.unitsCovered.length}`,
        }
      },
    },
    {
      id: 'capability-search',
      label: 'Capability search',
      run: async () => {
        const { getAllBaseTools } = await import('../../../tools/kit/toolList.js')
        const { searchToolsWithKeywords } = await import('../../../tools/tool-search/ToolSearchTool.js')
        await settleCatalogueGates()
        const tools = getAllBaseTools()
        const deferred = tools.filter(t => t.shouldDefer === true)
        if (!tools.some(t => t.name === 'Git')) {
          return {
            status: 'off' as const,
            evidence:
              'Git work-graph tool not registered (MERCURY_GIT_GRAPH off) — the intent probe has no target',
          }
        }
        const hits = await searchToolsWithKeywords('split changes into atomic commits', deferred, tools, 3)
        return {
          status: hits[0] === 'Git' ? ('ok' as const) : ('fail' as const),
          evidence:
            hits[0] === 'Git'
              ? `intent index live — 'split changes into atomic commits' → ${hits.join(' · ')} (${deferred.length} deferred)`
              : `intent ranking broke: got ${hits.join(' · ') || '(none)'} — expected Git first`,
          ...(hits[0] !== 'Git' ? { fix: 'Capability search ranked an unexpected tool first — report this.' } : {}),
        }
      },
    },
  ]
}
