// Source of the bundled `deep-research` workflow.
//
// Order of battle: Scope; then search lanes flowing through a URL-dedup gate
// into fetch/extract (one pipeline, no barrier); then a majority-vote
// skeptic panel per claim (a deliberate barrier); then a cited synthesis.
// Web tools (WebSearch/WebFetch) do the reaching; schema-bound agents keep
// every stage machine-readable. The question rides in through Workflow args
// — a plain string, a "light:"-prefixed string for the small pass, or
// {question, depth, model?, verifierModel?}. The model knobs let one run mix
// providers (say, verification on a different lane than the searching);
// absent, they change nothing at all.
//
// Held in an ordinary (cooked) template literal — String.raw would let an
// ASCII-escaping transpiler smuggle literal \uXXXX sequences into the script
// — with doubled backslashes and escaped backticks/dollar-braces, so what
// ships is precisely the script text. The registry parses `meta` straight
// out of this string, so descriptor and script cannot drift apart.

/* eslint-disable */

export const DEEP_RESEARCH_WORKFLOW_SCRIPT = `export const meta = {
  name: 'deep-research',
  description: 'Multi-source research with adversarial fact-checking — angle fan-out, source extraction, majority-vote verification, cited synthesis.',
  whenToUse: 'For research that needs many sources and real fact-checking. Scale with honesty: full depth runs roughly 25-40 agents, so save it for questions that span domains or whose claims must be checked hard — and only when the user truly asked for deep research. A personal or single-subject decision (a purchase, one comparison, one recommendation) fits the light pass (~6-8 agents: 2 angles, single-vote checks) — or a couple of inline WebSearches with no workflow at all. When the user never said \\"deep research\\", state the rough agent count and get a yes before launching. When the question is vague, ask 2-3 sharpening questions first and fold the answers in. Args: a question string (full depth); \\"light:<question>\\" for the smaller pass; or the object form {question, depth: \\"light\\"|\\"full\\", model?, verifierModel?} — the model knobs take any id or alias the session model catalog resolves, and verifierModel routes just the skeptic votes (handy for cross-provider verification).',
  phases: [{"title":"Scope","detail":"Break the question into distinct search directions (2 light · 5 full)"},{"title":"Search","detail":"One web-search agent per direction, all concurrent"},{"title":"Fetch","detail":"Dedup URLs, read what survives, mine out checkable claims"},{"title":"Verify","detail":"A skeptic panel on every claim (3 seats full · 1 light)"},{"title":"Synthesize","detail":"Fold duplicate claims, grade confidence, cite everything"}],
}

// Launch: Workflow({name: 'deep-research', args: '<question>'})
//     or  args: 'light:<question>'
//     or  args: {question, depth: 'light'|'full', model?, verifierModel?}

const INPUT = args
const IS_OBJ = typeof INPUT === "object" && INPUT !== null
const RAW_TEXT = typeof INPUT === "string" ? INPUT.trim() : ""
const LIGHT =
  (IS_OBJ && INPUT.depth === "light") ||
  RAW_TEXT.toLowerCase().startsWith("light:")

// Depth knobs. killAt = refuting ballots that sink a claim; a claim also
// needs at least killAt VALID ballots to count as adjudicated at all.
const K = LIGHT
  ? { angles: 2, votes: 1, killAt: 1, fetchBudget: 6, verifyCap: 10 }
  : { angles: 5, votes: 3, killAt: 2, fetchBudget: 15, verifyCap: 25 }

// Optional model routing. Absent knobs add NO model key to any agent() call,
// so default runs (and their resume cache keys) are untouched.
const pickModel = v => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const LANE_MODEL = IS_OBJ ? pickModel(INPUT.model) : undefined
const SKEPTIC_MODEL = (IS_OBJ ? pickModel(INPUT.verifierModel) : undefined) || LANE_MODEL
const withModel = (opts, m) => (m ? { ...opts, model: m } : opts)

// ─── Schemas ───
const PLAN_SCHEMA = {
  type: "object",
  required: ["question", "angles", "summary"],
  properties: {
    question: { type: "string" },
    summary: { type: "string" },
    angles: {
      type: "array",
      minItems: LIGHT ? 2 : 3,
      maxItems: LIGHT ? 3 : 6,
      items: {
        type: "object",
        required: ["label", "query"],
        properties: {
          label: { type: "string" },
          query: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
  },
}
const HITS_SCHEMA = {
  type: "object",
  required: ["results"],
  properties: {
    results: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        required: ["url", "title", "relevance"],
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          snippet: { type: "string" },
          relevance: { enum: ["high", "medium", "low"] },
        },
      },
    },
  },
}
const MINED_SCHEMA = {
  type: "object",
  required: ["claims", "sourceQuality"],
  properties: {
    sourceQuality: { enum: ["primary", "secondary", "blog", "forum", "unreliable"] },
    publishDate: { type: "string" },
    claims: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["claim", "quote", "importance"],
        properties: {
          claim: { type: "string" },
          quote: { type: "string" },
          importance: { enum: ["central", "supporting", "tangential"] },
        },
      },
    },
  },
}
const BALLOT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    counterSource: { type: "string" },
  },
}
const DIGEST_SCHEMA = {
  type: "object",
  required: ["summary", "findings", "caveats"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "confidence", "sources", "evidence"],
        properties: {
          claim: { type: "string" },
          confidence: { enum: ["high", "medium", "low"] },
          sources: { type: "array", items: { type: "string" } },
          evidence: { type: "string" },
          vote: { type: "string" },
        },
      },
    },
    caveats: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
  },
}

// ─── Scope: turn the question into search directions ───
phase("Scope")
const ASK = IS_OBJ
  ? (typeof INPUT.question === "string" ? INPUT.question.trim() : "")
  : (LIGHT ? RAW_TEXT.slice(6).trim() : RAW_TEXT)
if (!ASK) {
  return { error: "The research question is missing. Launch as Workflow({name: 'deep-research', args: '<question>'}), or 'light:<question>', or {question, depth}." }
}
if (LIGHT) log("light pass: " + K.angles + " directions · " + K.votes + "-seat panels · " + K.fetchBudget + " fetch slots")

const plan = await agent(
  "You are planning a research sweep.\\n\\n" +
  "## The question under study\\n" + ASK + "\\n\\n" +
  "## What to produce\\n" +
  "Write " + K.angles + " web search queries that attack the question from genuinely different directions, chosen to fit its domain. Direction families to consider:\\n" +
  "- mainstream/primary coverage · scholarly or technical treatment · fresh news · the skeptic's case · what practitioners report\\n" +
  "- health questions: mechanism · frequent explanations · dangerous differentials · authoritative guidance · warning signs\\n" +
  "- technology questions: current state · measured benchmarks · known limits · who has adopted it · price and tradeoffs\\n\\n" +
  "Each query should be sharp enough to pull high-signal pages, and no two should chase the same ground.\\n" +
  "Return the question (as given, or minimally cleaned), a one-or-two sentence plan, and the direction list.\\n\\nAnswer only through the structured output.",
  withModel({ label: "scope", schema: PLAN_SCHEMA }, LANE_MODEL)
)
if (plan == null) {
  return { error: "The planning agent produced nothing, so the question could not be split into directions." }
}
log("topic: " + ASK.slice(0, 80) + (ASK.length > 80 ? "…" : ""))
log(plan.angles.length + " directions planned: " + plan.angles.map(a => a.label).join(", "))

// ─── Shared dedup + fetch-budget state (stage callbacks mutate it as lanes
// land; safe on one JS thread) ───
const urlKey = raw => {
  try {
    const u = new URL(raw)
    let host = u.hostname
    if (host.startsWith("www.")) host = host.slice(4)
    let p = u.pathname
    if (p.endsWith("/")) p = p.slice(0, -1)
    return (host + p).toLowerCase()
  } catch {
    return String(raw).toLowerCase()
  }
}
const seenUrls = new Map()
const repeats = []
const overBudget = []
const REL_ORDER = { high: 0, medium: 1, low: 2 }
let slotsLeft = K.fetchBudget

// ─── Prompt builders ───
const searchBrief = angle =>
  "## Search lane: " + angle.label + "\\n\\n" +
  "The question under study: \\"" + ASK + "\\"\\n\\n" +
  "Your direction: **" + angle.label + "** — " + (angle.rationale || "") + "\\n" +
  "Starting query: \`" + angle.query + "\`\\n\\n" +
  "## What to do\\nRun WebSearch with that query (refine it if the first pass is weak). Hand back the 4-6 strongest hits,\\n" +
  "ordered by how much they bear on the ORIGINAL question rather than on the literal query text. Drop content-farm\\n" +
  "and SEO filler outright. For each hit include one line on why it matters.\\n\\nAnswer only through the structured output."

const mineBrief = (hit, angleLabel) =>
  "## Source reader\\n\\n" +
  "The question under study: \\"" + ASK + "\\"\\n\\n" +
  "Read this page and mine it for checkable statements:\\n" +
  "**URL:** " + hit.url + "\\n**Title:** " + hit.title + "\\n**Surfaced by:** the " + angleLabel + " lane\\n\\n" +
  "## What to do\\n1. WebFetch the page.\\n" +
  "2. Grade the source: primary research or institution? secondary reporting? blog or opinion? forum? unreliable?\\n" +
  "3. Mine out two to five FALSIFIABLE claims bearing on the question. Every claim must:\\n" +
  "   - state something concrete a checker could confirm or knock down (no vague mood statements)\\n" +
  "   - carry a verbatim quote from the page that backs it\\n" +
  "   - be tagged central, supporting, or tangential to the question\\n" +
  "4. Record the publish date when the page shows one.\\n\\n" +
  "When the fetch errors out, the page is paywalled, or it proves irrelevant: return claims: [] with sourceQuality \\"unreliable\\".\\n\\nAnswer only through the structured output."

const skepticBrief = (c, seat) =>
  "## Claim skeptic (seat " + (seat + 1) + " of " + K.votes + ")\\n\\n" +
  "Your job is to knock this claim down if it deserves it. " + K.killAt + " of " + K.votes + " refuting ballots sink it.\\n\\n" +
  "## The question under study\\n" + ASK + "\\n\\n" +
  "## The claim on trial\\n\\"" + c.claim + "\\"\\n\\n" +
  "**From:** " + c.citedFrom + " (graded " + c.grade + ")\\n" +
  "**Backing quote:** \\"" + c.quote + "\\"\\n\\n" +
  "## Attack it from every side\\n" +
  "1. Does the quote actually establish the claim, or is the claim stretching past it?\\n" +
  "2. Run a fresh WebSearch for contrary evidence — is there a credible source that contradicts it or waters it down heavily?\\n" +
  "3. Does the source's strength match the claim's boldness? (a bold claim needs primary backing)\\n" +
  "4. Could it be stale? Check dates — in fast-moving areas an old claim is a suspect claim.\\n" +
  "5. Is it marketing copy, a press release, a cherry-picked benchmark, or forum hearsay?\\n\\n" +
  "Vote **refuted=true** when: the quote does not establish it / credible contradiction exists / the source is too weak for its strength / it is stale / it is promotional noise.\\n" +
  "Vote **refuted=false** ONLY when the claim is well-backed, current, and the source matches its strength.\\n" +
  "If you are torn, vote refuted=true.\\n\\nAnswer only through the structured output, and make the evidence concrete."

// ─── pipeline: search each direction, then dedup + read as each lane lands ───
const laneResults = await pipeline(
  plan.angles,

  angle => agent(searchBrief(angle), withModel({
    label: "scan:" + angle.label, phase: "Search", schema: HITS_SCHEMA,
  }, LANE_MODEL)).then(r => {
    if (r == null) return null
    log(angle.label + " → " + r.results.length + " hits")
    return { angle: angle.label, results: r.results }
  }),

  lane => {
    const ordered = [...lane.results].sort((a, b) => REL_ORDER[a.relevance] - REL_ORDER[b.relevance])
    const fresh = ordered.filter(hit => {
      const key = urlKey(hit.url)
      if (seenUrls.has(key)) {
        repeats.push({ ...hit, angle: lane.angle, firstSeenBy: seenUrls.get(key) })
        return false
      }
      if (slotsLeft <= 0 && REL_ORDER[hit.relevance] >= 1) {
        overBudget.push({ ...hit, angle: lane.angle })
        return false
      }
      seenUrls.set(key, { angle: lane.angle, title: hit.title })
      slotsLeft--
      return true
    })
    if (fresh.length < lane.results.length) {
      log(lane.angle + ": " + fresh.length + " novel (" + (lane.results.length - fresh.length) + " deduped or over budget)")
    }
    return parallel(
      fresh.map(hit => () => {
        let host = "somewhere"
        try {
          host = new URL(hit.url).hostname
          if (host.startsWith("www.")) host = host.slice(4)
        } catch {}
        return agent(mineBrief(hit, lane.angle), withModel({
          label: "read:" + host,
          phase: "Fetch",
          schema: MINED_SCHEMA,
        }, LANE_MODEL)).then(got => {
          // A null here means the operator skipped the agent or it died
          // terminally — that is NOT a verdict on the source, so it drops
          // out entirely instead of being branded unreliable.
          if (got == null) return null
          return {
            url: hit.url, title: hit.title, angle: lane.angle,
            grade: got.sourceQuality, publishDate: got.publishDate,
            claims: got.claims.map(c => ({ ...c, citedFrom: hit.url, grade: got.sourceQuality })),
          }
        }).catch(e => {
          log("read broke on " + hit.url + " — " + (e.message || e))
          return { url: hit.url, title: hit.title, angle: lane.angle, grade: "unreliable", claims: [] }
        })
      })
    )
  }
)

const sources = laneResults.flat().filter(Boolean)
const everyClaim = sources.flatMap(s => s.claims)
const IMP_ORDER = { central: 0, supporting: 1, tangential: 2 }
const GRADE_ORDER = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }

const shortlist = [...everyClaim]
  .sort((a, b) =>
    (IMP_ORDER[a.importance] - IMP_ORDER[b.importance]) ||
    (GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade]))
  .slice(0, K.verifyCap)

log(sources.length + " sources read → " + everyClaim.length + " claims → top " + shortlist.length + " go to the panel")

if (shortlist.length === 0) {
  return {
    question: ASK,
    summary: "Nothing checkable was mined: " + sources.length + " sources read, all empty or failed. " + repeats.length + " duplicate URLs, " + overBudget.length + " dropped for budget.",
    findings: [], refuted: [], sources: sources.map(s => ({ url: s.url, quality: s.grade })),
    stats: { angles: plan.angles.length, sources: sources.length, claims: 0, dupes: repeats.length },
  }
}

// ─── Verify: the skeptic panels. Barrier on purpose — ranking only means
// something once the claim pool is complete. ───
phase("Verify")
const tallyOf = c => (c.ballots.length - c.against) + "-" + c.against
const adjudicated = (await parallel(
  shortlist.map(c => () =>
    parallel(
      Array.from({ length: K.votes }, (_, seat) => () =>
        agent(skepticBrief(c, seat), withModel({
          label: "seat" + seat + ":" + c.claim.slice(0, 44),
          phase: "Verify",
          schema: BALLOT_SCHEMA,
        }, SKEPTIC_MODEL))
      )
    ).then(votes => {
      // A null ballot (skip or agent death) is an abstention. Survival needs
      // real adjudication: enough VALID ballots to reach the kill threshold,
      // AND fewer refutals than that threshold — an all-abstain panel must
      // never wave a claim through.
      const ballots = votes.filter(Boolean)
      const against = ballots.filter(b => b.refuted).length
      const blanks = K.votes - ballots.length
      const kept = ballots.length >= K.killAt && against < K.killAt
      log("\\"" + c.claim.slice(0, 50) + "…\\" " + (ballots.length - against) + "-" + against + (blanks > 0 ? " (" + blanks + " abstained)" : "") + " → " + (kept ? "kept" : "sunk"))
      return { ...c, ballots, against, kept }
    })
  )
)).filter(Boolean)

const keptClaims = adjudicated.filter(c => c.kept)
const sunkClaims = adjudicated.filter(c => !c.kept)
log("panel done: " + adjudicated.length + " judged → " + keptClaims.length + " kept, " + sunkClaims.length + " sunk")

if (keptClaims.length === 0) {
  return {
    question: ASK,
    summary: "Every one of the " + adjudicated.length + " judged claims was refuted. The research is inconclusive — the sources may be weak, or the claims overstated.",
    findings: [],
    refuted: sunkClaims.map(c => ({ claim: c.claim, vote: tallyOf(c), source: c.citedFrom })),
    sources: sources.map(s => ({ url: s.url, quality: s.grade, claimCount: s.claims.length })),
    stats: { angles: plan.angles.length, sources: sources.length, claims: everyClaim.length, verified: adjudicated.length, confirmed: 0, killed: sunkClaims.length },
  }
}

// ─── Synthesize ───
phase("Synthesize")
const CONF_ORDER = { high: 0, medium: 1, low: 2 }
const keptBlock = keptClaims.map((c, i) => {
  const strongest = c.ballots.filter(b => !b.refuted).sort((a, b) => CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence])[0]
  return "### #" + i + " " + c.claim + "\\n" +
    "Panel: " + tallyOf(c) + " · From: " + c.citedFrom + " (" + c.grade + ")\\n" +
    "Quote: \\"" + c.quote + "\\"\\nSkeptic's supporting evidence (" + strongest.confidence + "): " + strongest.evidence + "\\n"
}).join("\\n")

const sunkBlock = sunkClaims.length > 0
  ? "\\n## Sunk claims (kept visible for honesty)\\n" +
    sunkClaims.map(c => "- \\"" + c.claim + "\\" (" + c.citedFrom + ", panel " + tallyOf(c) + ")").join("\\n")
  : ""

const report = await agent(
  "## Write the research report\\n\\n" +
  "**The question under study:** " + ASK + "\\n\\n" +
  keptClaims.length + " claims came through a " + K.votes + "-seat skeptic panel alive. Turn them into a report.\\n\\n" +
  "## Surviving claims\\n" + keptBlock + "\\n" + sunkBlock + "\\n\\n" +
  "## How\\n" +
  "1. Where two claims say the same thing, fold them together and pool their citations.\\n" +
  "2. Cluster kindred claims into findings, each answering part of the question.\\n" +
  "3. Grade each finding: high = several primary sources and unanimous panels; medium = secondary sourcing or split panels; low = one source or blog-tier backing.\\n" +
  "4. Open with an executive answer of three to five sentences.\\n" +
  "5. Then the caveats: what stayed uncertain, which sources were thin, what may age out.\\n" +
  "6. Close with 2-4 questions this run surfaced but did not settle.\\n\\nAnswer only through the structured output.",
  withModel({ label: "synthesize", schema: DIGEST_SCHEMA }, LANE_MODEL)
)

if (report == null) {
  // The synthesis seat was skipped or died — salvage the adjudicated claims
  // raw instead of losing the entire run.
  return {
    question: ASK,
    summary: "Synthesis was skipped or died; the " + keptClaims.length + " surviving claims are returned unmerged.",
    findings: [],
    confirmed: keptClaims.map(c => ({ claim: c.claim, source: c.citedFrom, quote: c.quote, vote: tallyOf(c) })),
    refuted: sunkClaims.map(c => ({ claim: c.claim, vote: tallyOf(c), source: c.citedFrom })),
    sources: sources.map(s => ({ url: s.url, quality: s.grade, claimCount: s.claims.length })),
    stats: { angles: plan.angles.length, sources: sources.length, claims: everyClaim.length, verified: adjudicated.length, confirmed: keptClaims.length, killed: sunkClaims.length, afterSynthesis: 0 },
  }
}

return {
  question: ASK,
  ...report,
  refuted: sunkClaims.map(c => ({ claim: c.claim, vote: tallyOf(c), source: c.citedFrom })),
  sources: sources.map(s => ({ url: s.url, quality: s.grade, angle: s.angle, claimCount: s.claims.length })),
  stats: {
    angles: plan.angles.length,
    sourcesFetched: sources.length,
    claimsExtracted: everyClaim.length,
    claimsVerified: adjudicated.length,
    confirmed: keptClaims.length,
    killed: sunkClaims.length,
    afterSynthesis: report.findings.length,
    urlDupes: repeats.length,
    budgetDropped: overBudget.length,
    agentCalls: 1 + plan.angles.length + sources.length + (adjudicated.length * K.votes) + 1,
  },
}`
