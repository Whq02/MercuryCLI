
/* eslint-disable */

export const DEEP_RESEARCH_WORKFLOW_SCRIPT = `export const meta = {
  name: 'deep-research',
  description: 'Use when multi-source web research needs adversarial fact-checking: angle fan-out, source extraction, majority-vote verification, cited synthesis. Not for paper corpora (research) or quick lookups.',
  whenToUse: 'Scale honestly — full depth runs ~25-40 crewmates for cross-domain or high-stakes claims; single-subject decisions fit the light pass (~6-8 crewmates: 2 angles, 1 vote) or inline WebSearch. Unless the user asked for \\"deep research\\", state the crewmate count and get confirmation first; if vague, ask 2-3 sharpening questions and fold answers in. Args: \\"<question>\\" (full), \\"light:<question>\\", or {question, depth: \\"light\\"|\\"full\\", model?, verifierModel?} (any session model id/alias; verifierModel routes skeptic votes).',
  phases: [{"title":"Scope","detail":"Break the question into distinct search directions (2 light · 5 full)"},{"title":"Search","detail":"One web-search crewmate per direction, all concurrent"},{"title":"Fetch","detail":"Dedup URLs, read what survives, mine out checkable claims"},{"title":"Verify","detail":"A skeptic panel on every claim (3 seats full · 1 light)"},{"title":"Synthesize","detail":"Fold duplicate claims, grade confidence, cite everything"}],
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
  "Plan a research sweep.\\n\\n" +
  "## Question\\n" + ASK + "\\n\\n" +
  "Write " + K.angles + " non-overlapping web search queries from distinct directions suited to the domain:\\n" +
  "- general: primary/mainstream · scholarly/technical · recent news · skeptic case · practitioner reports\\n" +
  "- health: mechanism · common explanations · dangerous differentials · authoritative guidance · warning signs\\n" +
  "- technology: current state · benchmarks · limits · adoption · price and tradeoffs\\n\\n" +
  "Return the question (minimally cleaned if needed), a 1-2 sentence plan, and the angles list via structured output only.",
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
  "Question: \\"" + ASK + "\\"\\n" +
  "Direction: **" + angle.label + "** — " + (angle.rationale || "") + "\\n" +
  "Starting query: \`" + angle.query + "\`\\n\\n" +
  "Run WebSearch (refining the query if hits are weak). Return the 4-6 strongest hits ranked by relevance to the original question rather than literal query text, dropping content-farm and SEO filler, with one line per hit on why it matters. Answer via structured output only."

const mineBrief = (hit, angleLabel) =>
  "## Source reader\\n\\n" +
  "Question: \\"" + ASK + "\\"\\n" +
  "**URL:** " + hit.url + "\\n**Title:** " + hit.title + "\\n**Lane:** " + angleLabel + "\\n\\n" +
  "1. WebFetch the URL.\\n" +
  "2. Grade sourceQuality (primary, secondary, blog, forum, unreliable) and record publishDate if shown.\\n" +
  "3. Extract 2-5 falsifiable claims bearing on the question, each with a verbatim backing quote from the page and importance (central, supporting, tangential).\\n" +
  "On fetch error, paywall, or irrelevance, return claims: [] and sourceQuality: \\"unreliable\\". Answer via structured output only."

const skepticBrief = (c, seat) =>
  "## Claim skeptic (seat " + (seat + 1) + " of " + K.votes + "; " + K.killAt + " refuting ballots sink it)\\n\\n" +
  "Question: " + ASK + "\\n" +
  "Claim: \\"" + c.claim + "\\"\\n" +
  "Source: " + c.citedFrom + " (" + c.grade + ")\\n" +
  "Quote: \\"" + c.quote + "\\"\\n\\n" +
  "Check:\\n" +
  "1. Does the quote establish the claim without overreach?\\n" +
  "2. Run WebSearch for credible contradicting or qualifying evidence.\\n" +
  "3. Does source strength match claim boldness (bold claims need primary backing)?\\n" +
  "4. Is it stale by date?\\n" +
  "5. Is it marketing, press release, cherry-picked benchmark, or hearsay?\\n\\n" +
  "Vote refuted=true on quote overreach, credible contradiction, weak source, staleness, promo/hearsay, or when torn; vote refuted=false only when well-backed, current, and source-matched. Cite concrete evidence via structured output only."

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
  "**Question:** " + ASK + "\\n\\n" +
  keptClaims.length + " claims survived a " + K.votes + "-seat skeptic panel.\\n\\n" +
  "## Surviving claims\\n" + keptBlock + "\\n" + sunkBlock + "\\n\\n" +
  "1. Merge duplicate claims and pool citations.\\n" +
  "2. Group related claims into findings answering parts of the question.\\n" +
  "3. Grade confidence: high = multiple primary sources + unanimous panel; medium = secondary sources or split panel; low = single source or blog tier.\\n" +
  "4. Open with a 3-5 sentence executive summary.\\n" +
  "5. State caveats (uncertainties, thin sources, aging risks).\\n" +
  "6. List 2-4 open questions.\\n\\nAnswer via structured output only.",
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
