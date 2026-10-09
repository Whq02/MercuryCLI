
import { EFFORT_LEVELS } from '../../utils/effortLadder.js'

export const WORKFLOW_TOOL_PROMPT: string = `Run a JavaScript orchestration script that coordinates a fleet of subagents with deterministic control flow. The launch detaches immediately: this tool answers with a task ID while the run continues in the background, a <task-notification> arrives at completion, and /workflows shows live progress.

Launching a workflow is the user's choice, never your own judgement that one would help: orchestration can fan out into dozens of billed agents, so the scale must be something the user chose. You have that choice only when one of these holds:
- They asked for it in their own words ("run a workflow", "orchestrate this", "fan out subagents", "use multi-agent"). The words must be theirs; the mere fact that agents would speed a task up does not qualify.
- The instructions of a skill or slash command you are executing direct you to invoke Workflow.
- They asked to run a particular saved or built-in workflow by name.

In every other case, keep the tool unused: handle single delegations with one sub-agent launch, or describe the workflow you would build, estimate its rough agent count and cost, and ask. Mention that the words "use a workflow" next time will grant the opt-in directly.

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

\`meta\` is a pure literal — variables, function calls, spreads, and template interpolation are all rejected. \`name\` and \`description\` are required; \`whenToUse\` (shown when workflows are listed) and \`phases\` are optional. Phase titles pair with phase() calls by exact string match — a phase() with no meta entry simply opens its own progress group — and a phases entry may carry a \`model\` field when one phase runs on a specific override.

The script body's hooks:

- agent(prompt, opts?) → Promise<any> — dispatch one subagent.
  - Return value: the agent's closing text as a string; given \`schema\` (any JSON Schema object) the validated object instead — failed validation makes the agent correct itself.
  - Resolves to null in two cases: the user skipped this agent mid-run, or it died on an unrecoverable API error after the built-in retries. Fan-out code should \`.filter(Boolean)\`.
  - opts.label — the display name in progress surfaces (defaults to a prompt prefix).
  - opts.phase — pin this call to a named progress group. Inside pipeline()/parallel() stages always pin explicitly; the ambient phase() pointer is global state and concurrent stages race it. Same string, same group.
  - opts.model — the model for this call, as the operator directs per dispatch: an explicit catalog alias or a declared tier. Accepts anything the session's model catalog resolves: a canonical id, a registered family alias, or — when the operator has a second provider connected — that provider's engine ids. Never invent an id; a string the catalog cannot resolve fails the dispatch. Omitted, the agent runs on the session's resolved model.
  - opts.effort — reasoning effort for this call: ${EFFORT_LEVELS.map(level => `'${level}'`).join(' | ')}. Omitted, the configured sub-agent default applies (high unless the operator changed it in /config) — never the session's own level. Spend 'low' on mechanical stages; reserve the top tiers for the hardest judge/verify stages (a tier the model's ladder lacks runs the nearest served tier). Setting it also turns on extended reasoning where the model supports it.
  - opts.tier — 'orchestrator' | 'executor': declare the call's role instead of naming a model. A junk tier throws; routing only acts when the operator armed MERCURY_WORKFLOW_ROUTING=1: an 'executor' call with no explicit model then rides the harness's pinned execution-tier model, while 'orchestrator' keeps the session model. A call that names opts.model outranks its tier.
  - opts.isolation: 'worktree' — run in a freshly created git worktree. Costly (worktree setup plus disk per agent); use it only when concurrent agents would otherwise write the same files. An untouched worktree is removed automatically; a modified one is kept for review.
  - opts.agentType — dispatch a custom subagent type (say, 'code-reviewer') rather than the built-in workflow worker; its definition's tools: list is followed exactly, as the Agent tool would; composable with \`schema\`.
- pipeline(items, stage1, stage2, ...) → Promise<any[]> — push each item through the stage chain independently, with no synchronization between stages: item three can be in its last stage while item seven is still in its first. This is the default engine for multi-stage work — total wall-clock tracks the slowest single item, not the slowest stage times the stage count. Each stage receives (previousResult, originalItem, index). A stage that throws turns that item into null and its remaining stages are skipped.
- parallel(thunks) → Promise<any[]> — run an array of zero-argument functions concurrently and wait for all of them (a barrier). The promise always fulfills: rejected thunks (agent deaths included) become null slots in the returned array, so \`.filter(Boolean)\` before use. Reserve it for a stage that needs the whole previous stage at once — deduplicating across every candidate, an aggregate early exit, prompts that reference sibling results.
- log(message) — one line of narration shown to the user above the run's progress display.
- phase(title) — open a progress group; agent() calls that follow (without opts.phase) attach to it.
- args — the value the Workflow call passed as \`args\`, verbatim; undefined when absent. Pass real JSON values, never a stringified JSON blob: \`args: {targets: ['api', 'cli']}\` reaches the script as an object, while a quoted blob arrives as one string and every \`args.targets.map\`-style access dies.
- budget — {total, spent(), remaining()}: the turn's output-token target when the operator set one. total is null with no target; spent() counts output tokens across the whole turn (main loop plus every workflow — one shared pool); remaining() is max(0, total − spent()), or Infinity when target-less. That target is a hard wall: when spent() crosses total, any later agent() call throws. Loop on remaining() or size a fleet statically: \`const LANES = budget.total ? Math.max(2, Math.floor(budget.total / 120_000)) : 4\`. Always gate such loops on budget.total — when no target exists, remaining() reads Infinity and nothing stops the loop short of the 1000-agent cap.
- workflow(nameOrRef, args?) → Promise<any> — start a second workflow inline and hand back its result. A string names a saved workflow (the same registry as {name: "..."}); {scriptPath} runs a script file you saved earlier. A child run inherits the parent's agent counter, concurrency ceiling, abort signal, and token pool (its spend lands in budget.spent()). The second argument arrives as the child's \`args\`. Exactly one level of nesting — a child calling workflow() throws. Unknown names, unreadable paths, and child syntax errors all throw; catch if you want to degrade gracefully.

Agents inside a workflow carry the same tool box as a background sub-agent launched by the Agent tool — one allow-set, with the spawn, plan and ask surfaces left out — so a model ingests the same tool schemas either way. The built-in worker reaches every session-connected MCP tool through its own tool search, loading schemas on demand; a custom agentType carries exactly the tools its definition declares, as it would under the Agent tool. Caveat: MCP servers that authenticate interactively may be unavailable in headless or scheduled runs.

A workflow script is plain JavaScript — TypeScript syntax (annotations like \`: string[]\`, interfaces, generics) fails the parse. The body executes inside an async wrapper, so await works at the top level. The usual built-ins are present (JSON, Math, Array, ...), with three deliberate holes: Date.now(), Math.random(), and zero-argument new Date() throw, because nondeterminism breaks resume replay. Take timestamps in through args or stamp them after the run returns; get variety by varying prompts/labels with the loop index. The script itself has no filesystem or network — agents do that work.

Limits: at most min(16, CPU cores − 2) agents run at once per workflow (the capacity governor can narrow this further); extra calls queue and start as slots free. Hand parallel()/pipeline() a hundred items freely — they all finish, just not all at once. A single run may make at most 1000 agent() calls (a runaway-loop backstop), and one parallel()/pipeline() call takes at most 4096 items — beyond that throws.

The hooks composed — pipeline by default, verification starting per angle as each review lands:
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

## Resume

Every launch reports a runId. After a pause, a kill, or an edit to the script, launch again with Workflow({scriptPath, resumeFromRunId}): agent() calls whose (position, prompt, opts) prefix is unchanged replay instantly from the journal; the first call that differs, plus all calls after it, run live. Unchanged script plus unchanged args replays 100%; changing \`args\` invalidates the chain on purpose (the input steers the run). If no journal survives, the fallback is manual: read the agent-<id>.jsonl transcripts under the run's transcript directory and write a continuation script from what already finished.`;

const AUTHORING_DOCTRINE_SECTION = `

## Mercury workflow authorship doctrine

- Model choice belongs to the operator: name an explicit catalog alias, or a declared tier, for each dispatch — the operator directs models per dispatch. Do not lean on the inherited session model (project-level settings sometimes pin a tier the live session is not using), and never pick an agentType whose definition pins a small-tier model — when you need read-only scoping, put it in the prompt, not in a downgraded engine.
- A verify stage belongs to the workflow's shape itself, never bolted on after: any workflow that performs real implementation (edits, fixes, migrations) carries one — an independent refutation of each claim, or one dedicated checker per changed unit — before it returns success. A fixer agent asserting its own success is an assertion, not evidence.`

export function getWorkflowToolPrompt(): string {
  return WORKFLOW_TOOL_PROMPT + AUTHORING_DOCTRINE_SECTION
}
