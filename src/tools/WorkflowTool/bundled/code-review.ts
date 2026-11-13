
/* eslint-disable */

export const CODE_REVIEW_WORKFLOW_SCRIPT = `export const meta = {
  name: "code-review",
  description: "Multi-lens code review — a finder crewmate per review lens, an independent verifier on every candidate, then one ranked and capped report.",
  whenToUse: "Invoked via Workflow({name: \\"code-review\\", args}) when workflows are enabled. String args: \\"<level> [target]\\" — level: high (default), xhigh, or max; target (optional): PR number, branch, ref range, path, or instructions (\\"only review src/net/\\", \\"focus on concurrency\\"). Object args: {level?, target?, model?, verifierModel?} (any session model id/alias; verifierModel routes the verification lane).",
  phases: [{"title":"Scope","detail":"Settle the diff command, the file list, and the conventions"},{"title":"Find","detail":"A finder per lens (correctness + quality); results stream straight into verification"},{"title":"Verify","detail":"Every candidate faces its own verifier — CONFIRMED / PLAUSIBLE / REFUTED"},{"title":"Sweep","detail":"A gap hunt by one clean-context finder (xhigh/max)"},{"title":"Synthesize","detail":"Fold duplicates, rank by severity, cap the report"}],
}

// Harness size per level:
//   high  → 3 correctness lenses, 6 candidates each, report capped at 10, no sweep
//   xhigh → 5 lenses, 8 each, sweep on, report capped at 15
//   max   → the xhigh fan-out (those two differ in request-level reasoning effort, not here)
const LEVELS = {
  high: { lenses: 3, perLens: 6, reportCap: 10, sweep: false },
  xhigh: { lenses: 5, perLens: 8, reportCap: 15, sweep: true },
  max: { lenses: 5, perLens: 8, reportCap: 15, sweep: true },
}
const VERIFY_BUDGET = 25
const SWEEP_EXTRA = 8

// Args: "<level> [target]" as a string, or {level?, target?, model?, verifierModel?}.
// Level detection uses an own-property test so prototype key names
// ("constructor", "toString") can never masquerade as a level.
const IS_OBJ = typeof args === "object" && args !== null
const RAW = (typeof args === "string" ? args : (IS_OBJ && typeof args.target === "string" ? args.target : "")).trim()
const HEAD = RAW.split(/\\s+/)[0] || ""
const HEAD_IS_LEVEL = !IS_OBJ && Object.prototype.hasOwnProperty.call(LEVELS, HEAD)
const OBJ_LEVEL = IS_OBJ && typeof args.level === "string" && Object.prototype.hasOwnProperty.call(LEVELS, args.level) ? args.level : undefined
const LEVEL = OBJ_LEVEL || (HEAD_IS_LEVEL ? HEAD : "high")
const TARGET = IS_OBJ ? RAW : (HEAD_IS_LEVEL ? RAW.slice(HEAD.length).trim() : RAW)
const SIZE = LEVELS[LEVEL]

// Optional model routing (object form only). Absent knobs add no model key
// anywhere, so plain launches behave exactly as before.
const pickModel = v => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const LANE_MODEL = IS_OBJ ? pickModel(args.model) : undefined
const CHECK_MODEL = (IS_OBJ ? pickModel(args.verifierModel) : undefined) || LANE_MODEL
const withModel = (opts, m) => (m ? { ...opts, model: m } : opts)

// ─── The review lenses ───
// Five correctness lenses; the level picks how many lead the roster.
const CORRECTNESS_LENSES = [
  { label: "hunk-read", brief: "### Lens: hunk-by-hunk read\\n\\nWalk each hunk line by line and Read its whole enclosing function (defects on untouched lines of a touched function are in scope when re-exposed by the change). Test each line against inputs, state, timing, and platform: inverted/misaimed conditions, boundary off-by-ones, null/undefined dereferences, missing \`await\`, zero treated as absent, copy-paste wrong variables, swallowed catches, unescaped regex metacharacters.\\n" },
  { label: "lost-guards", brief: "### Lens: deleted protections\\n\\nFor every removed or rewritten line, identify the invariant or behavior it enforced and verify where that protection lives in the new code. Flag any vanished guard, dropped error path, narrowed validation, or deleted test that still covered real behavior.\\n" },
  { label: "call-sites", brief: "### Lens: across file boundaries\\n\\nFor every touched function, Grep its callers and test each call site against new preconditions, changed return shapes, new throws, or ordering/timing assumptions; then check callees for sibling changes in this diff that made a call unsafe.\\n" },
  { label: "lang-traps", brief: "### Lens: language traps\\n\\nCheck instances the diff introduces of language/framework traps: JS falsy-zero, loose-equality coercion, loop-variable closure capture; Python mutable defaults and late-bound closures; Go nil-map writes and range-variable capture; string-built SQL; timezone/DST arithmetic; float equality.\\n" },
  { label: "delegation", brief: "### Lens: wrapper delegation\\n\\nWhen adding or editing a wrapper (cache, proxy, decorator, adapter), verify each method delegates to the held inner object rather than resolving back through a registry, session, or global that re-enters or recurses (e.g. calling \`session.get(...)\` instead of \`inner.get(...)\`), and forwards every method callers use.\\n" },
]
// Four quality lenses; the labels double as finding categories downstream.
const QUALITY_LENSES = [
  { label: "reuse", brief: "### Reuse\\n\\nFlag new code that rebuilds an existing helper. Grep shared/utility modules and neighboring files, and name the helper it should call.\\n" },
  { label: "simplification", brief: "### Simplification\\n\\nFlag needless complexity: stored state derivable on demand, near-duplicate copy-paste, deep nesting a guard clause flattens, or dead code. Name the leaner shape.\\n" },
  { label: "efficiency", brief: "### Efficiency\\n\\nFlag wasted work: repeated computation or I/O, independent work serialized, blocking work on startup or hot paths, or long-lived closures pinning a large enclosing scope (replace with a small class/struct holding only needed fields). Name the cheaper alternative.\\n" },
  { label: "altitude", brief: "### Altitude\\n\\nFlag shallow fixes that bolt special cases onto shared infrastructure instead of generalizing the underlying mechanism.\\n" },
]

const VERDICT_RUNGS = "- **CONFIRMED** — name the triggering inputs/state and the resulting crash or bad output; quote the guilty line.\\n- **PLAUSIBLE** — real mechanism whose trigger depends on uncertain timing, environment, or config; state what evidence settles it.\\n- **REFUTED** — factually wrong or already guarded; quote the disproving line."
const RECALL_GUARD = "**Default to PLAUSIBLE** whenever a runtime state is realistic: concurrency races, rare-but-reachable nil/undefined paths (error handlers, cold caches, omitted optionals), zero treated as absent, unexcluded boundary off-by-ones, retry storms/partial failures, or unanchored regexes/allowlists.\\n\\nRule **REFUTED** only from code proof: factually wrong (quote the line), provably unreachable by type/constant/invariant, guarded in this diff (cite the guard), or purely stylistic with no observable effect."
const QUALITY_COST_NOTE = "Use {file, line, summary} and put the concrete duplication, waste, or maintenance cost in \`failure_scenario\`. Correctness bugs outrank quality findings when capped.\\n"
const SWEEP_TARGETS = "moved/extracted code that lost a guard or anchor; definition-time default evaluation, \`hash()\` nondeterminism, shrunk lock scopes, mutating predicates; test setup/teardown asymmetry; flipped config defaults."
// ─── Schemas ───
const BOUNDS_SCHEMA = {
  type: "object",
  required: ["diffCommand", "files", "summary"],
  properties: {
    diffCommand: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    conventions: { type: "string" },
  },
}
const LEADS_SCHEMA = {
  type: "object",
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "summary", "failure_scenario"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          summary: { type: "string" },
          failure_scenario: { type: "string" },
        },
      },
    },
  },
}
const RULING_SCHEMA = {
  type: "object",
  required: ["verdict", "evidence"],
  properties: {
    verdict: { enum: ["CONFIRMED", "PLAUSIBLE", "REFUTED"] },
    evidence: { type: "string" },
  },
}
const DIGEST_SCHEMA = {
  type: "object",
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "summary", "failure_scenario", "verdict"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          summary: { type: "string" },
          failure_scenario: { type: "string" },
          verdict: { enum: ["CONFIRMED", "PLAUSIBLE"] },
        },
      },
    },
  },
}

// ─── Scope ───
phase("Scope")
const scope = await agent(
  "Scope a code review.\\n\\n" +
  (TARGET
    ? "User target/instructions: \\"" + TARGET + "\\". For a PR number, branch, ref range, or path, build the matching git diff command. For free-form instructions, honor every restriction and cover open scope with the branch diff ('git diff @{upstream}...HEAD', else 'git diff main...HEAD', else 'git diff HEAD~1').\\n"
    : "No target given: cover the current branch ('git diff @{upstream}...HEAD', else 'git diff main...HEAD', else 'git diff HEAD~1'; include 'git diff HEAD' if uncommitted changes exist).\\n") +
  "\\n1. Choose and RUN the diff command(s); confirm non-empty output.\\n" +
  "2. List every changed file and summarize the change in one paragraph.\\n" +
  "3. Read project instruction files near the changed code (MERCURY.md, or AGENTS.md where the project keeps its conventions there) and note review-relevant conventions.\\n\\n" +
  "Return a shell-ready diffCommand via structured output only.",
)
if (!scope) {
  return { error: "The scoping agent produced nothing — the review has no diff to work from." }
}
if (!scope.files || scope.files.length === 0) {
  return { level: LEVEL, target: TARGET || undefined, summary: "Nothing changed — nothing to review.", findings: [], stats: { finders: 0, candidates: 0, verified: 0 } }
}
log(LEVEL + "-level review · " + scope.files.length + " files in scope")

const CONTEXT_BLOCK =
  "## What this review covers\\n" +
  "Run: " + scope.diffCommand + "\\n" +
  "Files touched (" + scope.files.length + "):\\n" +
  scope.files.map(f => "  - " + f).join("\\n") + "\\n\\n" +
  "## The change, in brief\\n" + scope.summary + "\\n\\n" +
  "## House conventions\\n" + (scope.conventions || "(nothing noted)") + "\\n" +
  // The verbatim instructions travel to EVERY downstream agent — a stated
  // focus or exclusion binds the finders and verifiers, not just the diff
  // command that was built from it.
  (TARGET
    ? "\\n## User instructions (outrank default lens breadth; exclude anything excluded here)\\n" + TARGET + "\\n"
    : "")

// ─── Briefs ───
const finderBrief = lens =>
  "## Review finder — " + lens.label + "\\n\\n" + CONTEXT_BLOCK + "\\n" +
  "Run the scoped diff command first, then review strictly through your lens:\\n\\n" +
  lens.brief + "\\n" +
  (lens.kind === "cleanup" ? QUALITY_COST_NOTE + "\\n" : "") +
  "Report up to " + SIZE.perLens + " candidates ({file, line, summary, failure_scenario}); include plausible leads (an independent verifier rules on each), or [] if none clear the bar. Answer via structured output only."

const verifierBrief = c =>
  "## Review verifier\\n\\n" + CONTEXT_BLOCK + "\\n" +
  "## Candidate\\n" +
  "Where: " + c.file + (c.line != null ? ":" + c.line : "") + "\\n" +
  "Claim: " + c.summary + "\\n" +
  "Predicted failure: " + c.failure_scenario + "\\n\\n" +
  "Run the scoped diff, read the involved files, and choose one verdict:\\n\\n" +
  VERDICT_RUNGS + "\\n\\n" + RECALL_GUARD + "\\n\\n" +
  "Quote or cite exact line(s) in evidence. Answer via structured output only."
// ─── Duplicate filter + verification budget, shared by the stage callbacks
// (they mutate it as lenses land; safe on one JS thread) ───
const dedupKey = c => c.file + ":" + (c.line != null ? Math.round(c.line / 5) * 5 : "x:" + c.summary.toLowerCase().slice(0, 40))
const board = new Map()
const echoes = []
const spillover = []
let checkSlots = VERIFY_BUDGET

function ruleOn(c) {
  const basename = (c.file || "").split("/").at(-1)
  return agent(verifierBrief(c), withModel({ label: "verify:" + basename, phase: "Verify", schema: RULING_SCHEMA }, CHECK_MODEL))
    .then(ruling => (ruling ? { ...c, verdict: ruling.verdict, evidence: ruling.evidence } : null))
}

// ─── Find, then rule, streaming per lens ───
const ROSTER = CORRECTNESS_LENSES.slice(0, SIZE.lenses)
  .map(l => ({ ...l, kind: "correctness" }))
  .concat(QUALITY_LENSES.map(l => ({ ...l, kind: "cleanup" })))

const lensResults = await pipeline(
  ROSTER,

  lens => agent(finderBrief(lens), withModel({ label: lens.label, phase: "Find", schema: LEADS_SCHEMA }, LANE_MODEL)).then(r => {
    if (r == null) return { lens, candidates: [] }
    log(lens.label + " → " + r.candidates.length + " candidates")
    return { lens, candidates: r.candidates.slice(0, SIZE.perLens) }
  }),

  found => {
    const fresh = found.candidates.filter(c => {
      const key = dedupKey(c)
      if (board.has(key)) {
        echoes.push(c)
        return false
      }
      if (checkSlots <= 0) {
        spillover.push(c)
        return false
      }
      board.set(key, true)
      checkSlots--
      return true
    })
    return parallel(fresh.map(c => () => ruleOn({ ...c, kind: found.lens.kind })))
  }
)

let ruled = lensResults.flat().filter(Boolean)

// ─── The sweep (top tiers only): a clean-context finder, gaps only ───
if (SIZE.sweep) {
  phase("Sweep")
  const onTheBoard = ruled.length > 0
    ? ruled.map(c => "- " + c.file + (c.line != null ? ":" + c.line : "") + " · " + c.summary).join("\\n")
    : "(empty board)"
  const sweep = await agent(
    "## Review sweep — missed defects only\\n\\n" + CONTEXT_BLOCK + "\\n" +
    "## Already on the board (do not repeat)\\n" + onTheBoard + "\\n\\n" +
    "Walk the diff and enclosing functions for defects absent above, focusing on: " + SWEEP_TARGETS + "\\n\\n" +
    "Report up to " + SWEEP_EXTRA + " new candidates (or [] if none). Answer via structured output only.",
  )
  if (sweep && sweep.candidates.length) {
    const fresh = sweep.candidates.slice(0, SWEEP_EXTRA).filter(c => !board.has(dedupKey(c)))
    log("sweep → " + fresh.length + " new candidates")
    const sweepRuled = await parallel(fresh.map(c => () => ruleOn({ ...c, kind: "correctness" })))
    ruled = ruled.concat(sweepRuled.filter(Boolean))
  }
}

const standing = ruled.filter(c => c.verdict !== "REFUTED")
const struck = ruled.filter(c => c.verdict === "REFUTED")
log("verification done: " + ruled.length + " ruled → " + standing.length + " standing, " + struck.length + " struck")

const stats = {
  level: LEVEL,
  finders: ROSTER.length,
  candidates: board.size + echoes.length + spillover.length,
  verified: ruled.length,
  refuted: struck.length,
  dupes: echoes.length,
  budgetDropped: spillover.length,
}

if (standing.length === 0) {
  return {
    level: LEVEL, target: TARGET || undefined,
    summary: "Every candidate was struck down in verification.",
    findings: [],
    stats,
  }
}

// ─── Synthesize: fold duplicates, rank, cap ───
phase("Synthesize")
// Correctness ahead of quality when the cap bites; CONFIRMED ahead of
// PLAUSIBLE inside each band.
const rank = c => (c.verdict === "PLAUSIBLE" ? 1 : 0) + (c.kind === "cleanup" ? 2 : 0)
const ordered = [...standing].sort((a, b) => rank(a) - rank(b))
const findingsBlock = ordered.map((c, i) =>
  "### #" + i + " " + c.file + (c.line != null ? ":" + c.line : "") + " (" + c.verdict + (c.kind === "cleanup" ? ", quality" : "") + ")\\n" +
  c.summary + "\\nPredicted failure: " + c.failure_scenario + "\\nVerifier's evidence: " + c.evidence + "\\n"
).join("\\n")

const report = await agent(
  "## Assemble the review report\\n\\n" +
  ordered.length + " verified findings at level " + LEVEL + ":\\n\\n" + findingsBlock + "\\n" +
  "1. Merge findings sharing a root cause and pool their evidence.\\n" +
  "2. Order worst-first; correctness always outranks quality.\\n" +
  "3. Cap at " + SIZE.reportCap + " findings, dropping least severe first.\\n" +
  "4. Summarize the review in 2-3 sentences.\\n\\nAnswer via structured output only.",
)

// If synthesis was skipped or died, ship the ruled findings uncombined
// instead of losing the run.
const findings = report
  ? report.findings.slice(0, SIZE.reportCap)
  : ordered.slice(0, SIZE.reportCap).map(c => ({
      file: c.file, line: c.line, summary: c.summary, failure_scenario: c.failure_scenario, verdict: c.verdict,
    }))

return {
  level: LEVEL,
  target: TARGET || undefined,
  summary: report ? report.summary : "Synthesis was skipped or died — the verified findings are returned uncombined.",
  findings,
  refuted: struck.map(c => ({ file: c.file, line: c.line, summary: c.summary })),
  stats: { ...stats, reported: findings.length },
}`
