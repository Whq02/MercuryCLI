// Source of the bundled `code-review` workflow.
//
// Order of battle: Scope, then per-lens Find feeding Verify through a dedup
// gate (pipeline — no barrier), then an optional gap Sweep at the top effort
// tiers, then Synthesize (fold, rank, cap). Effort levels size the harness:
// high = 3 correctness lenses + 4 quality lenses × 6 candidates → a
// 10-finding report; xhigh/max = 5 + 4 × 8 → the sweep → 15 findings (max
// matches xhigh here; those two levels differ in API reasoning effort, not
// fan-out). Registered hidden: the /code-review skill launches it, and it
// stays out of the /workflows listing.
//
// Held in an ordinary (cooked) template literal — String.raw would let an
// ASCII-escaping transpiler smuggle literal \uXXXX sequences into the script
// — with doubled backslashes and escaped backticks/dollar-braces, so what
// ships is precisely the script text.

/* eslint-disable */

export const CODE_REVIEW_WORKFLOW_SCRIPT = `export const meta = {
  name: "code-review",
  description: "Multi-lens code review — a finder agent per review lens, an independent verifier on every candidate, then one ranked and capped report.",
  whenToUse: "The /code-review skill launches this at effort high, xhigh, or max whenever workflows are enabled. String args: \\"<level> [target]\\" — level: high, xhigh, or max; target (optional): a PR number, a branch, a ref range, a path, or free-form instructions (\\"only review src/net/\\", \\"focus on concurrency\\"). Object args also work: {level?, target?, model?, verifierModel?} — the model knobs accept any id or alias the session model catalog resolves, and verifierModel routes only the verification lane (one provider can find while another checks).",
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
  { label: "hunk-read", brief: "### Lens: hunk-by-hunk read\\n\\nWalk each hunk line by line, and after each hunk Read its whole enclosing\\nfunction — a defect on an untouched line of a touched function is in scope,\\nbecause the change re-exposes it. Interrogate each line: which input, which\\nstate, which timing, which platform makes it wrong? Hunt the classics: an\\ninverted or misaimed condition, off-by-one at a boundary, a null/undefined\\ndereference, a missing \`await\`, zero treated as absent, a copy-paste that\\nkept the wrong variable, a catch that eats the error, regex metacharacters\\nleft unescaped.\\n" },
  { label: "lost-guards", brief: "### Lens: what the deletions were protecting\\n\\nFor each line the diff removes or rewrites, spell out the invariant or\\nbehavior that line was enforcing — then hunt through the new code for the\\nplace that protection lives now. If you cannot point at it, that is a candidate: a\\nguard that vanished, an error path that fell out, validation that got\\nnarrower, a test deleted while it was still covering something real.\\n" },
  { label: "call-sites", brief: "### Lens: across file boundaries\\n\\nFor every function the diff touches, Grep out its callers and put each call\\nsite on trial against the new behavior: a precondition that did not exist\\nbefore, a changed return shape, a new throw, an ordering or timing\\nassumption. Then flip direction and check the callees — did a sibling change\\nin this same diff make one of these calls unsafe?\\n" },
  { label: "lang-traps", brief: "### Lens: the language's own traps\\n\\nSweep the diff for the classic traps of its language and framework — for\\ninstance: JS zero-is-falsy and loose-equality coercion, a loop variable\\ncaptured by a closure; Python mutable default arguments and late-bound\\nclosures; Go writes to a nil map and range-variable capture; string-built\\nSQL; timezone and DST arithmetic; equality on floats. Flag each instance the\\ndiff INTRODUCES.\\n" },
  { label: "delegation", brief: "### Lens: wrappers that forget to delegate\\n\\nWhen the diff adds or edits a wrapping type (a cache, proxy, decorator, or\\nadapter) around an inner one, verify each method actually routes through the\\nheld inner object — not back out through a registry, session, or global that\\nwould re-enter the wrapper or recurse (a caching layer holding \`inner\` but\\nresolving through \`session.get(...)\` instead of \`inner.get(...)\` is the\\ncanonical miss). Confirm the wrapper forwards every method its callers\\nreally use.\\n" },
]
// Four quality lenses; the labels double as finding categories downstream.
const QUALITY_LENSES = [
  { label: "reuse", brief: "### Reuse\\n\\nFlag fresh code that rebuilds something this codebase already owns. Grep the\\nshared and utility modules plus the files neighboring the change, and NAME\\nthe existing helper the new code should have called.\\n" },
  { label: "simplification", brief: "### Simplification\\n\\nFlag complexity the diff adds without need: state that could be derived\\ninstead of stored, near-identical copy-paste, nesting that a guard clause\\nwould flatten, code left dead. NAME the leaner shape that achieves the same\\nthing.\\n" },
  { label: "efficiency", brief: "### Efficiency\\n\\nFlag work the diff wastes: the same computation or I/O repeated, independent\\nsteps forced into sequence, blocking work pushed onto startup or a hot path.\\nFlag, too, any long-lived object assembled out of closures (or a captured\\nenvironment) — it pins the whole enclosing scope for as long as it lives (a\\nleak when the scope holds anything big); a small class or struct that copies\\njust the fields it needs is the fix. NAME the cheaper alternative.\\n" },
  { label: "altitude", brief: "### Altitude\\n\\nJudge whether each change lands at the right depth or papers over the\\nproblem. Special cases bolted onto shared infrastructure are the tell that a\\nfix sits too shallow — prefer generalizing the mechanism underneath to\\nstacking exceptions on top of it.\\n" },
]

const VERDICT_RUNGS = "- **CONFIRMED** — you can name the inputs or state that spring it, plus the\\n  bad result or crash that follows. Quote the guilty line.\\n- **PLAUSIBLE** — the mechanism is real but the trigger stays uncertain\\n  (timing, environment, configuration). Say what evidence would settle it.\\n- **REFUTED** — the candidate is factually wrong (the code does not say\\n  that), or something else already guards it. Quote the very line that\\n  disproves it."
const RECALL_GUARD = "**Default to PLAUSIBLE** — striking a candidate down as \\"speculative\\" or\\n\\"runtime-dependent\\" is wrong whenever that runtime state is realistic: a\\nconcurrency race, nil/undefined on a path that is rare yet reachable (an\\nerror handler, a cold cache, a missing optional field), zero read as absent,\\nan off-by-one at a boundary the code never excludes, retry storms and\\npartial failures, a regex or allowlist that lost its anchor. Those are\\nPLAUSIBLE.\\n\\nRule **REFUTED** only on grounds you can construct from the code itself:\\nfactually wrong (quote the real line); provably unreachable (a type, a\\nconstant, an invariant — show it); already guarded inside this diff (cite\\nthe guard); or style-only with nothing observable at stake."
const QUALITY_COST_NOTE = "Quality and altitude candidates use the identical {file, line, summary}\\nfields; put the concrete COST into \`failure_scenario\` — the duplication, the\\nwaste, the maintenance drag — rather than a crash. When the report cap\\nforces cuts, correctness bugs always survive ahead of quality findings.\\n"
const SWEEP_TARGETS = "code that was moved or extracted and lost a guard or an anchor on the way;\\nsecond-tier traps (a default evaluated once at definition time, \`hash()\`\\nnondeterminism, a lock's scope quietly shrunk, predicate methods that\\nmutate); setup/teardown asymmetry in tests; configuration defaults that\\nflipped."

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
  "Set the boundaries of a code review.\\n\\n" +
  (TARGET
    ? "The user's target / instructions, verbatim: \\"" + TARGET + "\\". A PR number, a branch, a ref range, or a path means: build the git diff command that matches it. A free-form instruction (certain files only, certain concerns only) means: honor every stated restriction while building the command, and cover whatever it leaves open with the current branch's diff ('git diff @{upstream}...HEAD', or 'git diff main...HEAD', or 'git diff HEAD~1' as fallbacks).\\n"
    : "No target was given: the review covers the current branch. Try 'git diff @{upstream}...HEAD' first; if that fails, use 'git diff main...HEAD', then 'git diff HEAD~1'. When uncommitted work exists, add 'git diff HEAD' too.\\n") +
  "\\n1. Choose the diff command(s), then RUN them — the diff must come back non-empty.\\n" +
  "2. List every changed file.\\n" +
  "3. Sum up the change in a single paragraph.\\n" +
  "4. Read the project's instruction files near the changed code (MERCURY.md, or CLAUDE.md where a project still carries one) and note the conventions a reviewer needs.\\n\\n" +
  "diffCommand must come back ready to paste into a shell. Answer only through the structured output.",
  withModel({ label: "scope", schema: BOUNDS_SCHEMA }, LANE_MODEL)
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
    ? "\\n## The user's instructions, verbatim\\n" + TARGET + "\\nStated focus areas and restrictions outrank your lens's default breadth. Anything the instructions exclude stays out of your findings.\\n"
    : "")

// ─── Briefs ───
const finderBrief = lens =>
  "## Review finder — " + lens.label + "\\n\\n" + CONTEXT_BLOCK + "\\n" +
  "Start by running the diff command from the scope block, then review STRICTLY through your assigned lens:\\n\\n" +
  lens.brief + "\\n" +
  (lens.kind === "cleanup" ? QUALITY_COST_NOTE + "\\n" : "") +
  "Report up to " + SIZE.perLens + " candidates, each carrying file, line, a single-sentence summary, plus a failure_scenario naming the concrete crash or cost. " +
  "Half-sure candidates go IN, not out: an independent verifier rules on every one, and silently dropping them costs recall. " +
  "An empty list is a valid answer when nothing clears the bar.\\n\\nAnswer only through the structured output."

const verifierBrief = c =>
  "## Review verifier\\n\\n" + CONTEXT_BLOCK + "\\n" +
  "## The candidate\\n" +
  "Where: " + c.file + (c.line != null ? ":" + c.line : "") + "\\n" +
  "Claim: " + c.summary + "\\n" +
  "Predicted failure: " + c.failure_scenario + "\\n\\n" +
  "Run the scoped diff, open the files involved, and settle on a single verdict:\\n\\n" +
  VERDICT_RUNGS + "\\n\\n" + RECALL_GUARD + "\\n\\n" +
  "Answer only through the structured output. The evidence field has to quote or point at the exact line(s)."

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
    "## Review sweep — only what everyone missed\\n\\n" + CONTEXT_BLOCK + "\\n" +
    "## Candidates already on the board (do not rediscover or re-argue these)\\n" + onTheBoard + "\\n\\n" +
    "Walk the diff once more, enclosing functions included, hunting ONLY for defects absent from that list. " +
    "Aim where first passes go blind: " + SWEEP_TARGETS + "\\n\\n" +
    "Report up to " + SWEEP_EXTRA + " additional candidates. Nothing new is a fine answer — an empty candidates array beats padding.\\n\\nAnswer only through the structured output.",
    withModel({ label: "sweep", phase: "Sweep", schema: LEADS_SCHEMA }, LANE_MODEL)
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
  "## Assemble the final review report\\n\\n" +
  ordered.length + " findings stand after independent verification, at the " + LEVEL + " level.\\n\\n" + findingsBlock + "\\n" +
  "## How\\n" +
  "1. Findings that share a root cause become ONE finding — pool their evidence.\\n" +
  "2. Order by severity, worst first; correctness always outranks quality findings.\\n" +
  "3. Keep no more than " + SIZE.reportCap + " findings — the least severe fall off first.\\n" +
  "4. Close with two or three sentences summing up the review.\\n\\nAnswer only through the structured output.",
  withModel({ label: "synthesize", schema: DIGEST_SCHEMA }, LANE_MODEL)
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
