// =============================================================================
// bundled/daedalus.ts — the DAEDALUS repo-generation workflow (built-in).
//
// "CodeTeam" (Wang et al., arXiv:2606.22082) adapted to run ON the THEMIS
// control plane (arXiv:2606.26924 — Slice A): LLM agents PRODUCE candidates
// (SDS drafts, file implementations, QA issue records); every CHECK that acts
// on them is host-side deterministic TS reached through the `themis` VM global
// (src/substrate/themis/workflowHost.ts — SDS contract validation, Kahn
// layering + priority arithmetic, exclusive-ownership scans, derived diff
// scans, repair routing, the phase state machine, the trace-complete gate).
// The script REFUSES to run when the global is absent (MERCURY_THEMIS=off).
//
// Mercury rules encoded here (the ask-the-operator model rule; pinned by
// scripts/repo-generation/prove-repo-generation-script.ts):
//   • args.model + args.executorModel are REQUIRED, validated against
//     {opus, sonnet, fable} — no silent defaults, never the forbidden tier.
//   • Dev/repair lanes are worktree-isolated (the shared-repo fan-out lesson)
//     and merged by a SINGLE sequential integrator per step.
//   • The QA loop is hard-capped at 2 repair rounds (P2's own convergence
//     data: +3.5, +1.4, then ≤0.8 — REPAIR_ROUND_CAP in sdsContract.ts).
//   • Lane interface briefs become MNEME observations via themis.observe
//     (Slice B bridge) — an honest no-op while MERCURY_MNEME is off.
//
// Registration: bundled/index.ts registers this script ONLY while
// flagEnabled('MERCURY_DAEDALUS') (opt-in) — OFF ⇒ absent from /workflows and
// the registry, byte-identical to the default. Proofs: scripts/repo-generation/run-all.sh
// (parse + meta + refusals + a full stub-agent dry run — no live API in the
// gate); the billed live runner is scripts/repo-generation/live-repogen.sh
// (OPERATOR-RUN, the scheduler live-runner precedent).
//
// Embedding discipline (the deep-research idiom): a NORMAL template literal —
// the script body deliberately contains NO backtick and no dollar-brace (the
// newline/backtick characters it needs are built via String.fromCharCode), so
// the only escapes below are doubled backslashes. The proof suite re-parses
// and compiles the cooked string; an escaping mistake fails the gate.
// =============================================================================

/* eslint-disable */

import { flagEnvLoose } from '../../../substrate/flagRegistry.js'
import { getGptSeatAvailability } from '../../../services/providers/openai/openaiCatalogue.js'

/**
 * DAEDALUS model resolution — the HOST-side seam WorkflowTool
 * runs before launch: inject the boot-menu saved choices when args omit
 * models (provenance NAMED in modelSource/executorModelSource — the preview
 * and the receipt show it), validate every choice against the CURRENT model
 * catalogue, and refuse invalid picks with the compatible list. Never
 * substitutes silently; absent-and-unsaved stays absent (the script returns
 * the ask). The catalogue = the alias trio + the current-generation explicit
 * ids (the same lineup the /model picker's explicit rows carry — aliases
 * resolve onto these at dispatch).
 */
export function daedalusResolveModels(rawArgs: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const args: Record<string, unknown> = rawArgs !== null && typeof rawArgs === 'object' ? { ...(rawArgs as Record<string, unknown>) } : {}
  const compatible = new Set<string>(['opus', 'sonnet', 'fable', 'fable51', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1'])
  // Provider parity: qualified GPT ids join the compatible set while the
  // OpenAI lane is connected + live-qualified (the seat owner's one chain —
  // unready adds nothing, so the surface never advertises an unready lane).
  try {
    const seat = getGptSeatAvailability()
    if (seat.state === 'ready') for (const id of seat.ids) compatible.add(id)
  } catch {
    /* seat read trouble ⇒ the Anthropic set stands */
  }
  const list = [...compatible].join(' | ')
  const resolveOne = (key: 'model' | 'executorModel', envKey: string, sourceKey: string): string | null => {
    const explicit = typeof args[key] === 'string' ? (args[key] as string).trim() : ''
    if (explicit) {
      if (!compatible.has(explicit)) return `args.${key}='${explicit}' is not in the current model catalogue (${list}) — pick one of those; DAEDALUS never substitutes a model silently`
      args[sourceKey] = args[sourceKey] ?? 'explicit'
      return null
    }
    const saved = (flagEnvLoose(envKey) ?? '').trim()
    if (saved) {
      if (!compatible.has(saved)) return `the boot-menu saved ${envKey}='${saved}' is not in the current model catalogue (${list}) — fix the saved choice in the boot menu or pass args.${key} explicitly`
      args[key] = saved
      args[sourceKey] = 'boot-menu saved choice (' + envKey + ')'
    }
    return null
  }
  const e1 = resolveOne('model', 'MERCURY_DAEDALUS_MODEL', 'modelSource')
  if (e1) return { ok: false, error: e1 }
  const e2 = resolveOne('executorModel', 'MERCURY_DAEDALUS_EXECUTOR_MODEL', 'executorModelSource')
  if (e2) return { ok: false, error: e2 }
  return { ok: true, args }
}

export const DAEDALUS_WORKFLOW_SCRIPT = `export const meta = {
  name: 'daedalus',
  description: 'DAEDALUS repo generation (CodeTeam on the THEMIS control plane) — independent architects, a deterministic SDS gate, owned worktree dev lanes, derived ownership scans, and a hard-capped QA loop.',
  whenToUse: "When the operator asks to generate a small repository (or a self-contained subsystem) from a written requirements document, inside an initialized git repo. Args: {requirements} required; {model, executorModel} come from the operator (explicit per dispatch, or the boot-menu saved choice the tool layer injects and NAMES — validated against the current model catalogue, never silently substituted; absent+unsaved ⇒ the run returns asking for a pick). PREVIEW-FIRST: the first run returns a deterministic preflight (size class, roster, expected agent/token band) WITHOUT dispatching any agent; relaunch with args.accept=true to launch. Needs MERCURY_THEMIS=warn|enforce and MERCURY_DAEDALUS=1. Spawns a billed agent fleet scaled to the brief (tiny=1 architect … large=4).",
  phases: [
    {"title":"Preflight","detail":"deterministic size class + roster + spend band; zero agents; accept gate"},
    {"title":"Spec","detail":"rule-based requirements normalization + spec hash"},
    {"title":"Design","detail":"size-classed independent architects (1-4) → deterministic SDS filter → CTO scoring → normalize"},
    {"title":"Implement","detail":"topo-layered owned lanes (worktree-isolated) → sequential integrator → derived ownership scan"},
    {"title":"Test","detail":"per-layer QA with temp tests → deterministic repair routing → size-classed round cap"},
    {"title":"Finalize","detail":"trace-complete gate + deterministic run summary vs the preflight"},
  ],
}

// ─── Hard preconditions: the control plane, the operator's models ───────────
// P2 runs ON P1 — without THEMIS there is no deterministic checker, so refuse.
if (typeof themis === 'undefined') {
  throw new Error('DAEDALUS needs the THEMIS control plane, which is on by default — this session has MERCURY_THEMIS=off. Unset it (or set warn|enforce) and relaunch. The themis VM global is absent while THEMIS is off, and the deterministic checks are not optional here.')
}
const A = args !== null && typeof args === 'object' ? args : {}
// Models are the operator's word: explicit args, or the boot-menu saved
// choice the TOOL LAYER injected mechanically (daedalusResolveModels —
// catalogue-validated, provenance in modelSource/executorModelSource).
// Absent ⇒ return a typed ask (not a throw: the preview journey should
// surface it as the run result the model relays).
const MODEL = typeof A.model === 'string' ? A.model : ''
const EXECUTOR_MODEL = typeof A.executorModel === 'string' ? A.executorModel : ''
const MODEL_SOURCE = typeof A.modelSource === 'string' ? A.modelSource : 'explicit'
const EXEC_SOURCE = typeof A.executorModelSource === 'string' ? A.executorModelSource : 'explicit'
if (!MODEL || !EXECUTOR_MODEL) {
  return {
    launched: false,
    needsModels: true,
    message: 'DAEDALUS: pick the models before launch — args.model (planning/design/QA) and args.executorModel (building lanes). Compatible choices come from the current model catalogue (opus | sonnet | fable | fable51 today, plus any live future model); engine providers (OpenAI, Z.AI, and the other API-key lanes) are not integrated for the agent fleet, so their models are honestly absent here rather than quietly refused. A boot-menu saved choice (MERCURY_DAEDALUS_MODEL / MERCURY_DAEDALUS_EXECUTOR_MODEL) is injected automatically and named. Ask the operator; never guess.',
  }
}
const REQUIREMENTS_RAW = typeof A.requirements === 'string' ? A.requirements : ''
if (!REQUIREMENTS_RAW.trim()) {
  throw new Error('DAEDALUS: args.requirements (the requirements document text) is REQUIRED.')
}
const ACCEPTED = A.accept === true

const BUDGET_FLOOR = 50000   // with an operator token target set, stop dispatching below this remainder
const NL = String.fromCharCode(10)

// P2's anti-convergence: distinct design lenses per architect (deterministic
// assignment — workflow scripts have no randomness by design; divergence comes
// from the lens plus visibility of previously claimed module names).
const DESIGN_PREFERENCES = [
  'layered-minimal: the smallest layered architecture that satisfies every requirement',
  'feature-modular: one module per user-facing capability, shared kernel kept thin',
  'contract-first: define every public interface before any implementation detail',
  'pipeline-dataflow: model the system as explicit data transformations end to end',
]

// ─── Structured-output schemas ───────────────────────────────────────────────
// developer_plan/owner carry a HANDLE pattern, not a bare string: the first
// live run had all four architects return
// annotated plans ("dev-core: owns the computation layer…") — schema-valid,
// contract-dead (owner 'dev-core' equals no plan entry ⇒ UNKNOWN_OWNER × all,
// 4/4 excluded). The pattern makes the structured-output layer ENFORCE bare
// handles at generation time; the deterministic checker stays untouched.
const OWNER_HANDLE = { type: 'string', pattern: '^[a-z][a-z0-9-]{1,23}$' }
const SDS_SCHEMA = {
  type: 'object', required: ['tech_stack', 'repo_tree', 'developer_plan', 'files'],
  properties: {
    tech_stack: { type: 'string' },
    repo_tree: { type: 'array', items: { type: 'string' } },
    developer_plan: { type: 'array', minItems: 1, maxItems: 4, items: OWNER_HANDLE },
    files: { type: 'array', minItems: 1, items: {
      type: 'object', required: ['path', 'purpose', 'public_api', 'depends_on', 'owner'],
      properties: {
        path: { type: 'string' },
        purpose: { type: 'string' },
        public_api: { type: 'array', items: { type: 'string' } },
        depends_on: { type: 'array', items: { type: 'string' } },
        owner: OWNER_HANDLE,
      },
    }},
  },
}
const CTO_SCORE_SCHEMA = {
  type: 'object', required: ['candidates'],
  properties: {
    candidates: { type: 'array', minItems: 1, items: {
      type: 'object', required: ['candidate', 'scores', 'undeclaredAssumptions'],
      properties: {
        candidate: { type: 'integer' },
        scores: { type: 'object', required: ['coverage', 'consistency', 'feasibility', 'modularity'],
          properties: {
            coverage: { type: 'integer' }, consistency: { type: 'integer' },
            feasibility: { type: 'integer' }, modularity: { type: 'integer' },
          },
        },
        undeclaredAssumptions: { type: 'integer' },
        notes: { type: 'string' },
      },
    }},
  },
}
const ACCEPTANCE_SCHEMA = {
  type: 'object', required: ['criteria'],
  properties: {
    criteria: { type: 'array', minItems: 1, items: {
      type: 'object', required: ['id', 'text', 'files'],
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
    }},
  },
}
const LANE_SCHEMA = {
  type: 'object', required: ['done', 'branch', 'changedPaths', 'briefs', 'commits'],
  properties: {
    done: { type: 'boolean' },
    branch: { type: 'string' },
    changedPaths: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: {
      type: 'object', required: ['path', 'update_reason'],
      properties: { path: { type: 'string' }, update_reason: { type: 'string' } },
    }},
    briefs: { type: 'array', items: {
      type: 'object', required: ['file', 'publicApi', 'notes'],
      properties: {
        file: { type: 'string' },
        publicApi: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
    }},
    blockers: { type: 'string' },
  },
}
const INTEGRATE_SCHEMA = {
  type: 'object', required: ['done', 'mergedPaths', 'conflicts'],
  properties: {
    done: { type: 'boolean' },
    mergedPaths: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
  },
}
const QA_SCHEMA = {
  type: 'object', required: ['issues', 'verified', 'leftoverPaths'],
  properties: {
    issues: { type: 'array', items: {
      type: 'object', required: ['symptom', 'suspectedFiles'],
      properties: {
        symptom: { type: 'string' },
        traceback: { type: 'string' },
        suspectedFiles: { type: 'array', items: { type: 'string' } },
        symbol: { type: 'string' },
        publicApiImpact: { type: 'boolean' },
      },
    }},
    verified: { type: 'array', items: {
      type: 'object', required: ['acId', 'test'],
      properties: { acId: { type: 'string' }, test: { type: 'string' } },
    }},
    leftoverPaths: { type: 'array', items: { type: 'string' } },
  },
}

// ─── Deterministic helpers ───────────────────────────────────────────────────
function normPath(p) {
  let s = String(p).split('\\\\').join('/')
  if (s.indexOf('./') === 0) s = s.slice(2)
  return s
}
function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return ('0000000' + h.toString(16)).slice(-8)
}
// Own-property membership for model-JSON records — a path named like a
// prototype member ('constructor', 'toString') must read as absent, not as
// the inherited value.
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k) }
// Rule-based requirements preprocessing (P2's preprocessing, deterministic):
// normalize headings onto stable [S<n>] section markers, keep code fences
// verbatim, strip trailing whitespace.
function preprocessRequirements(text) {
  const TICK = String.fromCharCode(96)
  const FENCE = TICK + TICK + TICK
  const lines = String(text).split(NL)
  const out = []
  let sections = 0
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd()
    if (line.trim().indexOf(FENCE) === 0) { inFence = !inFence; out.push(line); continue }
    if (inFence) { out.push(lines[i]); continue }
    const m = line.match(/^(#{1,6}) *(.*)$/)
    if (m) { sections++; out.push(m[1] + ' [S' + sections + '] ' + m[2]); continue }
    out.push(line)
  }
  return { text: out.join(NL), sections: sections }
}
function budgetLow() {
  return budget.total !== null && budget.remaining() < BUDGET_FLOOR
}
// Drive a THEMIS phase-machine transition that MUST succeed — a refusal here
// is a pipeline bug or an integrity violation, so fail loud.
async function must(op, extra) {
  const input = Object.assign({ op: op }, extra || {})
  const r = await themis.phase(input)
  if (!r || r.ok !== true) {
    const kind = r && r.kind ? r.kind : 'NO_VERDICT'
    const detail = r && r.detail ? r.detail : 'phase machine returned nothing'
    throw new Error('THEMIS phase gate refused ' + op + (extra && extra.phase ? ' ' + extra.phase : '') + ': ' + kind + ' — ' + detail)
  }
  return r
}
function clampScore(v) {
  const n = Math.round(Number(v))
  if (!isFinite(n)) return 0
  return Math.max(0, Math.min(2, n))
}
function edgeCount(sds) {
  let n = 0
  for (const f of sds.files) n += f.depends_on.length
  return n
}
function dedupeBriefs(list) {
  const seen = {}
  const out = []
  for (const b of list) {
    if (!seen[b.file]) { seen[b.file] = true; out.push(b) }
  }
  return out
}

// ─── Prompt builders ─────────────────────────────────────────────────────────
function architectPrompt(specText, preference, claimed) {
  const anti = claimed.length
    ? 'Top-level modules other architects already claimed: ' + claimed.join(', ') + '. Prefer a STRUCTURALLY DIFFERENT decomposition where the requirements allow it — do not converge on the same shape.'
    : 'You are the first architect — no prior claims.'
  return [
    'You are one of ' + N_ARCHITECTS + ' independent software architects drafting a Software Design Specification (SDS) for the requirements below. READ-ONLY: design only, do not implement or edit any file.',
    '',
    '## Your design preference (hold it firmly)',
    preference,
    '',
    '## Anti-convergence',
    anti,
    '',
    '## Requirements (sections marked [S1], [S2], ...)',
    specText,
    '',
    '## SDS contract (deterministically validated — any structural violation excludes your draft)',
    '- tech_stack: one line naming the language and key libraries.',
    '- repo_tree: EVERY path of the repo you propose (files only, POSIX-relative, no directories).',
    '- developer_plan: 2-3 BARE developer handles, lowercase kebab-case (dev-core, dev-api) — handles ONLY, no descriptions or annotations. Every files[].owner must EQUAL one of them exactly.',
    '- files[]: one entry per SOURCE file: {path, purpose, public_api, depends_on, owner}.',
    '  - path MUST appear in repo_tree; no duplicate paths.',
    '  - public_api: exported symbol names only.',
    '  - depends_on: edges written other/file.ext::symbol (or a bare path); every edge must resolve to a declared file and, when a symbol is named, to that file public_api list.',
    '  - the file-level dependency graph must be ACYCLIC.',
    '- Keep it SMALL and buildable: the fewest files that satisfy every requirement.',
    'Return ONLY the SDS via the structured output schema.',
  ].join(NL)
}
function ctoPrompt(specText, survivors) {
  const parts = [
    'You are the CTO of a repo-generation pipeline. Score each surviving SDS candidate against the requirements. Every candidate below already PASSED deterministic structural validation — judge design quality only.',
    '',
    'Score each candidate with integers 0-2 on: coverage (every requirement addressed), consistency (interfaces coherent, dependencies sensible), feasibility (buildable exactly as specified), modularity (clean ownership and layering). Also count undeclaredAssumptions — requirements the design silently invents. The final selection is arithmetic done by the pipeline, not by you.',
    '',
    '## Requirements',
    specText,
  ]
  for (let i = 0; i < survivors.length; i++) {
    parts.push('')
    parts.push('## Candidate ' + (i + 1) + ' (architect preference: ' + survivors[i].preference + ')')
    parts.push(JSON.stringify(survivors[i].sds, null, 2))
  }
  parts.push('')
  parts.push('Return a scores row for EVERY candidate via the schema; the candidate field is the 1-based number above.')
  return parts.join(NL)
}
function acceptancePrompt(specText, normalized) {
  return [
    'Derive the acceptance criteria for this build: short, testable statements covering every requirement, each mapped to the SDS files that implement it. These feed a deterministic requirement→file→test trace gate — an AC that no test later verifies will BLOCK finalization, so keep each one concretely checkable.',
    '',
    '## Requirements',
    specText,
    '',
    '## SDS files (map ACs onto these paths ONLY)',
    JSON.stringify(normalized.sds.files.map(function (f) { return { path: f.path, purpose: f.purpose, public_api: f.public_api } }), null, 2),
    '',
    'Return via the schema: criteria[] of {id (AC-1, AC-2, ...), text, files[]} — every criterion mapped to at least one SDS path.',
  ].join(NL)
}
function lanePrompt(laneId, owner, files, fileEntries, briefs, specText, techStack) {
  return [
    'You are dev lane ' + laneId + ' (developer handle: ' + owner + ') in a repo-generation pipeline. You work in an ISOLATED git worktree.',
    '',
    '## Non-negotiable scope (deterministically enforced after you finish)',
    '- Create or edit ONLY these files (your exclusive ownership for this step): ' + files.join(', '),
    '- Any other changed path fails the ownership scan and the lane is rejected. Delete every temp or scratch file before you finish.',
    '',
    '## Git protocol',
    '- First: git checkout -b daedalus/' + laneId,
    '- Implement each owned file, then commit it: git add <path> && git commit -m ' + JSON.stringify('daedalus(' + owner + '): <path> — <one-line update_reason>'),
    '- Do NOT touch other branches, do NOT merge, do NOT push.',
    '',
    '## Tech stack',
    techStack,
    '',
    '## Your file specs (implement public_api EXACTLY as declared)',
    JSON.stringify(fileEntries, null, 2),
    '',
    '## Interface briefs from your dependencies (these briefs are your contract — do not read foreign files)',
    briefs.length ? JSON.stringify(briefs, null, 2) : '(none — first layer)',
    '',
    '## Requirements (context)',
    specText,
    '',
    '## Report (structured output)',
    '- branch: the lane branch you created.',
    '- changedPaths: EVERY path you created or modified (git diff --name-only against the branch point, plus files you added). Report honestly — the scan is derived from the diff either way.',
    '- briefs: one per owned file: {file, publicApi, notes} — the interface contract dependents build against.',
    '- commits: one per owned file: {path, update_reason}.',
    '- done: true only if every owned file is implemented and committed.',
  ].join(NL)
}
function integratorPrompt(label, branches, declared) {
  return [
    'You are the integrator for step ' + label + ' of a repo-generation pipeline. You are in the MAIN checkout.',
    'Merge these lane branches into the current branch, IN ORDER, one at a time: ' + branches.join(', '),
    'Protocol per branch: git merge --no-ff <branch>. Exclusive file ownership makes conflicts impossible by construction — if a merge conflicts anyway, run git merge --abort, STOP merging, and report the branch in conflicts; do NOT resolve by hand.',
    'After merging, report mergedPaths = git diff --name-only against the pre-merge HEAD.',
    'Expected file set (merge only — you edit NOTHING yourself): ' + declared.join(', '),
    'Report via the schema: {done, mergedPaths, conflicts}.',
  ].join(NL)
}
function qaPrompt(round, layerIdx, layerFiles, sdsFiles, criteria, specText, focus) {
  return [
    'You are QA (sweep ' + round + ') for layer ' + layerIdx + ' of a freshly generated repo. You work in the MAIN checkout.',
    '',
    '## Task',
    '1. Write MINIMAL temp tests under daedalus-qa/ exercising these files against their declared public_api and the requirements: ' + layerFiles.join(', '),
    focus.length ? '   Focus especially on recently repaired or requeued files: ' + focus.join(', ') : '   (first coverage of this layer — spread it evenly)',
    '2. Run them.',
    '3. DELETE daedalus-qa/ afterwards. Leftover paths fail the phase scan.',
    '',
    '## Report (structured output)',
    '- issues[]: one per REAL failure: {symptom, traceback, suspectedFiles, symbol, publicApiImpact}. suspectedFiles come from the SDS file list only; set symbol when the failure names an exported symbol; publicApiImpact=true ONLY when a public interface, import path, or shared config is wrong (it requeues dependents).',
    '- verified[]: acceptance criteria your tests confirmed: {acId, test}. Use the AC ids below.',
    '- leftoverPaths: any paths you could not clean up (MUST be empty).',
    '',
    '## Acceptance criteria',
    JSON.stringify(criteria, null, 2),
    '',
    '## SDS files (the suspects vocabulary)',
    JSON.stringify(sdsFiles, null, 2),
    '',
    '## Requirements',
    specText,
  ].join(NL)
}
function repairPrompt(laneId, owner, files, routed, specText) {
  return [
    'You are repair lane ' + laneId + ' (developer handle: ' + owner + ') in a repo-generation pipeline. You work in an ISOLATED git worktree.',
    '',
    '## Non-negotiable scope (deterministically enforced)',
    '- Edit ONLY these files (repair routing assigned them to you): ' + files.join(', '),
    '- Minimal repair: fix the routed issues, change nothing else.',
    '',
    '## Routed issues (root-cause routed by the deterministic control plane)',
    JSON.stringify(routed.map(function (r) { return { targetFile: r.route.targetFile, decidedBy: r.route.decidedBy, rationale: r.route.rationale, symptom: r.issue.symptom, traceback: r.issue.traceback || '' } }), null, 2),
    '',
    '## Git protocol',
    '- First: git checkout -b daedalus/' + laneId,
    '- Commit each repaired file: git add <path> && git commit -m ' + JSON.stringify('daedalus(' + owner + '): <path> — <one-line update_reason>'),
    '',
    '## Requirements (context)',
    specText,
    '',
    '## Report (structured output): {done, branch, changedPaths, briefs (refreshed for repaired files), commits}.',
  ].join(NL)
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase: Preflight — deterministic size class, roster and
// spend band BEFORE any agent exists; the accept gate is the explicit launch
// action. Zero agents run in this phase.
// ═════════════════════════════════════════════════════════════════════════════
function sizeClassOf(text) {
  const t = text.toLowerCase()
  const lines = text.split(NL).filter(function (l) { return l.trim() })
  const bullets = lines.filter(function (l) { return /^\\s*([-*+]|\\d+[.)])\\s+/.test(l) }).length
  const criteria = Math.max(bullets, (t.match(/\\bmust\\b|\\bshould\\b|\\brequire/g) || []).length)
  // DISTINCT component kinds ("cli" three times is one component, not three).
  const componentSet = {}
  for (const w of (t.match(/\\b(module|service|component|cli|api|server|client|library|package|ui|frontend|backend|database|worker|queue)\\b/g) || [])) componentSet[w] = true
  const componentWords = Object.keys(componentSet).length
  const words = t.split(/\\s+/).length
  const reasons = ['criteria~' + criteria, 'distinct-components=' + componentWords, 'words=' + words]
  let cls = 'large'
  if (criteria <= 2 && componentWords <= 1 && words <= 120) cls = 'tiny'
  else if (criteria <= 4 && componentWords <= 3 && words <= 300) cls = 'small'
  else if (criteria <= 7 && words <= 700) cls = 'medium'
  return { cls: cls, reasons: reasons }
}
const SPEC_PRE = preprocessRequirements(REQUIREMENTS_RAW)
const SIZE = sizeClassOf(SPEC_PRE.text)
const ARCHITECTS_BY_CLASS = { tiny: 1, small: 2, medium: 3, large: 4 }
const QA_BY_CLASS = { tiny: 1, small: 1, medium: 2, large: 2 }
const N_ARCHITECTS = ARCHITECTS_BY_CLASS[SIZE.cls]
const QA_ROUND_CAP = QA_BY_CLASS[SIZE.cls]
const AGENT_BAND = { tiny: '3-5', small: '5-9', medium: '8-13', large: '11-17' }[SIZE.cls]
const TOKEN_BAND = { tiny: '~80-250k', small: '~200-500k', medium: '~400-800k', large: '~700k-1.3M' }[SIZE.cls]

phase('Preflight')
if (SPEC_PRE.text.length < 80) {
  return { launched: false, needsClarification: ['the brief is too thin to derive a valid design contract — one bounded clarification: what should the generated project DO, with 2-3 concrete acceptance criteria and the intended runtime (CLI / service / library)?'] }
}
const preflight = {
  sizeClass: SIZE.cls,
  why: SIZE.reasons,
  roster: { architects: N_ARCHITECTS, qaRoundCap: QA_ROUND_CAP, planningModel: MODEL + ' (' + MODEL_SOURCE + ')', buildingModel: EXECUTOR_MODEL + ' (' + EXEC_SOURCE + ')' },
  expected: { agentBand: AGENT_BAND, tokenBand: TOKEN_BAND, phases: ['Spec', 'Design', 'Implement', 'Test', 'Finalize'] },
  resume: 'a resumed run replays completed agents from the journal; themis checks re-run live',
}
log('Preflight: ' + SIZE.cls + ' (' + SIZE.reasons.join(', ') + ') -> ' + N_ARCHITECTS + ' architect(s), QA cap ' + QA_ROUND_CAP + ', agents ' + AGENT_BAND + ', tokens ' + TOKEN_BAND)
if (!ACCEPTED) {
  return { launched: false, preflight: preflight, next: 'review the preflight with the operator, then relaunch with the SAME args plus accept=true to dispatch the fleet' }
}

// ═════════════════════════════════════════════════════════════════════════════
// Phase: Spec — deterministic preprocessing; the machine + trace table open.
// ═════════════════════════════════════════════════════════════════════════════
phase('Spec')
await must('init', {
  phases: [
    { name: 'spec' },
    { name: 'design', reviewRequired: true },
    { name: 'impl' },
    { name: 'test' },
    { name: 'finalize' },
  ],
  iterationCap: QA_ROUND_CAP,
})
await must('start', { phase: 'spec' })
const spec = SPEC_PRE
const specHash = fnv1a(spec.text)
await themis.traceUpdate({ op: 'specHash', hash: specHash })
log('Spec: ' + spec.sections + ' section marker(s), ' + spec.text.length + ' chars, spec-hash ' + specHash)
await must('end', { phase: 'spec' })

// ═════════════════════════════════════════════════════════════════════════════
// Phase: Design — N independent architects; the CTO acts only on the
// deterministically validated survivor set; the selection is arithmetic.
// ═════════════════════════════════════════════════════════════════════════════
phase('Design')
await must('start', { phase: 'design' })
if (budgetLow()) throw new Error('DAEDALUS: token budget floor reached before Design — refusing to start the fleet')

const drafts = []
const claimed = []
for (let ai = 0; ai < N_ARCHITECTS; ai++) {
  const pref = DESIGN_PREFERENCES[ai % DESIGN_PREFERENCES.length]
  const draft = await agent(architectPrompt(spec.text, pref, claimed), {
    label: 'architect:' + (ai + 1), phase: 'Design', model: MODEL, schema: SDS_SCHEMA,
  })
  if (!draft) { log('Design: architect ' + (ai + 1) + ' returned nothing — continuing with the rest'); continue }
  drafts.push({ index: ai, preference: pref, sds: draft })
  for (const f of (draft.files || [])) {
    const top = normPath(String(f.path || '')).split('/')[0]
    if (top && claimed.indexOf(top) === -1) claimed.push(top)
  }
}
if (!drafts.length) throw new Error('DAEDALUS: all ' + N_ARCHITECTS + ' architects failed to produce a draft')

// CTO stage 1 — the deterministic filter (invalid candidates logged + excluded).
const surviving = []
const excluded = []
for (const d of drafts) {
  const v = await themis.validateSDS(d.sds)
  if (v && v.ok === true) {
    surviving.push({ index: d.index, preference: d.preference, sds: v.sds })
  } else {
    const kinds = v && v.errors ? v.errors.map(function (e) { return e.kind }) : ['NO_VERDICT']
    excluded.push({ architect: d.index + 1, errors: kinds })
    log('Design: architect ' + (d.index + 1) + ' draft EXCLUDED by deterministic validation: ' + kinds.join(', '))
  }
}
if (!surviving.length) throw new Error('DAEDALUS: no draft survived deterministic SDS validation — the requirements may be too vague for a structurally valid design; refine and rerun')

// CTO stage 2 — LLM scores the survivors; the script does the arithmetic
// (total desc, undeclared assumptions asc, dependency fan-out asc, index asc).
const ranking = []
if (surviving.length === 1) {
  log('Design: single survivor — skipping the scoring panel')
  ranking.push({ candidate: 1, total: 0, assumptions: 0, edges: edgeCount(surviving[0].sds) })
} else {
  const scored = await agent(ctoPrompt(spec.text, surviving), {
    label: 'cto:score', phase: 'Design', model: MODEL, schema: CTO_SCORE_SCHEMA,
  })
  const rows = scored && Array.isArray(scored.candidates) ? scored.candidates : []
  if (!rows.length) log('Design: CTO scorer returned nothing — selection falls back to the structural tie-breaks (assumptions, fan-out, index)')
  for (let ci = 0; ci < surviving.length; ci++) {
    const row = rows.find(function (r) { return r && Number(r.candidate) === ci + 1 }) || null
    const s = row && row.scores ? row.scores : {}
    ranking.push({
      candidate: ci + 1,
      total: clampScore(s.coverage) + clampScore(s.consistency) + clampScore(s.feasibility) + clampScore(s.modularity),
      assumptions: row && isFinite(Number(row.undeclaredAssumptions)) ? Math.max(0, Math.round(Number(row.undeclaredAssumptions))) : 99,
      edges: edgeCount(surviving[ci].sds),
    })
  }
  ranking.sort(function (a, b) {
    return b.total - a.total || a.assumptions - b.assumptions || a.edges - b.edges || a.candidate - b.candidate
  })
}
const winner = surviving[ranking[0].candidate - 1]
log('Design: winner is architect ' + (winner.index + 1) + ' (' + winner.preference + '), score ' + ranking[0].total + '/8')
const normalized = await themis.normalizeSDS(winner.sds)
if (!normalized) throw new Error('DAEDALUS: normalizeSDS refused the selected draft on revalidation — refusing to build on it')

// Acceptance criteria → the trace table (files linked now, tests linked by QA).
const acc = await agent(acceptancePrompt(spec.text, normalized), {
  label: 'cto:acceptance', phase: 'Design', model: MODEL, schema: ACCEPTANCE_SCHEMA,
})
if (!acc || !Array.isArray(acc.criteria) || acc.criteria.length === 0) {
  throw new Error('DAEDALUS: no acceptance criteria produced — the trace gate would be vacuous; refusing')
}
const criteriaSummary = []
for (const c of acc.criteria) {
  const cid = String(c.id || '')
  if (!cid) continue
  await themis.traceUpdate({ op: 'criterion', id: cid, text: String(c.text || '') })
  const dropped = []
  for (const p0 of (c.files || [])) {
    const p = normPath(String(p0))
    if (hasOwn(normalized.ownership, p)) await themis.traceUpdate({ op: 'file', acId: cid, path: p })
    else dropped.push(p)
  }
  if (dropped.length) log('Design: AC ' + cid + ' referenced ' + dropped.length + ' path(s) outside the SDS (dropped): ' + dropped.join(', '))
  criteriaSummary.push({ id: cid, text: String(c.text || '') })
}
await must('review', { phase: 'design', verdict: 'approved' })
await must('end', { phase: 'design' })

// ═════════════════════════════════════════════════════════════════════════════
// Phase: Implement — Kahn layers; per layer: parallel worktree lanes (grouped
// by owner), derived ownership + task-scope scans, one requeue, then a single
// sequential integrator whose merge is scanned again.
// ═════════════════════════════════════════════════════════════════════════════
phase('Implement')
await must('start', { phase: 'impl' })
const layers = await themis.topoLayers(normalized.depGraph)
if (!layers) throw new Error('DAEDALUS: topoLayers returned null on a validated SDS — a cycle slipped through; refusing')
const prio = await themis.taskPriority({ depGraph: normalized.depGraph, sdsOrder: normalized.sds.files.map(function (f) { return f.path }) })
const prioRank = {}
for (let i = 0; i < prio.length; i++) prioRank[prio[i].path] = i
const byPath = {}
for (const f of normalized.sds.files) byPath[f.path] = f

const briefsByFile = {}
const laneRecords = []
const mergedTotal = []

async function recordBriefs(laneId, briefs) {
  for (const b of (briefs || [])) {
    const bf = normPath(String(b.file || ''))
    if (!hasOwn(byPath, bf)) continue
    const brief = { file: bf, publicApi: Array.isArray(b.publicApi) ? b.publicApi : [], notes: String(b.notes || '') }
    briefsByFile[bf] = brief
    // Slice B bridge: cross-agent memory — an honest no-op while MERCURY_MNEME is off.
    await themis.observe({
      text: '[daedalus ' + laneId + '] ' + bf + ' — api: ' + brief.publicApi.join(', ') + ' — ' + brief.notes,
      source: 'daedalus',
      topicHint: 'daedalus-briefs',
    })
  }
}
async function runLane(li, owner, files, attempt) {
  const laneId = 'L' + li + '-' + owner + (attempt > 1 ? '-r' + attempt : '')
  await must('delegation', { phase: 'impl', receipt: { id: laneId, wroteFiles: true, received: false } })
  const entries = files.map(function (p) { return byPath[p] })
  const depBriefs = []
  for (const p of files) {
    for (const d of (normalized.depGraph[p] || [])) {
      if (briefsByFile[d]) depBriefs.push(briefsByFile[d])
    }
  }
  const res = await agent(lanePrompt(laneId, owner, files, entries, dedupeBriefs(depBriefs), spec.text, normalized.sds.tech_stack), {
    label: 'lane:' + laneId, phase: 'Implement', model: EXECUTOR_MODEL, isolation: 'worktree', schema: LANE_SCHEMA,
  })
  await must('delegation', { phase: 'impl', receipt: { id: laneId, wroteFiles: true, received: true } })
  return { laneId: laneId, res: res }
}
// The derived checks (P1 shape): exclusive ownership over the FULL changed set,
// then exact task scope — both host-side set arithmetic over the reported diff.
async function verifyLane(owner, files, lane) {
  if (!lane || !lane.res || lane.res.done !== true) return { ok: false, why: 'lane returned nothing or done!=true' }
  const changed = (lane.res.changedPaths || []).map(normPath)
  const own = await themis.verifyOwnership({ ownership: normalized.ownership, lane: { owner: owner, changedPaths: changed } })
  if (!own || own.ok !== true) return { ok: false, why: 'ownership violations: ' + JSON.stringify(own ? own.violations : null) }
  const scope = await themis.scanDiff({ declared: files, actual: changed })
  if (!scope || scope.ok !== true || scope.missing.length) {
    return { ok: false, why: 'task-scope violation — undeclared: [' + (scope ? scope.undeclared.join(', ') : '?') + '] missing: [' + (scope ? scope.missing.join(', ') : '?') + ']' }
  }
  if (typeof lane.res.branch !== 'string' || !lane.res.branch) return { ok: false, why: 'no lane branch reported' }
  return { ok: true }
}

for (let li = 0; li < layers.length; li++) {
  if (budgetLow()) throw new Error('DAEDALUS: token budget floor reached before layer ' + li + ' — stopping rather than half-building')
  const layerFiles = layers[li].slice().sort(function (a, b) { return prioRank[a] - prioRank[b] })
  const byOwner = {}
  for (const p of layerFiles) {
    const o = normalized.ownership[p]
    if (!byOwner[o]) byOwner[o] = []
    byOwner[o].push(p)
  }
  const owners = Object.keys(byOwner).sort()
  log('Implement: layer ' + li + ' — ' + layerFiles.length + ' file(s), ' + owners.length + ' lane(s): ' + owners.join(', '))

  const firstPass = await parallel(owners.map(function (o) {
    return function () { return runLane(li, o, byOwner[o], 1) }
  }))
  const approved = []
  for (let oi = 0; oi < owners.length; oi++) {
    const owner = owners[oi]
    const files = byOwner[owner]
    let lane = firstPass[oi]
    let verdict = await verifyLane(owner, files, lane)
    if (!verdict.ok) {
      log('Implement: lane L' + li + '-' + owner + ' REJECTED (' + verdict.why + ') — requeueing once')
      lane = await runLane(li, owner, files, 2)
      verdict = await verifyLane(owner, files, lane)
    }
    if (!verdict.ok) {
      await must('scan', { phase: 'impl', status: 'dirty' })
      throw new Error('DAEDALUS: lane L' + li + '-' + owner + ' failed twice (' + verdict.why + ') — aborting; lane branches are preserved for inspection')
    }
    approved.push({ laneId: lane.laneId, owner: owner, files: files, branch: lane.res.branch, changedPaths: (lane.res.changedPaths || []).map(normPath), briefs: lane.res.briefs || [], commits: lane.res.commits || [] })
  }

  // ONE sequential integrator per layer (concurrent merges in the main
  // checkout would race the git index), then the derived merge-scope scan.
  const declaredUnion = []
  for (const a of approved) {
    for (const p of a.changedPaths) if (declaredUnion.indexOf(p) === -1) declaredUnion.push(p)
  }
  const intId = 'I' + li
  await must('delegation', { phase: 'impl', receipt: { id: intId, wroteFiles: true, received: false } })
  const merged = await agent(integratorPrompt('layer-' + li, approved.map(function (a) { return a.branch }), declaredUnion), {
    label: 'integrate:L' + li, phase: 'Implement', model: EXECUTOR_MODEL, schema: INTEGRATE_SCHEMA,
  })
  await must('delegation', { phase: 'impl', receipt: { id: intId, wroteFiles: true, received: true } })
  if (!merged || merged.done !== true || (merged.conflicts || []).length) {
    await must('scan', { phase: 'impl', status: 'dirty' })
    throw new Error('DAEDALUS: integration of layer ' + li + ' failed — conflicts: ' + JSON.stringify(merged ? merged.conflicts : null) + '. A conflict under exclusive ownership means an ownership scan missed something; refusing to continue.')
  }
  const mergeScan = await themis.scanDiff({ declared: declaredUnion, actual: (merged.mergedPaths || []).map(normPath) })
  if (!mergeScan || mergeScan.ok !== true) {
    await must('scan', { phase: 'impl', status: 'dirty' })
    throw new Error('DAEDALUS: integrator merged paths outside the approved set: ' + (mergeScan ? mergeScan.undeclared.join(', ') : '?'))
  }
  if (mergeScan.missing.length) {
    log('Implement: integrator reports ' + mergeScan.missing.length + ' approved path(s) absent from the merge diff (identical content or already present): ' + mergeScan.missing.join(', '))
  }
  for (const a of approved) {
    laneRecords.push({ laneId: a.laneId, owner: a.owner, files: a.files, branch: a.branch })
    await recordBriefs(a.laneId, a.briefs)
    for (const p of a.changedPaths) if (mergedTotal.indexOf(p) === -1) mergedTotal.push(p)
  }
}
// The impl scan gate: every lane and every merge passed its derived scan
// (any dirtiness threw above), so the phase-machine scan is honestly clean.
await must('scan', { phase: 'impl', status: 'clean' })
await must('end', { phase: 'impl' })

// ═════════════════════════════════════════════════════════════════════════════
// Phase: Test — QA sweeps per layer; deterministic repair routing; repairs are
// worktree lanes merged by one sequential integrator; hard cap 2 repair rounds
// (mirrored by the machine's iteration cap). Termination: clean ∨ cap ∨ budget.
// ═════════════════════════════════════════════════════════════════════════════
phase('Test')
await must('start', { phase: 'test' })
const sdsFilesSummary = normalized.sds.files.map(function (f) { return { path: f.path, public_api: f.public_api, owner: f.owner } })
let qaSweeps = 0
let repairRounds = 0
let issuesRepaired = 0
let openIssues = []
let requeueFocus = []
let testScanClean = true

async function runRepairLane(owner, routed, round) {
  const files = []
  for (const r of routed) if (files.indexOf(r.route.targetFile) === -1) files.push(r.route.targetFile)
  const laneId = 'R' + round + '-' + owner
  await must('delegation', { phase: 'test', receipt: { id: laneId, wroteFiles: true, received: false } })
  const res = await agent(repairPrompt(laneId, owner, files, routed, spec.text), {
    label: 'repair:' + laneId, phase: 'Test', model: EXECUTOR_MODEL, isolation: 'worktree', schema: LANE_SCHEMA,
  })
  await must('delegation', { phase: 'test', receipt: { id: laneId, wroteFiles: true, received: true } })
  if (!res || res.done !== true) return { ok: false, why: 'repair lane returned nothing or done!=true', files: files }
  const changed = (res.changedPaths || []).map(normPath)
  const own = await themis.verifyOwnership({ ownership: normalized.ownership, lane: { owner: owner, changedPaths: changed } })
  if (!own || own.ok !== true) return { ok: false, why: 'repair ownership violations: ' + JSON.stringify(own ? own.violations : null), files: files }
  const scope = await themis.scanDiff({ declared: files, actual: changed })
  if (!scope || scope.ok !== true) return { ok: false, why: 'repair scope violation — undeclared: ' + (scope ? scope.undeclared.join(', ') : '?'), files: files }
  return { ok: true, laneId: laneId, owner: owner, files: files, branch: res.branch, changedPaths: changed, briefs: res.briefs || [] }
}

for (;;) {
  if (budgetLow()) { log('QA: token budget floor reached — stopping the loop'); break }
  qaSweeps++
  const sweepIssues = []
  const qaLeftover = []
  for (let li = 0; li < layers.length; li++) {
    const qaId = 'QA' + qaSweeps + '-L' + li
    await must('delegation', { phase: 'test', receipt: { id: qaId, wroteFiles: true, received: false } })
    const qa = await agent(qaPrompt(qaSweeps, li, layers[li], sdsFilesSummary, criteriaSummary, spec.text, requeueFocus), {
      label: 'qa:' + qaId, phase: 'Test', model: MODEL, schema: QA_SCHEMA,
    })
    await must('delegation', { phase: 'test', receipt: { id: qaId, wroteFiles: true, received: true } })
    if (!qa) { sweepIssues.push({ symptom: 'QA agent for layer ' + li + ' returned nothing', suspectedFiles: layers[li] }); continue }
    for (const v of (qa.verified || [])) {
      if (v && typeof v.acId === 'string' && typeof v.test === 'string') {
        await themis.traceUpdate({ op: 'test', acId: v.acId, test: v.test })
        await themis.traceUpdate({ op: 'status', acId: v.acId, status: 'verified' })
      }
    }
    for (const p of (qa.leftoverPaths || [])) qaLeftover.push(normPath(p))
    for (const iss of (qa.issues || [])) sweepIssues.push(iss)
  }
  if (qaLeftover.length) {
    testScanClean = false
    log('QA: leftover temp paths not cleaned: ' + qaLeftover.join(', '))
  }
  requeueFocus = []
  if (sweepIssues.length === 0) { openIssues = []; log('QA: sweep ' + qaSweeps + ' clean'); break }
  log('QA: sweep ' + qaSweeps + ' found ' + sweepIssues.length + ' issue(s)')
  if (repairRounds >= QA_ROUND_CAP) {
    openIssues = sweepIssues
    log('QA: repair round cap ' + QA_ROUND_CAP + ' reached — surfacing ' + sweepIssues.length + ' open issue(s); P2 convergence says further rounds are not worth their cost')
    break
  }
  const bump = await themis.phase({ op: 'iteration' })
  if (!bump || bump.ok !== true) {
    openIssues = sweepIssues
    log('QA: THEMIS iteration cap refused another repair round — surfacing open issues')
    break
  }
  repairRounds++

  // Deterministic root-cause routing; non-SDS suspects are dropped LOUDLY.
  const routes = []
  for (const iss of sweepIssues) {
    const route = await themis.routeRepair({ issue: iss, normalized: normalized })
    if (!route) { log('QA: issue dropped — no suspected file resolves into the SDS: ' + String(iss.symptom).slice(0, 120)); continue }
    routes.push({ issue: iss, route: route })
  }
  if (!routes.length) { openIssues = sweepIssues; log('QA: no issue routed into the SDS — surfacing'); break }
  const byRepairOwner = {}
  for (const r of routes) {
    if (!byRepairOwner[r.route.owner]) byRepairOwner[r.route.owner] = []
    byRepairOwner[r.route.owner].push(r)
  }
  const repairOwners = Object.keys(byRepairOwner).sort()
  const repairResults = await parallel(repairOwners.map(function (o) {
    return function () { return runRepairLane(o, byRepairOwner[o], repairRounds) }
  }))
  const okRepairs = []
  for (let ri = 0; ri < repairOwners.length; ri++) {
    const rr = repairResults[ri]
    if (!rr || rr.ok !== true) {
      testScanClean = false
      openIssues.push({ symptom: 'repair lane for ' + repairOwners[ri] + ' failed: ' + (rr && rr.why ? rr.why : 'returned nothing'), suspectedFiles: byRepairOwner[repairOwners[ri]].map(function (r) { return r.route.targetFile }) })
    } else {
      okRepairs.push(rr)
      issuesRepaired += byRepairOwner[repairOwners[ri]].length
    }
  }
  if (openIssues.length) break // a failed repair lane is terminal — surface it
  // One sequential integrator for the round's repair branches, scan the merge.
  if (okRepairs.length) {
    const declaredUnion = []
    for (const rr of okRepairs) for (const p of rr.changedPaths) if (declaredUnion.indexOf(p) === -1) declaredUnion.push(p)
    const intId = 'IR' + repairRounds
    await must('delegation', { phase: 'test', receipt: { id: intId, wroteFiles: true, received: false } })
    const merged = await agent(integratorPrompt('repair-round-' + repairRounds, okRepairs.map(function (r) { return r.branch }), declaredUnion), {
      label: 'integrate:' + intId, phase: 'Test', model: EXECUTOR_MODEL, schema: INTEGRATE_SCHEMA,
    })
    await must('delegation', { phase: 'test', receipt: { id: intId, wroteFiles: true, received: true } })
    if (!merged || merged.done !== true || (merged.conflicts || []).length) {
      testScanClean = false
      openIssues = sweepIssues
      log('QA: repair integration failed — surfacing the round issues')
      break
    }
    const mergeScan = await themis.scanDiff({ declared: declaredUnion, actual: (merged.mergedPaths || []).map(normPath) })
    if (!mergeScan || mergeScan.ok !== true) {
      testScanClean = false
      openIssues = sweepIssues
      log('QA: repair merge touched paths outside the approved set: ' + (mergeScan ? mergeScan.undeclared.join(', ') : '?'))
      break
    }
    for (const rr of okRepairs) await recordBriefs(rr.laneId, rr.briefs)
  }
  // Dependents requeue ONLY on declared public-API/import/shared-config impact.
  for (const r of routes) {
    if (r.route.requeueDependents) {
      for (const p of Object.keys(normalized.depGraph)) {
        if ((normalized.depGraph[p] || []).indexOf(r.route.targetFile) !== -1 && requeueFocus.indexOf(p) === -1) requeueFocus.push(p)
      }
    }
  }
  if (requeueFocus.length) log('QA: requeued dependents for the next sweep: ' + requeueFocus.join(', '))
}
const testClean = testScanClean && openIssues.length === 0
await must('scan', { phase: 'test', status: testClean ? 'clean' : 'dirty' })
if (testClean) await must('end', { phase: 'test' })

// ═════════════════════════════════════════════════════════════════════════════
// Phase: Finalize — the trace-complete gate (an AC without a verifying test
// BLOCKS finalization) + the deterministic run summary. No LLM in this phase.
// ═════════════════════════════════════════════════════════════════════════════
phase('Finalize')
let traceVerdict = null
let finalized = false
if (testClean) {
  await must('start', { phase: 'finalize' })
  traceVerdict = await themis.verifyTrace({})
  if (traceVerdict && traceVerdict.ok === true) {
    await must('end', { phase: 'finalize' })
    finalized = true
  } else {
    log('Finalize: trace-complete gate REFUSED — ' + JSON.stringify(traceVerdict ? traceVerdict.violations : null))
  }
} else {
  // Still record the trace verdict (and its audit row) for the summary.
  traceVerdict = await themis.verifyTrace({})
  log('Finalize: skipped — the test phase did not close clean')
}
const machineState = await themis.phase({ op: 'state' })
return {
  ok: finalized,
  launched: true,
  preflight: preflight,
  models: { model: MODEL, executorModel: EXECUTOR_MODEL, modelSource: MODEL_SOURCE, executorModelSource: EXEC_SOURCE },
  specHash: specHash,
  design: {
    architects: N_ARCHITECTS,
    drafts: drafts.length,
    survivors: surviving.length,
    excluded: excluded,
    winner: { architect: winner.index + 1, preference: winner.preference, files: normalized.sds.files.length, developers: normalized.sds.developer_plan },
  },
  implementation: { layers: layers.length, lanes: laneRecords, mergedPaths: mergedTotal },
  qa: { sweeps: qaSweeps, repairRounds: repairRounds, repaired: issuesRepaired, openIssues: openIssues },
  trace: traceVerdict,
  phaseMachine: machineState,
  audit: 'THEMIS audit rows recorded under .mercury/themis/ (actor: workflow)',
}
`
