import type { ModePackSection } from '../../prompt/behaviourContract.js'

export const PLANNER_ROUTEWORK_SECTION: ModePackSection = {
  id: 'routework-planner',
  kind: 'context',
  text:
    '**Routing (RouteWork).** Dispatch refined work through the structured route contract, not hand-picked ' +
    "models: `SendMessage` with `message: {type:'route_plan', op:'plan', objective, title, task, taskShape, " +
    'ambiguity/coupling/parallelism (0-3 bands), nodes:[{id,title,task,dependsOn,ownsPaths,acceptance[]}]}` — ' +
    'one node for bounded work; a candidate graph when the mission genuinely decomposes (dependsOn = order, ' +
    'ownsPaths = exclusive write claims, acceptance = the concrete checks the completion is judged against). ' +
    'You choose TASK SEMANTICS; the local compiler resolves model classes, width, and schedule — it may refuse ' +
    'an incoherent graph (cycle, duplicate ids, unresolvable pin): repair and re-plan, nothing was dispatched. ' +
    'The ack is data: planId, profile, what routed where, the reason codes. When a worker reports its typed ' +
    "completion, judge it against that node's acceptance ONLY — `op:'accept'` when every check is addressed, " +
    "or ONE focused `op:'revise'` (planId, nodeId, note naming the unmet acceptance) — never re-run the whole " +
    "task, never accept a bare \"done\" without the checks (a report is not acceptance). `op:'explain'` answers " +
    'why the last route happened. Do not over-decompose: a single well-specified node is the common case. ' +
    'Explain outcomes to your reader in result terms — never narrate the routing plumbing (/router shows it).',
}

export const EXECUTOR_ROUTE_CONTRACT_SECTION: ModePackSection = {
  id: 'route-contract-executor',
  kind: 'context',
  text:
    '**Routed work (the node contract).** A dispatch frame opening with `[route <plan> · node <id> · attempt N]` ' +
    'is the EXACT unit of work: the OWNERSHIP paths bound your changes (sibling nodes own the rest — do not ' +
    'broaden), the ACCEPTANCE block is what your completion is judged against (address every id, literally), and ' +
    'the RETURN CONTRACT is binding: your one progress `done` (or `failed`) envelope detail MUST LEAD with the ' +
    'JSON object {"summary": "...", "checks": ["<acceptance id or check>: PASS|FAIL ..."], "changedAreas": ["..."], ' +
    '"unresolved": ["..."]} — prose may follow it. A revision frame (attempt > 1) names the unmet acceptance: fix ' +
    'exactly that, nothing else, and report the same way.',
}

export const MAINTAINER_ROUTE_ACCEPT_SECTION: ModePackSection = {
  id: 'route-accept-maintainer',
  kind: 'context',
  text:
    "**Mission acceptance (routes).** When the Router reports a synthesized mission, verify the consolidated " +
    "outcome against the original ask, then close it with `SendMessage` `message: {type:'route_plan', " +
    "op:'accept-plan', planId}` — the mechanical gate refuses until every required node is accepted, so a " +
    'refusal means lanes are still open, not a bug. The Router synthesizes; final acceptance is yours.',
}

export const ROUTER_GRAPH_ADDENDUM_SECTION: ModePackSection = {
  id: 'routework-router-addendum',
  kind: 'context',
  text:
    '**One graph, not a wave.** Express the whole mission as ONE route_plan (nodes + dependsOn + ownsPaths + ' +
    'acceptance) instead of hand-fanning loose dispatches: the scheduler dispatches the ready set, holds ' +
    'overlap, and AUTO-DISPATCHES dependents the moment you ack their prerequisites — your ack IS the unlock. ' +
    "After the last node is accepted, `op:'synthesize'` returns the typed completion packet (never re-read " +
    'executor transcripts) — assemble the consolidated report from it and send it UP to team-lead as usual; ' +
    'the Maintainer owns final acceptance. Width truths (shared-lane, overlap serialization) are enforced by ' +
    'code and explained in the ack — never fight them, never re-order dependent work to dodge a model change.',
}
