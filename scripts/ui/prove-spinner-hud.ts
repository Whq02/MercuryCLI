#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-spinner-hud.ts — source-text invariants for the in-turn
//  cockpit HUD's live context-burn gauge (SpinnerAnimationRow byline).
//
//  The PIXELS are render-verified by render-spinner-hud.ts (UI_RENDER=1, real
//  turns). This pure-logic proof locks the gauge's CONTRACT so the default
//  green-gate catches a regression without a PTY boot:
//    • sourced from the live getLiveContextUsage() seam (same math the API uses)
//    • the SPARK ramp + gaugeColor (TEAL→AMBER→CRIMSON) — no raw hex
//    • FORK-gated, WIDTH-gated (sheds first on a narrow term), and HONEST
//      (self-omits when usedPct is null — never a fabricated %).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(root, 'src/components/Spinner/SpinnerAnimationRow.tsx'), 'utf-8')

let failures = 0
const check = (label: string, cond: boolean): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('============================================================')
console.log(' in-turn cockpit HUD — context-burn gauge source invariants')
console.log('============================================================')

// — sourced from the live published seam (not a re-computation / fake) —
check('INC-4549 floor: an unstamped turn clock is floored to the spinner mount frame',
  /if \(loadingStartTimeRef\.current === 0\) \{\s*loadingStartTimeRef\.current = now/.test(SRC))
check('imports getLiveContextUsage (the live MercuryFrame-published seam)',
  /import\s*\{\s*getLiveContextUsage\s*\}\s*from\s*'\.\.\/\.\.\/utils\/cockpit\/contextUsageLive\.js'/.test(SRC))
check('reads getLiveContextUsage().usedPct into ctxPct', /getLiveContextUsage\(\)\.usedPct/.test(SRC))

// — the in-kit ramp + gauge color, NO raw hex —
check('imports the SPARK ramp + gaugeColor from the kit',
  /import\s*\{[^}]*\bgaugeColor\b[^}]*\}\s*from\s*'\.\.\/mercury-ui\/theme\.js'/.test(SRC) &&
  /import\s*\{[^}]*\bSPARK\b[^}]*\}\s*from\s*'\.\.\/mercury-ui\/glyphs\.js'/.test(SRC))
check('the gauge fill is ramp-colored via gaugeColor(ctxPct)', /gaugeColor\(ctxPct\)/.test(SRC))
check('the spark cell is selected off the SPARK ramp by fill %',
  /SPARK\[Math\.min\(SPARK\.length\s*-\s*1,\s*Math\.floor\(\(ctxPct\s*\/\s*100\)\s*\*\s*SPARK\.length\)\)\]/.test(SRC))
const ctxBlock = SRC.slice(SRC.indexOf('Context-window burn'), SRC.indexOf('Context-window burn') + 1400)
check('the gauge introduces NO raw hex (tokens only)', !/#[0-9a-fA-F]{3,6}\b/.test(ctxBlock))

// — stamp-gated, width-gated, honest (self-omits on null) —
check('showCtx is present ', /const showCtx\s*=/.test(SRC))
check('showCtx is WIDTH-gated last (availableSpace > usedAfterTokens + ctxWidth)',
  /availableSpace\s*>\s*usedAfterTokens\s*\+\s*ctxWidth/.test(SRC))
check('HONEST: gauge self-omits when usedPct is null (ctxPct != null guard)',
  /ctxPct\s*!=\s*null/.test(SRC) && /ctxPctRaw\s*!=\s*null\s*\?\s*Math\.round\(ctxPctRaw\)\s*:\s*null/.test(SRC))
// the byline meta ink is ADAPTIVE (tokens.textSecondary —
// byte-equal SECOND on dark; light families use their own palette).
check("the 'ctx' label rides the adaptive secondary meta token", /<Text color=\{tokens\.textSecondary\}>\{' ctx'\}<\/Text>/.test(SRC))
check('rendered only when showCtx && ctxPct != null (no NaN/null leak)',
  /showCtx\s*&&\s*ctxPct\s*!=\s*null/.test(SRC))

// ── work-in-flight gauge ("◐ N tools") + its prop threading ──────────────────
const SPIN = readFileSync(join(root, 'src/components/Spinner.tsx'), 'utf-8')
const REPL = readFileSync(join(root, 'src/screens/REPL.tsx'), 'utf-8')
console.log('\n  -- work-in-flight gauge --')
// The gauge counts the VIEWED scope's in-flight tools: the leader's while
// the leader is on screen, a viewed agent's while its transcript is.
check('REPL threads activeToolCount={viewInProgressToolUseIDs.size} to the spinner',
  /activeToolCount=\{viewInProgressToolUseIDs\.size\}/.test(REPL))
check('Spinner.tsx forwards activeToolCount to SpinnerAnimationRow',
  /activeToolCount=\{activeToolCount\}/.test(SPIN))
check('wif lights up only on PARALLEL tools (activeToolCount >= 2)',
  /activeToolCount\s*>=\s*2/.test(SRC))
check('wif carries the in-progress spine glyph (GLYPH.inProgress = ◐)',
  /GLYPH\.inProgress.*tools/.test(SRC))
check('wif rides the success spine (tokens.success — TEAL on dark)', /color=\{tokens\.success\}/.test(SRC))
check('showWif is present ', /const showWif\s*=/.test(SRC))
check('showWif is WIDTH-gated AFTER the ctx group (sheds first)',
  /availableSpace\s*>\s*usedAfterCtx\s*\+\s*wifWidth/.test(SRC))

// ── streaming-cadence (tok/s) instrument ─────────────────────────────────────
console.log('\n  -- streaming-cadence (tok/s) instrument --')
check('throughput sampled off the RAW response-length delta over the clock',
  /currentResponseLength\s*-\s*rateSampleRef\.current\.len/.test(SRC))
check('EMA-smoothed (steady gauge, not jitter)',
  /smoothedOtpsRef\.current\s*=\s*smoothedOtpsRef\.current\s*\*\s*0\.6\s*\+\s*instant\s*\*\s*0\.4/.test(SRC))
check('sampled every ~250ms (stable cadence read)', /dtMs\s*>=\s*250/.test(SRC))
check('shown ONLY while text streams (responding / tool-input)',
  /mode === 'responding' \|\| mode === 'tool-input'/.test(SRC) && /tok\/s/.test(SRC))
check('zeroed under reducedMotion (no live clock → no rate)',
  /reducedMotion\)\s*\{\s*smoothedOtpsRef\.current\s*=\s*0/.test(SRC))
check('showOtps is WIDTH-gated last (after the wif group; the stamp locals folded away)',
  /const showOtps\s*=/.test(SRC) &&
  /availableSpace\s*>\s*usedAfterWif\s*\+\s*otpsWidth/.test(SRC))
check('the rate rides the adaptive secondary meta token', /<Text key="otps"[\s\S]*?color=\{tokens\.textSecondary\}>/.test(SRC))

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ cockpit HUD gauges (ctx-burn + work-in-flight) — sourced, ramped, fork+width-gated, honest')
  process.exit(0)
} else {
  console.log(` ❌ context-burn gauge — ${failures} invariant(s) broken`)
  process.exit(1)
}
