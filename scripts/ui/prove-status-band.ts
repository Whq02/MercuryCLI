#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

let failures = 0
const t = (name: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures = 1
}

const repl = readFileSync('src/screens/REPL.tsx', 'utf8')
t('ONE strip definition (workingStatusStrip const)', (repl.match(/const workingStatusStrip = /g) ?? []).length === 1)
t('strip carries the spinner + the streaming hold + the rollup', /workingStatusStrip = <Box[\s\S]{0,300}SpinnerWithVerb[\s\S]{0,1500}StreamingHoldRow[\s\S]{0,400}MercuryTurnRollup/.test(repl))
t('bottom placement rides CockpitBottomStatus', repl.includes('<CockpitBottomStatus>{workingStatusStrip}</CockpitBottomStatus>'))
t('cockpit placement threads statusBand into FullscreenLayout (transcript mode blanks it)', repl.includes('statusBand={inVirtualTranscript ? undefined : workingStatusStrip}'))
t('no stray direct SpinnerWithVerb render outside the strip', (repl.match(/<SpinnerWithVerb /g) ?? []).length === 1)

const fsl = readFileSync('src/components/FullscreenLayout.tsx', 'utf8')
t('layout renders the band only with the center frame (cockpit)', fsl.includes('{centerFrame && statusBand ? ('))
t(
  'berth card sits under HelmCenterHeader, inside the size override',
  /HelmCenterHeader width=\{sizeVal\.columns\} \/> : null\}\s*<TerminalSizeContext\.Provider value=\{sizeVal\}>[\s\S]{0,900}\{centerFrame && statusBand \? \([\s\S]{0,3000}\{transcriptArea\}/.test(fsl),
)
const card = fsl.slice(fsl.indexOf('{centerFrame && statusBand ? ('), fsl.indexOf('{transcriptArea}'))
t('berth card is a rounded strong-bordered pin (token role)', card.includes('borderStyle="round"') && card.includes('borderColor={t.borderStrong}') && card.includes('flexShrink={0}'))
t('berth carries the pinned living critter', card.includes('<PinnedCritterBerth />'))
t('the small critter keeps a thirteen-column slot at the card\'s left (no centring across the row, no widening when alone)', card.includes('width={CR_COLS}') && !card.includes('alignItems') && !/flexGrow=\{[^}]*berth/.test(card))
t('the layout centres the small critter on the capsule\'s rows itself (no measured lead, no padding)', card.includes('justifyContent="center"') && !card.includes('paddingTop') && !/measureElement|berthLead|berthLevel/.test(card))
t('the berth is the sprite and the working capsule alone (no speech line, no third mount)', card.includes('<WorkCapsule') && (card.match(/<[A-Z][A-Za-z.]*/g) ?? []).every(tag => ['<Box', '<PinnedCritterBerth', '<WorkCapsule', '<TerminalSizeContext.Provider'].includes(tag)))
const home = readFileSync('src/components/MercuryHome.tsx', 'utf8')
t('PinnedCritterBerth renders the dock sprite (the square form over the dock grid)', /export function PinnedCritterBerth[\s\S]{0,4000}<AnimatedCritterArt def=\{hover \? hoverDockDef : dockDef\} square \/>/.test(home))
t('berth art rides a fixed bottom-aligned three-row slot (a morph swaps pixels, never rows)', /PinnedCritterBerth[\s\S]{0,4000}height=\{SQUARE_DOCK_ART_LINES\} flexDirection="column" justifyContent="flex-end"/.test(home))
t('berth critter is click-cyclable like the hero', /PinnedCritterBerth[\s\S]{0,3000}cycleSessionCritter/.test(home))

const ctx = readFileSync('src/context/cockpitActiveContext.tsx', 'utf8')
t('CockpitBottomStatus nulls when the cockpit is active', /if \(cockpit\) return null/.test(ctx))

t('capsule wraps the cockpit statusBand, gated on statusBandActive', /<WorkCapsule\s[\s\S]{0,200}active=\{!!statusBandActive\}/.test(card))
t('capsule width budgets the berth interior minus the critter\'s thirteen-column slot and the gap', card.includes('width={sizeVal.columns - 4 - 1 - CR_COLS}'))
t('REPL threads the live-turn signal (transcript mode blanks it)', repl.includes('statusBandActive={inVirtualTranscript ? undefined : spinnerSlotReserved}'))
const capsule = readFileSync('src/components/mercury-ui/WorkCapsule.tsx', 'utf8')
t('capsule is a rounded furniture card while dressed (borderStrong — DUNE on dark, not identity)', capsule.includes("borderStyle={dressed ? 'round' : undefined}") && capsule.includes('borderColor={dressed ? tokens.borderStrong : undefined}'))
t('capsule has NO header row (the ✻ verb line is the one state row — operator dedup)', !capsule.includes('WorkingGlyph') && !capsule.includes('WORKING\''))
t('capsule provides the width-true size context to its interior while dressed', /dressed && outer \? \{ columns: innerW, rows: outer\.rows \} : outer/.test(capsule))
t('capsule is honest-idle (undressed ⇒ no border/padding) with a STABLE tree shape', capsule.includes('const dressed = active && width >= 24') && !/return children\b/.test(capsule))
const spin = readFileSync('src/components/Spinner.tsx', 'utf8')
t('spinner drops its rail inside the capsule (one container)', /if \(inWorkCapsule\) return inner/.test(spin))

console.log(failures ? '\n❌ STATUS-BAND RED' : '\n✅ STATUS-BAND GREEN')
process.exit(failures)
