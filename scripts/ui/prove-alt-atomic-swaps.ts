#!/usr/bin/env bun
// prove-alt-atomic-swaps — every alt-screen SWAP paints atomically: no
// standalone eager 2J may blank the terminal between an outgoing view and
// the incoming view's first composed frame (5.6 Sol audit; the
// boot-hold takeover + /mouse lifetime halves are pinned by
// prove-alt-lifetime).
//
// Classes closed here:
//   a. NESTED pane swaps (drill-into /workflows, esc back out): both the
//      open and the close wrote `2J H` eagerly, blanking the screen until
//      the next frame. Both now ride the deferred erase-before-paint seam
//      (needsEraseBeforePaint → ERASE_SCREEN folded inside the frame's one
//      BSU/ESU-protected write) — outgoing pixels stay until the swap.
//   b. $EDITOR / external-TUI RETURN (exitAlternateScreen): the fullscreen
//      path re-entered alt then 2J'd, exposing a blank until React's next
//      render. The erase now folds into the resume() repaint the same way.
import { readFileSync } from 'node:fs'

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`)
  if (!cond) fail = 1
}

const alt = readFileSync('src/ink/components/AlternateScreen.tsx', 'utf8')
const ink = readFileSync('src/ink/ink.tsx', 'utf8')

console.log('prove-alt-atomic-swaps')
console.log('── a. nested pane swaps carry no standalone 2J ──')
check(
  'nested OPEN writes margins only (no eager clear)',
  alt.includes('writeRaw(RESET_SCROLL_REGION);') &&
    !alt.includes("writeRaw(RESET_SCROLL_REGION + '\\x1b[2J\\x1b[H');"),
)
check(
  'nested CLOSE writes no clear at all',
  !alt.includes("writeRaw('\\x1b[2J\\x1b[H');"),
)
check(
  'both nested directions ride the deferred repaint seam',
  (alt.match(/repaintAfterNestedAltScreenClose\?\.\(\)/g) ?? []).length >= 2,
)
check(
  'the outermost mount still clears a fresh buffer — deferred into the first frame or written bare',
  // The clear survives on BOTH no-hold paths; since the deferred-entry seam
  // (prove-alt-lifetime) it rides INSIDE the first frame's atomic write for
  // instance mounts and stays immediate only for bare unit mounts.
  alt.includes("ink.armAltScreenEntry(ENTER_ALT_SCREEN + RESET_SCROLL_REGION + '\\x1b[2J\\x1b[H' + armBytes)") &&
    alt.includes("writeRaw(ENTER_ALT_SCREEN + RESET_SCROLL_REGION + '\\x1b[2J\\x1b[H' + armBytes)"),
)
check(
  'the deferred seam folds the erase into the frame write',
  /repaintAfterNestedAltScreenClose\(\): void \{[\s\S]{0,400}needsEraseBeforePaint = true/.test(ink),
)

console.log('── b. editor return paints with the composed repaint ──')
const exitFn = ink.slice(
  ink.indexOf('exitAlternateScreen(): void {'),
  ink.indexOf('exitAlternateScreen(): void {') + 2200,
)
check('exitAlternateScreen exists', exitFn.length > 100)
// The editor-handoff byte composites moved into root/screen-session.ts
// the invariants re-anchor to the builders.
const sess = readFileSync('src/ink/root/screen-session.ts', 'utf8')
check(
  'fullscreen return has NO eager 2J (erase is deferred to the builder non-alt branch)',
  sess.includes("(opts.altActive ? '' : ERASE_SCREEN + CURSOR_HOME)"),
)
check(
  'fullscreen return arms erase-with-first-paint',
  /if \(this\.altScreenActive\) \{\s*\n\s*this\.resetFramesForAltScreen\(\);[\s\S]{0,400}needsEraseBeforePaint = true;/.test(exitFn),
)
check(
  'non-fullscreen return still clears the abandoned alt buffer (unchanged)',
  /exitEditorBytes[\s\S]{0,500}\(opts\.altActive \? '' : EXIT_ALT_SCREEN\)/.test(sess),
)
check(
  'handing TO the external TUI still clears first (that 2J is correct)',
  /enterEditorBytes[\s\S]{0,600}ERASE_SCREEN \+\s*CURSOR_HOME/.test(sess) &&
    /enterAlternateScreen\(\): void \{[\s\S]{0,600}enterEditorBytes\(/.test(ink),
)

console.log('── c. pre-REPL exits stay covered (regression pins) ──')
const hold = readFileSync('src/ink/launcherAltHold.ts', 'utf8')
check(
  'an unconsumed launcher hold is released on process exit',
  hold.includes("process.on('exit'") && hold.includes('?1049l'),
)
// cleanupTerminalModes lives in shutdownRestoration.ts since the stage-1
// closure split (gracefulShutdown.ts is the light installer).
const shutdown = readFileSync('src/utils/shutdownRestoration.ts', 'utf8')
check(
  'graceful shutdown exits the alt buffer exactly once via unmount',
  shutdown.includes('inst?.isAltScreenActive') || shutdown.includes('inst.isAltScreenActive'),
)

if (fail) {
  console.log('❌ ALT-ATOMIC-SWAP CHECK(S) FAILED')
  process.exit(1)
}
console.log('✅ ALL ALT-ATOMIC-SWAP PROOFS PASS')
