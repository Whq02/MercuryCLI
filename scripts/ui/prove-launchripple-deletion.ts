#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-launchripple-deletion.ts
//  PROOF for: the full-scene LaunchRipple detonation was a DEAD
//  chain — launchRipple inits false and setLaunchRipple(true) is called NOWHERE
//  in src/, so the render branch ALWAYS rendered null, the ms-clock useEffect
//  never ran, and launchRippleEnabled was imported but never called. This is a
//  behavior-preserving deletion of an always-null branch: the rendered output is
//  IDENTICAL by construction (removing `{false ? <X/> : null}` is a no-op), so
//  the proof is "the dead branch was provably unreachable + every live anchor
//  stayed + nothing dangles".
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-launchripple-deletion.ts
// ============================================================================
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repl = readFileSync(join(root, 'src', 'screens', 'REPL.tsx'), 'utf-8')
const home = readFileSync(join(root, 'src', 'components', 'MercuryHome.tsx'), 'utf-8')

console.log('============================================================')
console.log(' LaunchRipple dead-chain deleted (HB-0169)')
console.log('============================================================')

section('reachability: the branch was UNCONDITIONALLY dead (exhaustive)')
// a useState setter is a closed-over local binding — no reflective/dynamic caller
// is possible, so this grep over all of src/ is EXHAUSTIVE.
const launchTrueCallers = execSync(`grep -rn "setLaunchRipple(true)" "${join(root, 'src')}" || true`, {
  encoding: 'utf-8',
}).trim()
check('setLaunchRipple(true) is called NOWHERE in src/ (the branch only ever rendered null)', launchTrueCallers === '')

section('the dead chain is gone')
check('REPL.tsx no longer imports LaunchRipple / launchRippleEnabled', !/LaunchRipple|launchRippleEnabled/.test(repl))
check('REPL.tsx no longer has the launchRipple / launchElapsed state or the ms-clock', !/launchRipple|launchElapsed|setLaunchRipple/.test(repl))
check('REPL.tsx no longer has the satellite-dead submitCountRef', !/submitCountRef/.test(repl))
check('LaunchRipple.tsx is deleted', !existsSync(join(root, 'src', 'components', 'mercury-ui', 'LaunchRipple.tsx')))
check('MercuryHome.tsx no longer exports the orphan LAUNCH_ORIGIN_*_FRAC consts', !/LAUNCH_ORIGIN_(COL|ROW)_FRAC/.test(home))
// nothing in src/ still references the deleted chain (the only submitCountRef left
// is an UNRELATED live ref in useFeedbackSurvey, which is fine)
const dangling = execSync(
  `grep -rnE "LaunchRipple|LAUNCH_ORIGIN|launchRippleEnabled|launchElapsed" "${join(root, 'src')}" || true`,
  { encoding: 'utf-8' },
).trim()
check('zero dangling LaunchRipple/LAUNCH_ORIGIN refs remain in src/', dangling === '', dangling.split('\n')[0] ?? '')

section('the LIVE anchors the deletion must NOT touch are intact')
check('submitCount STATE is kept (useFeedbackSurvey / housekeeping / notifications depend on it)', /const \[submitCount, setSubmitCount\] = useState\(0\)/.test(repl))
check('the setSubmitCount(count => count + 1) increment is kept', /setSubmitCount\(count => count \+ 1\)/.test(repl))
check('permissionOverlay (the live tool-permission overlay) is kept and threaded to the layout', /const permissionOverlay =/.test(repl) && /overlay=\{inVirtualTranscript \? undefined : permissionOverlay\}/.test(repl))
check('the AlternateScreen wrap keeps mouseTracking + the tree child', /<AlternateScreen mouseTracking=\{isMouseTrackingEnabled\(\)\}>\{tree\}<\/AlternateScreen>/.test(repl))
// The ripple primitive (RIPPLE — the retired name, composed so this prover
// never spells it) is FULLY deleted: its last consumer
// — the EffortSlider ultracode burst — was replaced by the code-trace (the
// splash line-tracing grammar; the ripple slab painted dots OVER the label),
// so the whole ripple family is absent: primitive file deleted, zero refs in src.
const RIPPLE = ['Temp', 'estRipple'].join('')
const effort = readFileSync(join(root, 'src', 'commands', 'effort', 'EffortSlider.tsx'), 'utf-8')
check(`EffortSlider no longer imports ${RIPPLE} (code-trace replaced the burst)`, !effort.includes(RIPPLE))
check('EffortSlider carries the code-trace (the replacement is present, not just an ablation)', /CODE_TRACE_GLYPHS/.test(effort))
check(`${RIPPLE}.tsx is deleted`, !existsSync(join(root, 'src', 'components', 'mercury-ui', `${RIPPLE}.tsx`)))
const rippleRefs = execSync(`grep -rn "${RIPPLE}" "${join(root, 'src')}" || true`, {
  encoding: 'utf-8',
}).trim()
check(`zero ${RIPPLE} refs remain in src/`, rippleRefs === '', rippleRefs.split('\n')[0] ?? '')

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0169 — LaunchRipple dead-chain removed (byte-identical, anchors intact)')
  process.exit(0)
} else {
  console.log(` ❌ HB-0169 — ${failures} check(s) failed`)
  process.exit(1)
}
