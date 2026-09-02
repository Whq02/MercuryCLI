#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-findings-concourse.ts
// TASK-017 field-findings fixes — the concourse screen's side.
//
//  Each section pins ONE fix with the finder's own driver-check re-expressed
//  as a Mac-runnable source/logic assertion, and names the box drill that
//  stays NEEDS-REAL-BOX. Written under the box law (pins ride the fix; the
//  suite runs them at the pool, never in the lane).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-field-findings-concourse.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const screenPath = join(ROOT, 'src/components/concourse/ConcourseScreen.tsx')
const screen = readFileSync(screenPath, 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── §1 · ⌃s on the reduced stage must never arm the modal owner ─────────────
// Finding `reduced-stage-ctrl-s-swallows-every-key` (S1, SURVIVED): the
// reduced stage renders no coordinator pane, so at the wide profile NEITHER
// picker mount exists; settingsOpen=true with no picker put boardModalOwner
// into 'settings' and the early return above tab/esc deadened every key.
// The POISON (the finder's check inverted): an arm door reachable on the
// reduced stage — settingsOpen true ∧ no picker mounted — is red.
console.log('§1 ⌃s wide-twin latch (settings owner never arms without a home)')
{
  // The chord is stage-guarded (the pre-fix unguarded spelling is poison).
  check(
    'the ⌃s branch carries the reduced-stage guard',
    screen.includes("if (key.ctrl && input === 's' && !reducedStage) {"),
  )
  check(
    'the pre-fix unguarded ⌃s branch is gone',
    !screen.includes("if (key.ctrl && input === 's') {"),
    'an unguarded ⌃s arms the owner from the plain live view',
  )
  // The one arm door refuses on the reduced stage — the rail chip's pointer
  // route (openCoordinatorModel) rides the same function, so a chip click
  // cannot latch what the chord cannot.
  check(
    'the arm door refuses on the reduced stage (close always allowed)',
    screen.includes('setSettingsOpen(v => (v ? false : !reducedStage))'),
  )
  // A strand that reaches the state sideways (resize mid-open, stage flip)
  // is disarmed by effect, not left to deaden the keyboard.
  check(
    'the sideways-strand disarm effect exists',
    screen.includes('if (reducedStage && settingsOpen) setSettingsOpen(false)'),
  )
  // The two mounts still cover the FULL stage completely: the wide pane
  // mount and the sub-wide screen overlay. (arm ⇒ !reducedStage; on the
  // full stage wide ⇒ pane, otherwise ⇒ overlay — no armed state without
  // a mounted picker remains.)
  check(
    "the wide pane mount stands (settingsOpen && geo.profile === 'wide')",
    screen.includes("settingsOpen={settingsOpen && geo.profile === 'wide'}"),
  )
  check(
    "the sub-wide overlay mount stands (settingsOpen && geo.profile !== 'wide')",
    screen.includes("{settingsOpen && geo.profile !== 'wide' ? ("),
  )
}
// NEEDS-REAL-BOX (the finder's live drill): boot `--concourse-off`, boot menu
// `o` to the plain live view, window ≥120×24, press ⌃s then esc/tab/↑/↓/n/⌃s:
// no picker paints, no key is dead, the region cursor still moves; narrowed
// below 120 columns the behavior is unchanged (⌃s stays inert on that stage).

// ── §2 · esc clears an APPLIED board filter (the hint stops lying) ──────────
// Finding `filter-sticks-and-esc-lies-about-clearing-it` (S1): the ↵/tab
// commit leaves filter.text applied with `filtering` off, the esc ladder had
// no filter layer, and the zero-match board still printed "esc clears the
// filter". The present-moves law: the hint is true, or the key fires — now
// both. The POISON: the hint painted with no filter layer in the ladder.
console.log('§2 applied-filter esc layer (the zero-match hint is true)')
{
  const layoutPath = join(ROOT, 'src/components/concourse/ConcourseLayout.tsx')
  const layout = readFileSync(layoutPath, 'utf8')
  const ordered = (hay: string, a: string, b: string): boolean => {
    const ia = hay.indexOf(a)
    const ib = hay.indexOf(b)
    return ia !== -1 && ib !== -1 && ia < ib
  }
  check(
    'the ladder carries the applied-filter layer (ref cleared synchronously — the batch law)',
    screen.includes("if (filterRef.current.text !== '') {") &&
      screen.includes("filterRef.current = { text: '', caret: 0 }"),
  )
  check(
    'the layer peels between the row peek and the marks (view layers before staged sets)',
    ordered(screen, '// Line 5: esc closes the row peek first', "if (filterRef.current.text !== '') {") &&
      ordered(screen, "if (filterRef.current.text !== '') {", 'if (markedIdsRef.current.size > 0) {'),
  )
  check(
    'the zero-match board still teaches the key it now honors',
    layout.includes('esc clears the filter'),
  )
  // The filter-edit mode keeps its own esc (clear + leave edit) and the
  // ↵/tab commit still APPLIES (text intact) — the fix adds the missing
  // layer, it does not turn apply into clear.
  check(
    'filter-edit esc and the ↵/tab apply-commit are unchanged',
    screen.includes('setFiltering(false)\n        setFilter({ text: \'\', caret: 0 })') &&
      /if \(key\.return \|\| key\.tab\) \{\s*\n\s*event\.stopImmediatePropagation\(\)\s*\n\s*setFiltering\(false\)\s*\n\s*return/.test(screen),
  )
}
// NEEDS-REAL-BOX: the finder's drill — apply a zero-match filter (`/`, text,
// ↵), read "esc clears the filter", press esc once: the full list returns on
// the SAME board (no exit); leave and re-enter with a filter applied: the
// capsule keeps it, and esc still clears it there.

// ── §3 · the ? atlas prints the resolver's truth (the L2 class root) ────────
// Findings `atlas-omits-list-region-prints-absent-ones` (SURVIVED) + the
// atlas lead family: the raw tables taught ⌃s/n on the plain live view,
// taught the split grammar one column under its own width gate, and had no
// SESSIONS section at all. The atlas now reads regionKeysFor — the same
// resolver every legend reads (one truth), stage- and width-gated.
console.log('§3 the ? atlas reads the resolver, stage- and width-honest')
{
  const atlasBody = screen.slice(screen.indexOf('function ConcourseKeyAtlas'))
  check('the SESSIONS section exists (the region that owns the board verbs)', atlasBody.includes("{ title: 'SESSIONS (list)', keys: regionKeysFor('list', stage) }"))
  check('no atlas section reads a raw region table any more', !atlasBody.includes('CONCOURSE_REGION_KEYS.'))
  check('the COORDINATOR section is stage-gated (the plain world is not taught ⌃s)', atlasBody.includes("...(reducedStage ? [] : [{ title: 'COORDINATOR (its composer)'"))
  check('the SPLIT section rides the split’s own width gate (one gate, one truth)', atlasBody.includes('!reducedStage && splitAvailableAt(cols, rows)'))
  // SP-8's second half: the SPLIT rows speak the LIVE state.
  // While the full board stands the atlas teaches only the toggle
  // ('s split view'); the chat pane's grammar — '[ ] divider',
  // 's full board', the pane ↵ — prints only while the split composes
  // (splitOn from the screen's one splitActive fact).
  check('the atlas takes the live split fact (splitOn rides splitActive)', screen.includes('splitOn={splitActive}') && atlasBody.includes('splitOn = false'))
  check("split OFF teaches the toggle only ('s split view' — no divider, no way-back)", atlasBody.includes("{ title: 'SPLIT VIEW (s toggles)', keys: [{ keys: 's', label: 'split view' }] }"))
  check('split ON keeps the pane grammar (the way back + divider stay taught there)', atlasBody.includes("? { title: 'SPLIT VIEW (s toggles)', keys: regionKeysFor('chat', { ...stage, chatSession: chat }) }"))
}
{
  // The resolver truths the atlas now prints, driven pure.
  const { regionKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const reducedList = regionKeysFor('list', { newSession: false })
  check(
    'the reduced-stage list drops the full-stage doors (n · r · s · space · newline) and single-↵s the enter',
    !reducedList.some(k => ['n', 'r', 's', 'space', '⇧↵/⌃j'].includes(k.keys)) && reducedList.some(k => k.keys === '↵' && k.label === 'enter session'),
  )
  const fullList = regionKeysFor('list', { newSession: true })
  check('the full-stage list keeps the whole grammar incl. marks and split', ['↵↵', 'n', 'r', '→', '/', '⌃x ⌃x', 'm', 'space', 's'].every(keys => fullList.some(k => k.keys === keys)))
  check('the coordinator section still teaches ⌃s where it fires', regionKeysFor('coordinator', { newSession: true }).some(k => k.keys === '⌃s'))
}
// NEEDS-REAL-BOX: `?` on the plain live view (concourse off, ≥120 cols) —
// no COORDINATOR and no SPLIT section, a SESSIONS section with single-↵
// enter; `?` on the full board at exactly 120 columns — no SPLIT section;
// at 121+ — SPLIT appears.

// ── §3b · the atlas is frame-honest and frame-bounded (C3, win-triage S10) ──
console.log('§3b the atlas reads the frame and clamps to it')
{
  const atlasBody = screen.slice(screen.indexOf('function ConcourseKeyAtlas'))
  // The mount hands the FRAME, never the board pane: inside a split, the
  // screen-scope `cols` is the halved pane width — the atlas gated its
  // SPLIT section on it, hiding the pane grammar exactly when split was ON
  // (and centring the overlay over the pane instead of the screen).
  check('the atlas mounts on the frame width (termCols), never the pane cols', screen.includes('<ConcourseKeyAtlas cols={termCols}'))
  // The clamp: a short frame folds whole trailing sections into one counted
  // marker row and the footer always paints — the old top-only clamp shed
  // 'esc close' first with no marker.
  check('the panel height clamps to the frame (a true-height budget exists)', atlasBody.includes('const maxHeight = Math.max(7, rows - 2)'))
  check('shedding is explicit — the counted marker row', atlasBody.includes('— grow the window'))
  check('…and whole trailing sections fold, never silent row loss', atlasBody.includes('shown = shown.slice(0, -1)'))
  const markerAt = atlasBody.indexOf('— grow the window')
  // lastIndexOf: the clamp's own comment also spells 'esc close'; the
  // FOOTER's occurrence is the final one.
  const footerAt = atlasBody.lastIndexOf('esc close')
  check('the footer paints AFTER the marker (esc close survives every height)', markerAt !== -1 && footerAt !== -1 && markerAt < footerAt)
}

// ── §3c · the contract-offer footer speaks its own esc (C3, win-triage S10) ─
console.log('§3c the contract-offer card names what esc does')
{
  const { readFileSync: readFs } = await import('node:fs')
  const offer = readFs(new URL('../../src/components/concourse/ContractOfferCard.tsx', import.meta.url), 'utf8')
  const prompt = readFs(new URL('../../src/components/permissions/PermissionPrompt.tsx', import.meta.url), 'utf8')
  check("the ask face overrides the inherited footer ('esc starts it plain' — esc BIRTHS here, it never cancels)", offer.includes('escapeHint="esc starts it plain"'))
  check("the prompt's default footer stands for every other consumer", prompt.includes("escapeHint = 'esc cancel'") && prompt.includes('${escapeHint}'))
}

// ── §4 · the live meta row follows the draft (SURVIVED L2) ──────────────────
// Finding `live-composer-meta-row-says-enter-send-always`: the live
// composer took the literal '↵ send · ⇧↵ newline · tab panes' in the very
// frame whose footer printed '↵↵ enter session' — on an empty draft ↵
// never sends (it arms-then-enters; single-↵ on the reduced stage). The
// manifest's own contract line says it: "its own meta row says '↵ send'
// while a draft exists".
console.log('§4 live meta row: enter-grammar on an empty draft, send only with words held')
{
  check(
    'the hint is derived from the draft (empty ⇒ the enter grammar, per stage)',
    screen.includes("liveDraft.text.length === 0") &&
      screen.includes("'↵↵ enter session · tab panes'") &&
      screen.includes("'↵ enter session · tab panes'"),
  )
  check('the live composer mount carries the derived hint', screen.includes('{...(liveKeysHint !== undefined ? { keysHint: liveKeysHint } : {})}'))
  const manifest = readFileSync(join(ROOT, 'src/components/concourse/controlManifest.ts'), 'utf8')
  check('the manifest contract the row now honors still stands', manifest.includes("its own meta row carries '↵ send' while a draft exists") || manifest.includes("meta row says '↵ send' while a draft exists") || manifest.includes("meta row carries '↵ send'") || manifest.includes("'↵ send' while a draft exists"))
}
// NEEDS-REAL-BOX: tab to LIVE with an empty draft — the meta row reads the
// enter grammar and the footer agrees; type one word — the row flips to
// '↵ send · ⇧↵ newline · tab panes' and ↵ sends (the draft-aware ruling).

process.exit(failures === 0 ? 0 : 1)
