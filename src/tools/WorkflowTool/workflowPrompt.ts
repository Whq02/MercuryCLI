// The Workflow tool's model-facing contract. The same string backs both
// description() and prompt() (WorkflowTool.tsx routes each through
// getWorkflowToolPrompt()). It is the model's single source of truth for the
// script DSL, the opt-in rules, authoring doctrine, and resume mechanics —
// so every claim in here must match the engine exactly (compiler / executor
// / agent hooks / routing).
//
// Conditional addenda document VM globals and operator roster picks that
// exist only behind live gates. Documentation and capability travel
// together: gate off ⇒ the addendum is absent ⇒ the model never learns about
// a global it cannot reach, and vice versa. Gates are re-read per call — no
// memoization — so a mid-session flip updates the next prompt build.

import { evolutionLedgerEnabled } from '../../utils/evolution/evolutionLedger.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { themisActive } from '../../substrate/themis/level.js'

export const WORKFLOW_TOOL_PROMPT: string = `Run a JavaScript orchestration script that coordinates a fleet of subagents with deterministic control flow. The launch detaches immediately: this tool answers with a task ID while the run continues in the background, a <task-notification> arrives at completion, and /workflows shows live progress.

Reach for a workflow when the shape of the work wants structure across agents: breadth (split a large surface and cover the pieces concurrently), rigor (independent readings plus adversarial checking before anything is trusted), or sheer size (audits, migrations, and sweeps that no single context window holds). The script is the structure — it decides what fans out, what gets verified, and what gets merged.

STRICT OPT-IN. Never launch a workflow on your own judgment that one would help. Multi-agent orchestration can fan out into dozens of billed agents, so the scale must be something the user chose. You have that choice only when one of these holds:
- Their prompt contains the keyword "supercode" (a system-reminder will confirm it).
- A system-reminder says supercode is enabled for the session — see the Supercode paragraph below.
- They asked for it in their own words ("run a workflow", "orchestrate this", "fan out subagents", "use multi-agent"). The words must be theirs; the mere fact that agents would speed a task up does not qualify.
- The instructions of a skill or slash command you are executing direct you to invoke Workflow.
- They asked to run a particular saved or built-in workflow by name.

In every other case, keep the tool unused: handle single delegations with the Agent tool, or describe the workflow you would build, estimate its rough agent count and cost, and ask. Mention that the words "use a workflow" next time will grant the opt-in directly.

Once you are cleared to launch, prefer a hybrid opening: do the cheap reconnaissance inline first (enumerate the files, locate the hotspots, size the diff) so the work-list exists, then hand that list to a workflow. The orchestration step is the only part that needs a known shape up front.

Single-phase shapes worth chaining across turns:
- **Map** — concurrent readers over the subsystems involved, merged into one structured picture
- **Design** — several independent proposals, judged and synthesized
- **Review** — angle-split finders, then a verifier per candidate (worked example below)
- **Research** — angle-split searching, deep reads, cited synthesis
- **Migrate** — enumerate call sites, transform each in isolation, verify each

Chain them one turn at a time for bigger efforts — digest each result before shaping the next launch. Every workflow stays one tightly scoped fan-out, with you between them.

**Supercode.** While the session carries a live supercode reminder, the opt-in is standing: default to authoring and launching a workflow for any task of substance, and optimize for the most complete, most verified answer rather than for token spend. Multi-phase efforts become several sequential workflows — one per phase, with your judgment between launches. Draw on the quality patterns below (refute-to-survive checks, split-lens verification, dry-well stopping, a gap critic) wherever they fit. Go agentless only for conversational replies and tiny mechanical touches. Once a reminder announces supercode is off, the strict opt-in above is back in force.

Send the script inline through \`script\` — no need to Write it anywhere yourself. The launch persists an exact copy into the session's own storage and hands the path back in its result; iterate by editing that persisted file (Write/Edit), then relaunching with \`{scriptPath: "<path>"}\` so the whole script is never resent.

Every script opens with \`export const meta = {...}\` as its first statement:
  export const meta = {
    name: 'stale-doc-sweep',
    description: 'Find docs that contradict the code they describe',  // one line; the permission dialog shows it
    phases: [                                                         // mirrors your phase() calls
      { title: 'Inventory', detail: 'pair each doc with its subject module' },
      { title: 'Check', detail: 'one agent per pair, quote-level comparison' },
    ],
  }
  // body follows — agent()/parallel()/pipeline()/phase()/log()
  phase('Inventory')
  const pairs = await agent('List every doc file and the module it documents.', { schema: PAIRS_SCHEMA })
  ...

\`meta\` is required to be a pure literal — variables, function calls, spreads, and template interpolation are all rejected. \`name\` and \`description\` are required; \`whenToUse\` (shown when workflows are listed) and \`phases\` are optional. Phase titles pair with phase() calls by exact string match — a phase() with no meta entry simply opens its own progress group — and a phases entry may carry a \`model\` field when one phase runs on a specific override.

The script body's hooks:

- agent(prompt, opts?) → Promise<any> — dispatch one subagent.
  - Return value: the agent's closing text, returned as a string, when no schema is given; given \`schema\` — any JSON Schema object — the agent must deliver through a structured-output tool call, validation runs at the tool layer (failed validation makes the agent correct itself), and agent() resolves to the validated object — nothing to parse.
  - Resolves to null in two cases: the user skipped this agent mid-run, or it died on an unrecoverable API error after the built-in retries. Fan-out code should \`.filter(Boolean)\`.
  - opts.label — the display name in progress surfaces (defaults to a prompt prefix).
  - opts.phase — pin this call to a named progress group. Inside pipeline()/parallel() stages always pin explicitly; the ambient phase() pointer is global state and concurrent stages race it. Same string, same group.
  - opts.model — a model for THIS call. Omitted, the agent runs on the session's resolved model, which is the right default. Accepts anything the session's model catalog resolves: a canonical id, a registered family alias, or — when the operator has a second provider connected — that provider's engine ids. Never invent an id; if the operator named no model and the task doesn't demand a tier, leave it out.
  - opts.effort — reasoning effort for this call: 'low' | 'medium' | 'high' | 'xhigh' | 'max'. Omitted, the session effort applies. Spend 'low' on mechanical stages; reserve the top tiers for the hardest judge/verify stages. Setting it also turns on extended reasoning where the model supports it, and the reasoning lands in the agent's transcript for the /workflows inspector.
  - opts.tier — 'orchestrator' | 'executor': declare the call's role instead of naming a model. Validation is unconditional (a junk tier throws no matter what), but routing only acts when the operator armed MERCURY_WORKFLOW_ROUTING=1: an 'executor' call with no explicit model then rides the harness's pinned execution-tier model, while 'orchestrator' keeps the session model. A call that names opts.model outranks its tier.
  - opts.isolation: 'worktree' — run in a freshly created git worktree. Costly (worktree setup plus disk per agent); use it only when concurrent agents would otherwise write the same files. An untouched worktree is removed automatically; a modified one is kept for review.
  - opts.agentType — dispatch a custom subagent type (say, 'code-reviewer') rather than the built-in workflow worker. Looked up in the registry the Agent tool shares, and composable with \`schema\` (the structured-return contract is appended to the custom prompt).
- pipeline(items, stage1, stage2, ...) → Promise<any[]> — push each item through the stage chain independently, with NO synchronization between stages: item three can be in its last stage while item seven is still in its first. This is the default engine for multi-stage work — total wall-clock tracks the slowest single item, not the slowest stage times the stage count. Each stage receives (previousResult, originalItem, index), so later stages can label their work without smuggling context through earlier stages' return values. A stage that throws turns that item into null and its remaining stages are skipped.
- parallel(thunks) → Promise<any[]> — run an array of zero-argument functions concurrently and wait for ALL of them (a barrier). The promise always fulfills: rejected thunks (agent deaths included) become null slots in the returned array, so \`.filter(Boolean)\` before use. Reserve it for moments that genuinely need every result at once.
- log(message) — one line of narration shown to the user above the run's progress display.
- phase(title) — open a progress group; agent() calls that follow (without opts.phase) attach to it.
- args — the value the Workflow call passed as \`args\`, verbatim; undefined when absent. Pass real JSON values, never a stringified JSON blob: \`args: {targets: ['api', 'cli']}\` reaches the script as an object, while a quoted blob arrives as one string and every \`args.targets.map\`-style access dies. This is how saved workflows take parameters (a question, a target path, a config object).
- budget — {total, spent(), remaining()}: the turn's output-token target when the operator set one. total is null with no target; spent() counts output tokens across the whole turn (main loop plus every workflow — one shared pool); remaining() is max(0, total − spent()), or Infinity when target-less. That target is a hard wall: when spent() crosses total, any later agent() call throws. Loop dynamically — \`while (budget.total && budget.remaining() > 60_000) { ... }\` — or size a fleet statically: \`const LANES = budget.total ? Math.max(2, Math.floor(budget.total / 120_000)) : 4\`. Always gate such loops on budget.total — when no target exists, remaining() reads Infinity and nothing stops the loop short of the 1000-agent cap.
- workflow(nameOrRef, args?) → Promise<any> — start a second workflow inline and hand back its result. A string names a saved workflow (the same registry as {name: "..."}); {scriptPath} runs a script file you saved earlier. A child run inherits the parent's agent counter, concurrency ceiling, abort signal, and token pool; in /workflows its agents sit inside a "▸ <name>" group, and their spend lands in budget.spent(). The second argument arrives as the child's \`args\`. Exactly one level of nesting — a child calling workflow() throws. Unknown names, unreadable paths, and child syntax errors all throw; catch if you want to degrade gracefully.

Workers are instructed that their final text IS their return value — they hand back raw data with no pleasantries. Whenever the result has fields, prefer \`schema\` over prose-parsing: the validation loop is free correctness.

Mixing providers: because opts.model is per-call, one workflow may run Claude-family agents and a connected GPT lane's agents side by side. The strongest use is independence — run finders on one provider and the refute/verify lane on another, so verifier blind spots do not correlate with finder blind spots. Only mix when the second provider is actually connected for this session; a model string the catalog cannot resolve fails the dispatch.

Agents inside a workflow reach every session-connected MCP tool through ToolSearch, loading schemas on demand. Caveat: MCP servers that authenticate interactively may be unavailable in headless or scheduled runs.

A workflow script is plain JavaScript — TypeScript syntax (annotations like \`: string[]\`, interfaces, generics) fails the parse. The body executes inside an async wrapper, so await works at the top level. The usual built-ins are present (JSON, Math, Array, ...), with three deliberate holes: Date.now(), Math.random(), and zero-argument new Date() throw, because nondeterminism breaks resume replay. Take timestamps in through args or stamp them after the run returns; get variety by varying prompts/labels with the loop index. The script itself has no filesystem or network — agents do that work.

Default to pipeline(). A barrier earns its place only when the next stage needs the WHOLE previous stage:
- deduplicating or merging across the full candidate set before an expensive pass
- an aggregate early-exit ("zero candidates → skip verification")
- prompts that must reference sibling results ("compare against the other proposals")

Not sufficient reasons for a barrier:
- "I have to flatten/map/filter between stages" — fold the reshape into a stage of its own: pipeline(items, stageA, r => remap(r), stageB)
- "the stages feel like separate steps" — pipeline() already models separate steps; separateness is not synchrony
- "the code reads cleaner" — the idle time is real; with uneven finder durations a barrier throws away most of the fast lanes' head start

Smell test: parallel(...) followed by a pure reshape followed by another parallel(...) is a pipeline wearing a disguise — fold the reshape into a stage. Unsure? pipeline.

Limits: at most min(16, CPU cores − 2) agents run at once per workflow (the capacity governor can narrow this further); extra calls queue and start as slots free. Hand parallel()/pipeline() a hundred items freely — they all finish, just not all at once. A single run may make at most 1000 agent() calls (a runaway-loop backstop, far past any sane workflow), and one parallel()/pipeline() call takes at most 4096 items — beyond that is a thrown error, never a silent cut.

The canonical multi-stage shape — pipeline by default, verification starting per-angle as each review lands:
  export const meta = {
    name: 'api-surface-review',
    description: 'Review public API changes per angle, then check each claim',
    phases: [{ title: 'Review' }, { title: 'Check' }],
  }
  const ANGLES = [{key: 'breaking', brief: '...'}, {key: 'naming', brief: '...'}]
  const checked = await pipeline(
    ANGLES,
    a => agent(a.brief, {label: \`review:\${a.key}\`, phase: 'Review', schema: CLAIMS_SCHEMA}),
    out => parallel(out.claims.map(c => () =>
      agent(\`Attempt to refute this claim: \${c.text}\`, {label: \`check:\${c.id}\`, phase: 'Check', schema: RULING_SCHEMA})
        .then(r => ({...c, ruling: r}))
    ))
  )
  const upheld = checked.flat().filter(Boolean).filter(c => c.ruling?.upheld)
  return { upheld }
  // the 'breaking' angle's claims are already being checked while 'naming' is still reviewing — no idle lanes.

A barrier used correctly — collapse duplicates across every finder BEFORE paying for verification:
  const rounds = await parallel(ANGLES.map(a => () => agent(a.brief, {schema: CLAIMS_SCHEMA})))
  const unique = collapseByLocation(rounds.filter(Boolean).flatMap(r => r.claims))   // needs the whole set at once
  const rulings = await parallel(unique.map(c => () => agent(refuteBrief(c), {schema: RULING_SCHEMA})))

Count-target loop — accumulate until you have enough:
  const candidates = []
  while (candidates.length < 12) {
    const round = await agent('Propose refactor candidates in this repo.', {schema: CANDIDATES_SCHEMA})
    candidates.push(...round.items)
    log(\`\${candidates.length}/12 collected\`)
  }

Budget-scaled loop — depth tracks the operator's token target (note the budget.total guard):
  const found = []
  while (budget.total && budget.remaining() > 60_000) {
    const round = await agent('Hunt for concurrency hazards.', {schema: HAZARDS_SCHEMA})
    found.push(...round.items)
    log(\`\${found.length} so far · \${(budget.remaining() / 1000).toFixed(0)}k left\`)
  }

A composed harness — rounds until the well runs dry, dedup against everything seen, majority vote across distinct lenses:
  const seen = new Set(), kept = []
  let dryRounds = 0
  while (dryRounds < 2) {
    const round = (await parallel(HUNTERS.map(h => () =>                 // barrier: gather the round
      agent(h.brief, {phase: 'Hunt', schema: ISSUES_SCHEMA})))).filter(Boolean).flatMap(r => r.issues)
    const fresh = round.filter(i => !seen.has(sig(i)))                   // straight code — no agent needed
    if (!fresh.length) { dryRounds++; continue }
    dryRounds = 0
    for (const i of fresh) seen.add(sig(i))
    const voted = await parallel(fresh.map(i => () =>
      parallel(['logic','security','repro'].map(lens => () =>
        agent(\`Through the \${lens} lens: is "\${i.desc}" a real defect?\`, {phase: 'Vote', schema: RULING_SCHEMA})))
        .then(rs => ({ i, real: rs.filter(Boolean).filter(r => r.real).length >= 2 }))))
    kept.push(...voted.flatMap(v => (v.real ? [v.i] : [])))
  }
  return kept
  // dedup keys off \`seen\`, not \`kept\` — otherwise rejected issues resurface every round and the loop never dries.

Quality patterns — mechanisms to compose, not a fixed menu:
- Refute-to-survive: give each candidate to N independent skeptics whose brief is to DISPROVE it, with "uncertain means refuted". A majority of refutations kills it. This is what stops plausible-sounding wrongness.
    const rulings = await parallel([0, 1, 2].map(() => () =>
      agent(\`Disprove this if you can: \${claim}. When uncertain, rule it refuted.\`, {schema: RULING_SCHEMA})))
    const upheld = rulings.filter(Boolean).filter(r => r.refuted === false).length >= 2
- Split lenses: when something can be wrong in several ways, give each verifier a DIFFERENT lens (logic, security, performance, reproducibility) instead of three copies of the same skeptic — diversity catches what redundancy repeats.
- Contender panel: produce N independent solutions from distinct starting biases, score them with independent judges, then build the final answer on the winner while folding in the runners-up's best pieces. Wins over iterate-on-one whenever the space of workable designs is broad.
- Dry-well stopping: for discovery of unknown size, keep launching rounds until K consecutive rounds add nothing new. Fixed quotas stop too early exactly when the tail matters.
- Blind angles: several searchers, each restricted to a different modality (by name, by content, by owner, by date). None sees the others' results; the union sees what any single approach misses.
- Gap critic: end with one agent whose only question is "what did this run NOT do — which angle unswept, which claim unchecked, which source unread?" Its answer seeds the next round.
- Named caps: whenever the script bounds its own coverage (top-N, sampling, skip-on-retry), log() the cut. An unlogged cap reads as full coverage to whoever gets the report.

Size the harness to the request. A quick "any bugs here?" wants a couple of finders and one-vote checks; "audit this thoroughly" wants many finders, refutation panels of three to five votes, and a synthesis stage. For research, review, and audit asks, err toward depth; for quick checks, err toward speed.

Invent structures freely beyond these — bracketed tournaments, repair-until-green loops, escalation tiers — whatever the task's shape rewards.

Use Workflow when control flow deserves to be code (loops, conditionals, fan-out with joins); keep the judgment calls in your own turn.

## Resume

Every launch reports a runId. After a pause, a kill, or an edit to the script, launch again with Workflow({scriptPath, resumeFromRunId}): agent() calls whose (position, prompt, opts) prefix is unchanged replay instantly from the journal; the first call that differs, plus all calls after it, run live. Unchanged script plus unchanged args replays 100%; changing \`args\` invalidates the chain on purpose (the input steers the run). This replay is WHY Date.now()/Math.random()/new Date() are banned in scripts. If no journal survives, the fallback is manual: read the agent-<id>.jsonl transcripts under the run's transcript directory and write a continuation script from what already finished.`;

// ── Addendum: authoring doctrine (always appended) ───────────────────────────
// Two harness-level rules that OVERRIDE the generic guidance above.
const AUTHORING_DOCTRINE_SECTION = `

## Mercury workflow authorship doctrine

- Model choice belongs to the operator, and their standing rule overrides the "leave opts.model out" default above: name an explicit catalog alias, or a declared tier, for each dispatch — the operator directs models per dispatch. Do not lean on the inherited session model (project-level settings sometimes pin a tier the live session is not using), and never pick an agentType whose definition pins a small-tier model — when you need read-only scoping, put it in the prompt, not in a downgraded engine.
- A verify stage belongs to the workflow's shape itself, never bolted on after: any workflow that performs real implementation (edits, fixes, migrations) carries one — refute-to-survive from the pattern list, or one dedicated checker per changed unit — before it returns success. A fixer agent asserting its own success is an assertion, not evidence.`

// ── Addendum: the `themis` global, alive only with its control plane ─────────
const THEMIS_GLOBAL_SECTION = `

## The themis global (present at the default level; absent only when THEMIS is switched off)

- themis: eleven deterministic async checks the THEMIS control plane hands to scripts (docs/THEMIS-CONTROL-PLANE.md). Plain JSON in, plain JSON out, every result boundary-cloned; violations append audit rows. The surface: validateSDS / normalizeSDS (the machine-checkable SDS contract), topoLayers / taskPriority (scheduling arithmetic), verifyOwnership({ownership, lane}) / scanDiff({declared, actual}) (diff-derived audits), routeRepair({issue, normalized}) (repair routing by root cause), phase({op, ...}) (the run's phase state machine), traceUpdate({op, ...}) / verifyTrace({}) (the requirement→file→test trace gate), observe({text, source, topicHint?}) (the observation bridge; a clean no-op while its own gate is off). The bundled repo-generation workflow consumes it as the worked example. THEMIS is on by default, but an explicit MERCURY_THEMIS=off removes the global — any script that depends on it must feature-test (typeof themis === 'undefined') and decline to run, never assume the global is there.`

// ── Addendum: the `ledger` global, alive only with its own gate ──────────────
const LEDGER_GLOBAL_SECTION = `

## The ledger global (evolution rows)

- ledger: {record(row): Promise<{ok, path?, deduped?, reason?}>, read(program): Promise<row[]>, report(program): Promise<string>} — an append-only record of ITERATED improvement work (patch loops, hardening rounds, audit campaigns). record() accepts {program, subject, outcome, iteration?, hypothesis?, mechanism?, lineage?, score?: {dev?, holdout?, unit?}, delta?, evidenceRefs?, notes?}; outcome is one of 'baseline'|'improved'|'regressed'|'tie'|'accepted'|'refused'|'error'. A row whose outcome is 'improved' or 'accepted' must name at least one evidenceRef (a gate log, judge rulings, a transcript path) — claims without evidence are refused by construction. Each row is anchored to the run's own raw traces automatically and deduplicated by identity, so replays after a resume cannot double-append. read(program) hands back that program's earlier rows; report(program) renders frontier, drift, and the recent tail. The loop contract: open with report() plus the earlier rows before proposing; a 'baseline' row goes in before anything changes; every candidate gets a row, failed ones too; and roughly three straight iterations that never log an 'improved' row mean the loop converged — stop there. (Method detail: the harness-evolution skill, plus docs/workflows/patch-loop.workflow.js.) One-shot work — a review, a migration, a research sweep — has no business writing rows.`

// ── Addendum: the operator's saved repo-generation roster ────────────────────
// Emitted only while the bundled repo-generation workflow is registered AND
// the enter-menu saved at least one valid pick. Saved values are checked
// against the menu's allowed alias set before being repeated to the model —
// an invalid saved value emits nothing rather than a wrong instruction.
function daedalusRosterAddendum(): string {
  if (!flagEnabled('MERCURY_DAEDALUS')) return ''
  const ROSTER_ALIASES = ['opus', 'sonnet', 'fable', 'fable51']
  const saved: string[] = []
  const planning = flagEnv('MERCURY_DAEDALUS_MODEL')
  const lanes = flagEnv('MERCURY_DAEDALUS_EXECUTOR_MODEL')
  if (planning && ROSTER_ALIASES.includes(planning)) saved.push(`args.model='${planning}'`)
  if (lanes && ROSTER_ALIASES.includes(lanes)) saved.push(`args.executorModel='${lanes}'`)
  if (saved.length === 0) return ''
  return `

## DAEDALUS roster (the operator's saved picks)

- The 'daedalus' roster the operator saved from the enter menu: ${saved.join(', ')}. Pass these through args explicitly at launch, unless the operator's message picks differently. Launching without explicit models fails regardless — no saved pick and no stated choice means ask first.`
}

/**
 * The composed model-facing prompt: the base contract, the authoring
 * doctrine, and each gated addendum exactly while its capability is live.
 */
export function getWorkflowToolPrompt(): string {
  let text = WORKFLOW_TOOL_PROMPT
  text += AUTHORING_DOCTRINE_SECTION
  if (themisActive()) text += THEMIS_GLOBAL_SECTION
  if (evolutionLedgerEnabled()) text += LEDGER_GLOBAL_SECTION
  text += daedalusRosterAddendum() // '' unless the workflow is on AND a pick is saved
  return text
}
