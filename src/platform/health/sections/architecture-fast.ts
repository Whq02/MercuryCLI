import type { CheckSpec } from '../healthReport.js'

async function settleToolList(): Promise<void> {
  await import('../../../tools/kit/toolList.js')
}

export function architectureFastChecks(): CheckSpec[] {
  return [
    {
      id: 'owner-vocabulary',
      label: 'Store owners',
      run: async () => {
        await settleToolList()
        const { ownerLifecycleCounts } = await import('../../../engine/run-owner/ownerLifecycle.js')
        const counts = ownerLifecycleCounts()
        const names = Object.keys(counts.stores)
        return {
          status: names.length >= 3 ? ('ok' as const) : ('warn' as const),
          evidence: `${names.length} owner-scoped store(s) on ONE disposal registry · ${counts.adhoc} ad-hoc disposer(s)`,
          ...(names.length < 3 ? { fix: 'Core stores failed to register — rebuild; report it if it persists.' } : {}),
        }
      },
    },
    {
      id: 'primitive-resources',
      label: 'Resource kinds',
      run: async () => {
        const { resourceAdapterKinds } = await import('../../../integrations/resources/registry.js')
        const kinds = (await resourceAdapterKinds()).map(k => k.kind)
        const wanted = ['owner', 'execution', 'transaction', 'evidence']
        const missing = wanted.filter(k => !kinds.includes(k))
        return {
          status: missing.length === 0 ? ('ok' as const) : ('fail' as const),
          evidence:
            missing.length === 0
              ? `owner · execution · transaction · evidence all registered (${kinds.length} kinds total)`
              : `missing primitive kind(s): ${missing.join(', ')}`,
          ...(missing.length > 0 ? { fix: 'The primitive adapters failed to register — rebuild; report it if it persists.' } : {}),
        }
      },
    },
    {
      id: 'execution-census',
      label: 'Execution domains',
      run: async () => {
        await settleToolList()
        const { executionDomainKinds, executionPlaneCounts } = await import(
          '../../../engine/execution-plane/executionPlane.js'
        )
        const { censusPlaneKinds } = await import('../../../engine/runtime-kernel/executionCensus.js')
        const registered = executionDomainKinds()
        const covered = censusPlaneKinds()
        const unclassified = registered.filter(k => !covered.includes(k))
        const counts = executionPlaneCounts()
        return {
          status: unclassified.length === 0 ? ('ok' as const) : ('fail' as const),
          evidence:
            unclassified.length === 0
              ? `${registered.length} domain(s) with hooks, all census-classified · ${counts.records} record(s), ${counts.live} live, ${counts.owners} owner(s)`
              : `UNCLASSIFIED execution domain(s): ${unclassified.join(', ')} — add census rows (executionCensus.ts)`,
          ...(unclassified.length > 0 ? { fix: 'A new execution domain is unclassified — report this.' } : {}),
        }
      },
    },
    {
      id: 'primitive-consistency',
      label: 'Record consistency',
      run: async () => {
        const { listExecutions } = await import('../../../engine/execution-plane/executionPlane.js')
        const { isTerminalExecutionState } = await import('../../../engine/execution-plane/execution.js')
        const { processMainOwner } = await import('../../../engine/run-owner/resolveOwner.js')
        const { transactionsFor } = await import('../../../engine/runtime-kernel/transactionPlane.js')
        const owner = processMainOwner()
        const records = listExecutions(owner, { limit: 500 })
        const inconsistent = records.filter(
          r =>
            (isTerminalExecutionState(r.state) && r.settledAt === undefined) ||
            (!isTerminalExecutionState(r.state) && r.settledAt !== undefined),
        )
        const orphanTxns = transactionsFor(owner).filter(
          t => ['applied', 'checking', 'verified'].includes(t.state) && !t.effectRef,
        )
        const ok = inconsistent.length === 0 && orphanTxns.length === 0
        return {
          status: ok ? ('ok' as const) : ('fail' as const),
          evidence: ok
            ? `no inconsistent state/settledAt pairs · no post-apply transaction without an effect ref (${records.length} execution(s) scanned)`
            : `${inconsistent.length} inconsistent execution(s), ${orphanTxns.length} effect-less applied transaction(s)`,
        }
      },
    },
    {
      id: 'view-coverage',
      label: 'View coverage',
      run: async () => {
        const { cardTone } = await import('../../../screen/widgets/toolCardGrammar.js')
        const { EXECUTION_STATES, TRANSACTION_STATES, executionCardState, transactionCardState } =
          await import('../../../engine/runtime-kernel/index.js')
        const fallback = cardTone('__unknown__')
        const unmapped = [
          ...EXECUTION_STATES.map(s => executionCardState(s)),
          ...TRANSACTION_STATES.map(s => transactionCardState(s)),
        ].filter(s => {
          const t = cardTone(s)
          return t.glyph === fallback.glyph && t.tone === fallback.tone
        })
        return {
          status: unmapped.length === 0 ? ('ok' as const) : ('fail' as const),
          evidence:
            unmapped.length === 0
              ? `every execution + transaction state maps onto the ONE card grammar`
              : `unmapped state(s): ${[...new Set(unmapped)].join(', ')} — extend toolCardGrammar`,
        }
      },
    },
    {
      id: 'runtime-kernel',
      label: 'Runtime kernel',
      run: async () => {
        const { runtimeKernel } = await import('../../../engine/runtime-kernel/runtimeKernel.js')
        const caps = runtimeKernel().capabilities()
        const provided = Object.entries(caps)
          .filter(([k, v]) => k !== 'notes' && v === true)
          .map(([k]) => k)
        return {
          status: 'ok' as const,
          evidence: `provided: ${provided.join(', ') || 'none'} (hash=${runtimeKernel().hash.id}) · absent capabilities name their owning facilities`,
        }
      },
    },
  ]
}
