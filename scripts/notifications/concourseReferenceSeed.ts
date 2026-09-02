// ============================================================================
//  scripts/notifications/concourseReferenceSeed.ts — the.4 canonical
//  reference fixture: the recorded crop/cell profile of the rebound V2 PNG
//  plus the verbatim seed data transcribed (and pixel-verified) from it.
//
//  Consumers: the `concourse` branch in scripts/ui/renderScenarios.ts (lands
//  with the surface — a scenario cannot render a screen that does not
//  exist yet; the scenario carries that sequencing) and the
//  reference-parity prover (records THIS profile with its comparison).
//
//  Derivation:
//  body cell ≈ 11.03 px (glyph-run autocorrelation over three independent
//  strings), line pitch ≈ 28 px, terminal padding ≈ 10 px each side →
//  (1586−20)/11.03 = 142.0 columns exactly; the mock's content height
//  implies 142×34, which is exactly the §8.6 "Short" transform of the
//  38-row canonical map. The mock itself is NOT on a uniform cell grid
//  (fractional leading 34-36 px, wordmark letter-spaced 15.5 px/glyph) —
//  those are pre-recorded divergence classes, enumerated below.
// ============================================================================

/** The recorded crop + terminal cell profile. */
export const CONCOURSE_REFERENCE_PROFILE = {
  png: {
    sha256: 'a6ba5752efa56c117a548de839d67dd3ce97443da4046f9ba535d397dd489ee0',
    width: 1586,
    height: 992,
    colorspace: 'RGB (no alpha)',
    /** macOS window chrome rows 0..39; the application viewport starts below. */
    appViewportTopPx: 40,
  },
  cell: { widthPx: 11.03, heightPx: 28, paddingPx: 10 },
  /** The canonical implementation grid the seeded scenario renders at. */
  canonicalGrid: { cols: 142, rows: 38 },
  /** The mock's own implied viewport — the §8.6 Short transform of the map. */
  shortGrid: { cols: 142, rows: 34 },
  /** App frame columns (0-indexed, inclusive) — 4-col margins each side. */
  appFrame: { firstCol: 4, lastCol: 137 },
  /** Sessions/Peek boxes: cols 4..82 and 83..137 → 58.3%/40.2% interior. */
  paneSplit: { sessionsCols: 79, peekCols: 55 },
} as const

/** Pre-recorded divergence classes (mock artifact → lawful rendering).
 *  Every raster comparison adjudicates against exactly this inventory —
 *  anything OUTSIDE it is an unexplained difference and fails the parity law. */
export const CONCOURSE_REFERENCE_DIVERGENCES = [
  'mock-leading: session rows at 34-36 px pitch and header leading 43/30 px quantize to whole terminal rows',
  'mock-tracking: the wordmark is letter-spaced 15.5 px/glyph in the mock; the lockup renders through ProductLockup cells',
  'selection-outline: the mock draws a 3-row cyan outline around the selected row; the kit renders its ONE selection paint (InteractiveRow band + ▸ cursor) at 1-row density',
  'queued-glyph: the mock leads queued rows with □, which is not in the GLYPH vocabulary; ◇ (planned/reserved) is the binding',
  'identity-color: the mock wordmark/view label is flat bright cyan; identity renders the TERRA focal ramp (flat-cyan identity is unshippable — focal-ramp identity law, prove-lockup-census)',
  'role-colors: the mock bright cyan maps to cyan_FOR_SUBAGENTS_ONLY for live-worker state and to the info/focal roles for structure; mock greens map to success TEAL — the §8.1 role table, not literal hexes',
  'resident-critter: the mock predates the peek-pane resident; the hermit region adjudicates against the critter fixture, not the mock (operator-directed design, FN-001 — the shell binds to the peeked session identity token, fallback accentSoft)',
  'coordinator-tone: the mock paints the status-rail coordinator segment amber unconditionally; the status-spine law reserves amber for ATTENTION — live renders the mode\'s own tone (assisted=info, rules-only=textSecondary, off=textMuted) and goes amber only on a typed downgrade (B6)',
] as const

export interface ConcourseSeedSessionRow {
  id: string
  glyph: 'ok' | 'pending' | 'diamond'
  title: string
  project: string
  owner: string
  age: string
  seats: string
  selected?: boolean
}

export interface ConcourseSeedGroup {
  label: string
  count: number
  rows: ConcourseSeedSessionRow[]
}

/** The verbatim reference seed (§8.1 table, pixel-verified — zero text
 *  discrepancies between the handoff seed table and the PNG). */
export const CONCOURSE_REFERENCE_SEED = {
  header: {
    view: 'SESSION CONCOURSE',
    breadcrumb: ['BOOT', 'CONCOURSE', 'MAIN REPL'] as const,
    activeCrumb: 'CONCOURSE',
    right: { project: 'Moodle', user: 'sam', clock: '08:14:20' },
    coordinator: { state: 'Rules only', assistModel: 'GPT-5.6 Sol' },
    counts: { live: 5, needsYou: 1, balance: 'Auto balanced', seats: '4/10' },
  },
  needsYou: {
    count: 1,
    rows: [
      {
        title: 'Migration plan',
        question: 'Choose the schema migration order',
        project: 'Moodle',
        agent: 'Mercury',
        age: '4m',
        actions: ['answer & resume', 'open'] as const,
        focusedAction: 'answer & resume',
      },
    ],
  },
  groups: [
    {
      label: 'READY TO REVIEW',
      count: 1,
      rows: [
        { id: 's-audit', glyph: 'ok', title: 'Audit billing receipts', project: 'Moodle', owner: 'Mercury', age: '12m', seats: '—' },
      ],
    },
    {
      label: 'WORKING',
      count: 3,
      rows: [
        { id: 's-oauth', glyph: 'ok', title: 'Fix OAuth callback', project: 'Moodle', owner: 'Mercury', age: '07m', seats: '1/2', selected: true },
        { id: 's-parser', glyph: 'pending', title: 'Refactor parser', project: 'orchard-src', owner: '@test', age: '18m', seats: '1/2' },
        { id: 's-resize', glyph: 'pending', title: 'Update terminal resize tests', project: 'orchard-src', owner: '@test2', age: '03m', seats: '2/2' },
      ],
    },
    {
      label: 'QUEUED',
      count: 2,
      rows: [
        { id: 's-trace', glyph: 'diamond', title: 'Trace reconnect race', project: 'orchard-src', owner: '—', age: '—', seats: 'waits' },
        { id: 's-launchdoc', glyph: 'diamond', title: 'Document launch graph', project: 'Moodle', owner: '—', age: '—', seats: 'waits' },
      ],
    },
  ] satisfies ConcourseSeedGroup[],
  peek: {
    title: 'Fix OAuth callback',
    facts: { state: 'working', project: 'Moodle', agent: 'Mercury', model: 'GPT-5.6 Sol', seats: '1/2' },
    timeline: [
      { at: '08:07', text: 'started' },
      { at: '08:08', text: 'reading callback owner' },
      { at: '08:13', text: 'editing src/auth/callback.ts' },
    ],
    scope: 'clear',
    actions: ['enter full session', 'pause after turn', 'redirect'] as const,
    focusedAction: 'enter full session',
  },
  newSession: {
    prompt: 'Start a new session…',
    advanced: 'advanced',
    segments: ['Project Moodle', 'Agent Mercury', 'GPT-5.6 Sol', 'isolated worktree', 'background seats 2 max'] as const,
  },
  statusRail: {
    left: 'GPT-5.6 Sol · xhigh · Moodle',
    center: 'coordinator rules only',
    right: '1 needs you · 5 live · 4/10 seats',
  },
  helpStrip: '↑↓ browse · tab panes · ↵ open · n new · / filter · b boot menu · esc main REPL',
  /** §5.5 reconciliation: 1 ready + 3 working + 1 needs-you = 5 live (the
   *  needs-you session is the FIFTH session, distinct from the four board
   *  rows above); 2 queued rows are NOT live; seats 1/2+1/2+2/2 = 4 of
   *  5×2 = 10 (Coordinator Rules-only ⇒ +0). */
  countsReconciliation: { live: 5, working: 3, ready: 1, needsYou: 1, queued: 2, seatsHeld: 4, seatsDenominator: 10 },
} as const

// ── the fixture composer: ONE place turns the transcription into the
//    ConcourseSnapshotV1 the registered MERCURY_CONCOURSE_FIXTURE seam feeds —
//    the render scenario, the parity prover and the route-silence legs
//    must all drive the SAME bytes. ─────────────────────────────────────────

export function referenceFixtureSnapshot(): Record<string, unknown> {
  const seed = CONCOURSE_REFERENCE_SEED
  const seatOf = (s: string): { held: number; ceiling: number } | 'waits' | null =>
    s === 'waits' ? 'waits' : /^\d+\/\d+$/.test(s) ? { held: Number(s.split('/')[0]), ceiling: Number(s.split('/')[1]) } : null
  const stateOf = (groupLabel: string): 'ready-to-review' | 'working' | 'queued' =>
    groupLabel === 'READY TO REVIEW' ? 'ready-to-review' : groupLabel === 'WORKING' ? 'working' : 'queued'
  return {
    schema: 1,
    revision: 1,
    clock: seed.header.right.clock,
    context: { projectLabel: seed.header.right.project, operatorHandle: seed.header.right.user, effortLabel: seed.statusRail.left.split(' · ')[1] ?? 'xhigh' },
    breadcrumb: { active: 'concourse' },
    coordinator: { mode: 'rules-only', assistModelLabel: seed.header.coordinator.assistModel },
    counts: {
      live: seed.countsReconciliation.live,
      needsYou: seed.countsReconciliation.needsYou,
      working: seed.countsReconciliation.working,
      queued: seed.countsReconciliation.queued,
      seatsHeld: seed.countsReconciliation.seatsHeld,
      seatsDenominator: seed.countsReconciliation.seatsDenominator,
      admission: 'auto-balanced',
    },
    needsYou: seed.needsYou.rows.map((r, i) => ({
      obligationId: `obl-seed-${i}`,
      sessionId: `sess-needs-${i}`,
      title: r.title,
      question: r.question,
      projectLabel: r.project,
      agentLabel: r.agent,
      ageLabel: r.age,
    })),
    groups: seed.groups.map(g => ({
      id: stateOf(g.label),
      label: g.label,
      rows: g.rows.map(r => ({
        sessionId: r.id,
        title: r.title,
        state: stateOf(g.label),
        projectLabel: r.project,
        ownerLabel: r.owner === '—' ? null : r.owner,
        ageLabel: r.age === '—' ? null : r.age,
        seats: seatOf(r.seats),
        // The NOW cell — the seed teaches the feature
        // with the same labels its peek timeline always carried.
        ...(r.id === 's-oauth' ? { nowLabel: 'editing src/auth/callback.ts' } : {}),
        ...(r.id === 's-parser' ? { nowLabel: 'Bash · bun test parser' } : {}),
      })),
    })),
    peek: {
      sessionId: 's-oauth',
      title: seed.peek.title,
      state: 'working',
      projectLabel: seed.peek.facts.project,
      agentLabel: seed.peek.facts.agent,
      modelLabel: seed.peek.facts.model,
      seats: { held: 1, ceiling: 2 },
      timeline: seed.peek.timeline.map(e => ({ clock: e.at, label: e.text })),
      scope: { kind: 'clear' },
      actions: ['enter-full-session', 'pause-after-turn', 'redirect'],
      residentState: 'settled',
    },
    newSession: {
      seeds: {
        projectLabel: 'Moodle',
        agentLabel: 'Mercury',
        modelLabel: 'GPT-5.6 Sol',
        modelIsDefault: true,
        effortLevel: 'high',
        effortIsDefault: true,
        isolation: 'isolated-worktree',
        seatsMax: 2,
      },
      draft: '',
      // The §8.1 design carries the advanced chip; the LIVE builder omits
      // this until openAdvanced is real (B4's affordance gate).
      advancedAvailable: true,
    },
  }
}
