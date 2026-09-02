#!/usr/bin/env bun
// ============================================================================
//  prove-status-band — the working-status strip's single-source placement.
//
//  Operator directive: the spinner + turn-rollup strip moved
//  from the bottom slot to a pinned band under the cockpit center header
//  ("under the Mercury logo"). The hazard is DOUBLE-RENDER or ZERO-RENDER on
//  a mode boundary, so the contract is: ONE strip definition in REPL, the
//  cockpit placement owned by FullscreenLayout (statusBand under the center
//  header), the bottom placement gated by CockpitBottomStatus on the SAME
//  context the layout provides — one signal, two mutually-exclusive homes.
// ============================================================================
import { readFileSync } from 'node:fs'

let failures = 0
const t = (name: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures = 1
}

const repl = readFileSync('src/screens/REPL.tsx', 'utf8')
t('ONE strip definition (workingStatusStrip const)', (repl.match(/const workingStatusStrip = /g) ?? []).length === 1)
// the strip is THREE members — the verb row, the truth-tier
// streaming hold that fills its reserved slot while prose streams, then the
// rollup (window sized to the real spans; the hold's props + doctrine
// comment sit between spinner and hold).
t('strip carries the spinner + the streaming hold + the rollup', /workingStatusStrip = <Box[\s\S]{0,300}SpinnerWithVerb[\s\S]{0,1500}StreamingHoldRow[\s\S]{0,400}MercuryTurnRollup/.test(repl))
t('bottom placement rides CockpitBottomStatus', repl.includes('<CockpitBottomStatus>{workingStatusStrip}</CockpitBottomStatus>'))
t('cockpit placement threads statusBand into FullscreenLayout (transcript mode blanks it)', repl.includes('statusBand={inVirtualTranscript ? undefined : workingStatusStrip}'))
t('no stray direct SpinnerWithVerb render outside the strip', (repl.match(/<SpinnerWithVerb /g) ?? []).length === 1)

const fsl = readFileSync('src/components/FullscreenLayout.tsx', 'utf8')
t('layout renders the band only with the center frame (cockpit)', fsl.includes('{centerFrame && statusBand ? ('))
t(
  'berth card sits under HelmCenterHeader, inside the size override',
  // window widened 900→1800 for the WORKING-capsule block inside
  // the berth card (WorkCapsule + width math + its comment); 1800→3000 for
  // the hover-reason hint riding inside the same card.
  /HelmCenterHeader width=\{sizeVal\.columns\} \/> : null\}\s*<TerminalSizeContext\.Provider value=\{sizeVal\}>[\s\S]{0,900}\{centerFrame && statusBand \? \([\s\S]{0,3000}\{transcriptArea\}/.test(fsl),
)
// The berth design: rounded strong-border card, pinned (flexShrink
// 0), the living critter on the left, the strip beside it.: the
// border resolves through the token layer (dark ≡ DUNE, other families map).
const card = fsl.slice(fsl.indexOf('{centerFrame && statusBand ? ('), fsl.indexOf('{transcriptArea}'))
t('berth card is a rounded strong-bordered pin (token role)', card.includes('borderStyle="round"') && card.includes('borderColor={t.borderStrong}') && card.includes('flexShrink={0}'))
t('berth carries the pinned living critter', card.includes('<PinnedCritterBerth />'))
const home = readFileSync('src/components/MercuryHome.tsx', 'utf8')
// §MASCOT-DOWNGRADE: the original leg here
// pinned the berth to the FLAT 13-wide art — enforcing the regression it
// should have caught (in cockpit the berth is the ONLY mascot; flat read as
// "the old ugly shape"). The contract is now hero-first with the flat grid
// only below the hero's named floors; the render half lives in
// scripts/critters/prove-berth-hero.ts.
// the berth art brightens toward accentSoft under the kernel's
// hover (the pointer affordance — no new row, no slab); the needle carries
// the hover-aware def form.
t('PinnedCritterBerth renders the HERO art (flat only below the named floors)', /export function PinnedCritterBerth[\s\S]{0,4000}<AnimatedCritterArt def=\{hover \? hoverDef : def\} hero=\{heroFits\} square=\{!heroFits\} \/>/.test(home))
// continuity pass: the art rides a fixed bottom-aligned slot per
// FORM — the authored grids differ by rows, so without it a click-morph moved
// the whole berth (and everything under it).
t('berth art rides a fixed bottom-aligned slot (a morph swaps pixels, never rows)', /PinnedCritterBerth[\s\S]{0,3000}height=\{heroFits \? HERO_ART_LINES : SQUARE_ART_LINES\}/.test(home))
// 3.6.5 (VP-01/02): the gate IS the one form decision over allocated cells —
// the landing-floor constants no longer gate this surface (the needle moved
// WITH the ruling; hero treatment covers the hero + the design-gated
// premium-compact tier).
t('berth hero gate rides the ONE form decision', /PinnedCritterBerth[\s\S]{0,2000}decideCritterForm\(\{ columns, rows \}/.test(home))
t('berth critter is click-cyclable like the hero', /PinnedCritterBerth[\s\S]{0,3000}cycleSessionCritter/.test(home))

const ctx = readFileSync('src/context/cockpitActiveContext.tsx', 'utf8')
t('CockpitBottomStatus nulls when the cockpit is active', /if \(cockpit\) return null/.test(ctx))

// The WORKING capsule (operator design ask — "border the thinking
// glyph, design-system-matching"): while a turn is live the strip rides a
// rounded DUNE card. NO header row — the spinner's ✻ verb line IS the state
// (operator dedup call, live-tested: a ◐ WORKING header over the star row
// read as two state rows). Idle keeps the bare strip; the spinner drops its
// transcript rail inside (one container, not two); the capsule provides a
// width-TRUE TerminalSizeContext so the byline sheds against the space it
// actually has.
t('capsule wraps the cockpit statusBand, gated on statusBandActive', /<WorkCapsule\s[\s\S]{0,200}active=\{!!statusBandActive\}/.test(card))
t('capsule width budgets the berth interior minus the critter', /berthCritterCols\(sizeVal\.columns, sizeVal\.rows\)/.test(card))
t('REPL threads the live-turn signal (transcript mode blanks it)', repl.includes('statusBandActive={inVirtualTranscript ? undefined : spinnerSlotReserved}'))
const capsule = readFileSync('src/components/mercury-ui/WorkCapsule.tsx', 'utf8')
// continuity pass: the capsule keeps ONE tree shape and DRESSES by
// prop values (the old bare-children inactive return reparented — remounted —
// the status strip at every turn boundary). The card, width-true context, and
// honest-idle contracts survive, expressed through `dressed`.
t('capsule is a rounded furniture card while dressed (borderStrong — DUNE on dark, not identity)', capsule.includes("borderStyle={dressed ? 'round' : undefined}") && capsule.includes('borderColor={dressed ? tokens.borderStrong : undefined}'))
t('capsule has NO header row (the ✻ verb line is the one state row — operator dedup)', !capsule.includes('WorkingGlyph') && !capsule.includes('WORKING\''))
t('capsule provides the width-true size context to its interior while dressed', /dressed && outer \? \{ columns: innerW, rows: outer\.rows \} : outer/.test(capsule))
t('capsule is honest-idle (undressed ⇒ no border/padding) with a STABLE tree shape', capsule.includes('const dressed = active && width >= 24') && !/return children\b/.test(capsule))
const spin = readFileSync('src/components/Spinner.tsx', 'utf8')
t('spinner drops its rail inside the capsule (one container)', /if \(inWorkCapsule\) return inner/.test(spin))

console.log(failures ? '\n❌ STATUS-BAND RED' : '\n✅ STATUS-BAND GREEN')
process.exit(failures)
