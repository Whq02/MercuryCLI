#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-surface-claim.ts — THE SURFACE-CLAIM INVARIANT (structural)
//
//  Root-caused (the "fullscreen partial-splash paint on tall-panel
//  mount" residual): the fullscreen modal pane implemented "the surface
//  claims the FULL height" as a maxHeight CAP — a bottom-anchored pane whose
//  content is SHORTER than the viewport left the rows above its ▔ divider
//  exposing the UNDERLYING home mid-relayout (the sheared splash). VSHOT_TEE
//  byte replay proved the writer/diff innocent; the COMPOSE was the bug.
//
//  THE LAW SINCE LUSTRE L1 — two deliberate modes at the ONE
//  pane every command surface flows through:
//
//    · BLANK CLAIM (the recess gate CLOSED — MERCURY_RECESS=0 · NO_COLOR ·
//      16-color families): the exact invariant — peek 0 ⇒ the
//      opaque pane's height EQUALS the viewport, flexGrow spacers on BOTH
//      sides center a short surface, the opaque fill blanks every unused row.
//
//    · LAYERED CLAIM (the gate OPEN): the pane stays FULLY OPAQUE (a
//      transparent spacer is structurally impossible — a dirty overlay's
//      repaint wipes earlier siblings' cells within its rect, the
//      refuted-vacated-fill class) but bottom-anchors at CONTENT height; the
//      rows above it are genuinely uncovered live context that the
//      post-compose recess pass dims one emphasis step (the elevated-rect
//      registration). The sheared-splash class stays dead: what shows above
//      the divider is the REAL, settled, recessed cockpit — never a
//      mid-relayout artifact — because the cockpit subtree stays mounted
//      with stable geometry.
//
//  This proof locks the ENCODING at the seam; the behavioral oracle is
//  scripts/ui/render-surface-claim.ts (UI_RENDER=1 — real PTY grids:
//  blank-claim rows above the divider under MERCURY_RECESS=0, and the
//  RECESSED backdrop law when the gate is open).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-surface-claim.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(
  join(root, 'src', 'components', 'FullscreenLayout.tsx'),
  'utf-8',
)

console.log('============================================================')
console.log(' Fullscreen modal SURFACE-CLAIM invariant')
console.log('============================================================')

// The claim gate is derived from the ONE peek decision, not re-derived.
check(
  'modalClaims is derived from modalPeek === 0 (one claim decision)',
  /const modalClaims = modalPeek === 0;/.test(src),
)
// The recess mode is decided by the ONE policy seam (never a local env read).
check(
  'recessOn derives from recessTargetFor (the ONE recess policy seam)',
  /const recessOn = modal != null && recessTargetFor\(t\) !== null;/.test(src),
)
check(
  'blankClaims = modalClaims && !recessOn (the closed-gate blank claim)',
  /const blankClaims = modalClaims && !recessOn;/.test(src),
)
// BLANK CLAIM: the pane HEIGHT equals the viewport — the
// invariant proper (`maxHeight` alone is the pre-fix bug: a cap, not a claim).
check(
  'blank claim carries height={blankClaims ? terminalRows : undefined} (claim, not cap)',
  /height=\{blankClaims \? terminalRows : undefined\} maxHeight=\{terminalRows - modalPeek\}/.test(
    src,
  ),
)
// The spacers center a short surface ONLY in the blank claim; the layered
// claim bottom-anchors at content height (no dead void to center in).
check(
  'flexGrow spacer above the ▔ divider, gated on blankClaims',
  /\{blankClaims && <Box flexGrow=\{1\} \/>\}<Box flexShrink=\{0\}><Text color="info">/.test(
    src,
  ),
)
check(
  'flexGrow spacer BELOW the content too (blank claim centers short surfaces)',
  /\{modal\}<\/Box>\{blankClaims && <Box flexGrow=\{1\} \/>\}/.test(src),
)
// BOTH modes: the pane is FULLY OPAQUE — the refuted-vacated-fill law. A
// transparent spacer cannot survive compose (a dirty overlay's repaint wipes
// earlier siblings' cells); the layered look comes from NOT COVERING rows,
// never from transparency.
check(
  'pane stays opaque={true} in BOTH modes (transparency is structurally banned)',
  /flexDirection="column" overflow="hidden" opaque=\{true\}>/.test(src),
)
// LAYERED CLAIM: the pane registers its rect as the ELEVATED surface so the
// compositor recesses everything outside it.
check(
  'the pane registers elevated exactly while recessOn',
  /<Box ref=\{recessOn \? elevatedRef : undefined\} position="absolute"/.test(src),
)
// The non-claim path (classic inline home, peek 2) keeps the transcript
// sliver: no unconditional height on the pane.
check(
  'peek>0 path keeps the designed transcript sliver (height undefined off-claim)',
  /blankClaims \? terminalRows : undefined/.test(src),
)

// ── the compositor half ─────────────────────────────
// The recess pass no-ops without a published target. The layout owner
// publishes it for the live token set (memoized per family × accent) and
// clears it on unmount — without this every layered claim painted its
// uncovered rows at full strength (neither recessed nor blanked).
console.log('-- the compositor half: the recess target is published')
check(
  'the layout owner publishes the recess target for the live tokens',
  /useEffect\(\(\) => \{\s*\n\s*setRecessTarget\(recessTargetFor\(tokens\)\)\s*\n\s*return \(\) => setRecessTarget\(null\)\s*\n\s*\}, \[tokens\]\)/.test(src),
)

// ── the shell right edge ────────────────────────────
// The layout engine resolves a child's percent width against its owner's
// BORDER box (cellLayout.ts's ratified pin), so a PADDED slot wrapper handed
// every width="100%" shell the full terminal width from one column in —
// right border off-screen. The slot is FLUSH (no padding, no margin: a shell
// spans the slot like the prompt and status boxes below it), the context
// advertises that exact width, and the slot's own shells never ask for a
// percent width (a column child stretches to its owner's content width).
console.log('-- the shell right edge: a flush slot, shells stretch')
check(
  'the modal slot wrapper is flush (no padding, no margin)',
  /<Box flexShrink=\{0\} flexDirection="column">\{modal\}<\/Box>/.test(src),
)
check(
  'the modal context advertises the slot width it actually provides',
  /rows: terminalRows - modalPeek - 1,\s*\n\s*columns,\s*\n\s*scrollRef: modalScrollRef \?\? null,/.test(src),
)
const kitSrc = readFileSync(
  join(root, 'src', 'components', 'mercury-ui', 'components.tsx'),
  'utf-8',
)
const standaloneShell = kitSrc.match(
  /<Box ref=\{elevated \? elevatedRef : undefined\} flexDirection="column" borderStyle="round"[^\n]*>/,
)
check(
  'CommandCenter standalone shell asks for no percent width',
  standaloneShell !== null && !/width="100%"/.test(standaloneShell[0]),
)
const embeddedBody = kitSrc.match(/if \(embedded\) \{[\s\S]*?return \(\s*\n\s*<Box flexDirection="column"([^\n]*)>/)
check(
  'CommandCenter embedded body asks for no percent width',
  embeddedBody !== null && !/width="100%"/.test(embeddedBody[1]!),
)
const towerSrc = readFileSync(
  join(root, 'src', 'components', 'CockpitView.tsx'),
  'utf-8',
)
// Comments name the rule they enforce; only JSX props count.
const towerJsx = towerSrc.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '')
check(
  'the cockpit tower asks for no percent width',
  !/width="100%"/.test(towerJsx),
)

// ── the tower fits its slot ─────────────────────────
// Sized from the raw terminal, a 24- or 30-row viewport pushed the tower's
// footer (every exit key) and bottom border off-screen. The tower caps its
// height at the slot's row budget; the body is the one region that yields,
// inside a scroll viewport bound to the slot's page-key/wheel route.
console.log('-- the tower fits its slot: footer always on screen')
check(
  'the tower reads its budget from the modal slot (useModalOrTerminalSize)',
  /const slot = useModalOrTerminalSize\(\{ rows: termRows, columns: termCols \}\)/.test(towerSrc),
)
check(
  'the tower caps its height at the slot rows inside the modal and clips (spread, never an explicit undefined)',
  /\{\.\.\.\(insideModal \? \{ maxHeight: slot\.rows, overflow: 'hidden' as const \} : \{\}\)\}/.test(towerSrc),
)
check(
  'the body is a ScrollBox inside a shrinkable region (header/tabs/footer never shrink)',
  /<Box ref=\{bodyBoxRef\} marginTop=\{1\} flexDirection="column" flexShrink=\{1\} minHeight=\{0\}>\s*\n\s*\{insideModal \? \(\s*\n\s*<ScrollBox ref=\{bodyRef\}/.test(towerSrc) &&
    /<Box marginTop=\{1\} flexShrink=\{0\}>\s*\n\s*\{TABS\.map/.test(towerSrc),
)
check(
  'the body binds the slot scroll route (PageUp/PageDown, ctrl+home/end, wheel)',
  /modalScrollRef\.current = bodyRef\.current/.test(towerSrc),
)
check(
  'the tower footer packs to the slot inner width (close hint reserved)',
  /packFooter\(/.test(towerSrc) && /'esc close',\s*\n\s*\]\.join\(' · '\),\s*\n\s*Math\.max\(0, slot\.columns - 4\)/.test(towerSrc),
)

// ── the transcript gutter ───────────────────────────
// Inside the SESSION frame the transcript body sits one column in from each
// border; its wrap width is the frame-inner width minus the gutter, via its
// own identity-stable size override (the bands above keep the full width).
console.log('-- the transcript gutter inside the frame')
check(
  'the transcript area pads by the gutter (1 in the cockpit frame, 0 otherwise)',
  /const transcriptGutter = cockpit \? 1 : 0/.test(src) && /paddingX=\{transcriptGutter\}/.test(src),
)
check(
  'the transcript wraps inside the gutter (its own size override)',
  /columns: Math\.max\(1, sizeVal\.columns - 2 \* transcriptGutter\)/.test(src) &&
    /<TerminalSizeContext\.Provider value=\{transcriptSize\}>/.test(src),
)

console.log(
  failures === 0
    ? '✅ surface-claim invariant GREEN'
    : `❌ surface-claim invariant RED (${failures})`,
)
process.exit(failures === 0 ? 0 : 1)
