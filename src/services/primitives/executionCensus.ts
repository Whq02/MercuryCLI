// ============================================================================
//  primitives/executionCensus — the machine-checkable running-work census
//
//
//  Every Mercury domain that materially represents running work is
//  classified here; scripts/primitives-kernel/prove-primitives-kernel-census.ts fails the gate when
//  a task type, execution kind, or registered execution domain appears
//  without a census row — a new long-running production domain cannot land
//  unclassified.
//
//  Classifications:
//    · full-execution-owner — the domain registers/settles its own plane
//      records and provides reconcile/stop truth;
//    · child-execution      — represented under a parent execution,
//      projected on read (no standing plane records);
//    · external-projection  — an existing system mirrors its state through
//      projectExternalState at its own chokepoints;
//    · documented-exclusion — deliberately NOT on the plane; the note says
//      why and where its truth lives.
// ============================================================================

export type ExecutionDomainClassification =
  | 'full-execution-owner'
  | 'child-execution'
  | 'external-projection'
  | 'documented-exclusion'

export interface ExecutionDomainCensusEntry {
  domain: string
  classification: ExecutionDomainClassification
  /** The plane kind, for classifications that put records on the plane. */
  kind?: string
  adapter: string
  owner: string
  resourceKind?: string
  notes: string
}

export const EXECUTION_DOMAIN_CENSUS: readonly ExecutionDomainCensusEntry[] = [
  {
    domain: 'service',
    classification: 'full-execution-owner',
    kind: 'service',
    adapter: 'src/services/projectServices/executionProjection.ts (writeRecord chokepoint)',
    owner: 'projectOwner(cwd) — project-scoped by design (Δ7)',
    resourceKind: 'service',
    notes:
      'ServiceRecord stays domain truth (readiness, restart, cursors, stop ladder); reconcile = pid+startToken; plane stop drives the real ladder.',
  },
  {
    domain: 'workshop-js',
    classification: 'full-execution-owner',
    kind: 'workshop-js',
    adapter: 'src/services/workshop/executionProjection.ts (spawn/kill/cell seams)',
    owner: 'conversation OwnerKey',
    resourceKind: 'workshop',
    notes:
      'Runtime = execution; cells = ready ⇄ running transitions + bounded ring (Δ2); ts cells share the js lane kind.',
  },
  {
    domain: 'workshop-python',
    classification: 'full-execution-owner',
    kind: 'workshop-python',
    adapter: 'src/services/workshop/executionProjection.ts (+ pythonRuntime seams)',
    owner: 'conversation OwnerKey',
    resourceKind: 'workshop',
    notes:
      'Interrupt-first cancellation stays domain-owned; missing interpreter settles honest unavailable.',
  },
  {
    domain: 'eval-kernel',
    classification: 'child-execution',
    kind: 'eval-kernel',
    adapter: 'src/services/eval/kernelManager.ts (spawn/interrupt/dispose seams)',
    owner: 'conversation OwnerKey (per language + cwd + interpreter)',
    notes:
      'Retained Python/JS kernels are children of the session process and die with it; lifecycle rows ride the eval operation journal (orphan recovery), not standing plane records.',
  },
  {
    domain: 'journey',
    classification: 'full-execution-owner',
    kind: 'journey',
    adapter: 'src/services/journeys/runner.ts (register/settle + domain hooks)',
    owner: 'conversation OwnerKey',
    resourceKind: 'journey',
    notes:
      'arsenal slice 5: a declarative local verification journey — registered running at start, settled from the verdict (failed/cancelled honest); reconcile answers from the in-process live map; plane stop aborts the runner; step services stay the service domain’s own records.',
  },
  {
    domain: 'host-run-watch',
    classification: 'full-execution-owner',
    kind: 'host-run-watch',
    adapter: 'src/services/repoHost/runWatch.ts (register/settle + domain hooks)',
    owner: 'conversation OwnerKey',
    resourceKind: 'repo',
    notes:
      'lathe Family 2: a cancellable gh workflow-run watch — registered running at start, serial fresh polls (latest-wins by construction), settled from the OBSERVED conclusion; bounded lifetime + consecutive-failure settlement; plane stop aborts the loop.',
  },
  {
    domain: 'task:local_bash',
    classification: 'external-projection',
    kind: 'background-job',
    adapter: 'src/utils/task/framework.ts (registerTask/updateTaskState chokepoints)',
    owner: 'processMainOwner() — AppState tasks are the main conversation’s',
    resourceKind: 'task',
    notes: 'AppState remains the domain truth (Δ5); status maps pending→queued running→running completed→succeeded failed→failed killed→stopped.',
  },
  {
    domain: 'task:local_agent',
    classification: 'external-projection',
    kind: 'agent',
    adapter: 'src/utils/task/framework.ts',
    owner: 'processMainOwner()',
    resourceKind: 'task',
    notes: 'Agent lane effects/evidence stay on the agent OwnerKey lane; the task row projects the parent-visible lifecycle.',
  },
  {
    domain: 'task:remote_agent',
    classification: 'external-projection',
    kind: 'agent',
    adapter: 'src/utils/task/framework.ts',
    owner: 'processMainOwner()',
    resourceKind: 'task',
    notes: 'Remote transport stays out of scope; only the local task row projects.',
  },
  {
    domain: 'task:in_process_teammate',
    classification: 'external-projection',
    kind: 'agent',
    adapter: 'src/utils/task/framework.ts',
    owner: 'processMainOwner()',
    resourceKind: 'task',
    notes: 'Teammate governance (roster, bus) stays domain-owned.',
  },
  {
    domain: 'task:local_workflow',
    classification: 'external-projection',
    kind: 'workflow-worker',
    adapter: 'src/utils/task/framework.ts',
    owner: 'processMainOwner()',
    resourceKind: 'workflow',
    notes: 'The workflow RUN projects as one execution; per-agent workers are child-execution (see workflow-worker row).',
  },
  {
    domain: 'task:monitor_mcp',
    classification: 'external-projection',
    kind: 'background-job',
    adapter: 'src/utils/task/framework.ts',
    owner: 'processMainOwner()',
    resourceKind: 'task',
    notes: 'Monitor lifecycle is poll-driven; the task row is the truth being mirrored.',
  },
  {
    domain: 'task:dream',
    classification: 'external-projection',
    kind: 'agent',
    adapter: 'src/utils/task/framework.ts',
    owner: 'processMainOwner()',
    resourceKind: 'task',
    notes: 'Autonomous dream runs ride the same task chokepoints.',
  },
  {
    domain: 'workflow-worker',
    classification: 'child-execution',
    adapter: 'run journal + livePulse, projected on read (resource graph)',
    owner: 'the workflow run’s task execution',
    resourceKind: 'workflow',
    notes:
      'Individual agents inside a run are high-volume and journal-recorded; standing plane records would duplicate the journal without a consumer. Projected as children on read.',
  },
  {
    domain: 'language-server',
    classification: 'external-projection',
    kind: 'language-server',
    adapter: 'src/services/lsp/LSPServerInstance.ts (state chokepoints)',
    owner: 'processMainOwner() — instances are process-shared',
    notes: 'stopped/starting/running/stopping/error maps onto Law 3 (error→failed); crash+restart mints a new generation.',
  },
  {
    domain: 'browser-session',
    classification: 'child-execution',
    kind: 'browser-session',
    adapter: 'src/services/browser/browserSession.ts (the per-owner session store)',
    owner: 'conversation OwnerKey — sessions and origin grants are owner-keyed (main lane and each agent lane its own; capped by MERCURY_BROWSER_MAX_SESSIONS)',
    notes:
      'One puppeteer-core-driven browser child per OWNER; ephemeral, tool-scoped, reaped per owner (agent teardown / disposeOwner) and swept at exit — standing plane records would duplicate the Browser status surface without a consumer. Status/provenance ride the Browser tool + readiness rows.',
  },
  {
    domain: 'debug-adapter',
    classification: 'external-projection',
    kind: 'debug-adapter',
    adapter: 'src/services/dap/dapClient.ts (create/remove + reconcile hook)',
    owner: 'conversation OwnerKey (sessions are owner-addressed)',
    notes: 'DapSession liveness (child exitCode + terminated flag) is the reconcile truth; disposal settles stopped. Child debug sessions (the multi-session tree) are projected as children on read (resource graph) from the session registry — the root record stays the one plane row.',
  },
  {
    domain: 'model-turn',
    classification: 'external-projection',
    kind: 'model-turn',
    adapter: 'src/services/primitives/canonicalStream.ts (slice 11)',
    owner: 'conversation OwnerKey',
    notes: 'Model turn = execution; stream events project canonically; bounded ring, never durable (Δ6).',
  },
  {
    domain: 'durable-run',
    classification: 'documented-exclusion',
    adapter: '—',
    owner: 'conversation OwnerKey (run coordinator)',
    resourceKind: 'run',
    notes:
      'The run kernel is its own RICHER persisted record (sidecar, deliverables, evidence folds, resume reconciliation). Mirroring it onto the plane would be a second ledger of the same truth — the exact defect axiom removes elsewhere.',
  },
  {
    domain: 'daemon-worker',
    classification: 'documented-exclusion',
    adapter: '—',
    owner: 'the daemon process (separate OS process)',
    notes:
      'Scheduler/crew/session workers live in the Mercury daemon with their own roster + ownerWatch reaping; cross-process projection is transport, and transports are out of axiom scope.',
  },
  {
    domain: 'remote-listener',
    classification: 'documented-exclusion',
    adapter: '—',
    owner: '—',
    notes: 'Remote listeners are explicitly out of axiom scope (none exist in the tree today).',
  },
]

/** Census lookup by domain name. */
export function censusEntry(domain: string): ExecutionDomainCensusEntry | undefined {
  return EXECUTION_DOMAIN_CENSUS.find(e => e.domain === domain)
}

/** Kinds the census claims put records on the plane. */
export function censusPlaneKinds(): string[] {
  return [
    ...new Set(
      EXECUTION_DOMAIN_CENSUS.filter(
        e => e.classification === 'full-execution-owner' || e.classification === 'external-projection',
      )
        .map(e => e.kind)
        .filter((k): k is string => k !== undefined),
    ),
  ].sort()
}
