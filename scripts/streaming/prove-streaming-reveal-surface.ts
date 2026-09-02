#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-streaming-reveal-surface.ts — the live streaming
//  reveal's suppression gate is SURFACE-SPLIT (FN-016 R2, [Windows]).
//
//  THE DEFECT: hasCursorUpViewportYankBug() is true for every win32 process
//  (and WT_SESSION — WSL through conhost), and the REPL's streamingSuppressed
//  gate consumed it with NO surface term — so the live streaming tail never
//  mounted on any Windows box, on the alternate screen included, where the
//  named hazard (conhost follows cursor-up into SCROLLBACK,
//  microsoft/terminal#14774) cannot occur: the alternate screen has no
//  scrollback to yank into. The whole reply appeared in one jump at settle.
//  And the verb row stood down WITH it: showSpinner read !textActive on the
//  stated grounds that streaming text is visible — while the suppressed tail
//  painted nothing — so the operator got no prose, no verb, no activity
//  description for the entire stream.
//
//  THE LAW: suppression = reducedMotion OR (yank bug AND NOT fullscreen).
//   §1 the ONE owner's truth table under a forced win32 platform;
//   §2 the capability keeps its platform truth (regionScrollTrustedNow's
//      control: ConPTY re-synthesizes region scrolls on BOTH screens — that
//      consumer must NOT inherit the surface split);
//   §3 non-win32 without WT_SESSION never suppresses on either surface;
//   §4 source pins: the REPL computes streamingSuppressed through the one
//      owner with its surface fact; showSpinner carries the suppression
//      term; the three transcript arms still share the one gate.
//
//  Run: ~/.bun/bin/bun run scripts/streaming/prove-streaming-reveal-surface.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const caps = await import(join(ROOT, 'src/ink/session/capabilities.ts'))
const { streamingRevealSuppressed, hasCursorUpViewportYankBug, regionScrollTrustedNow } = caps as {
  streamingRevealSuppressed: (reducedMotion: boolean, fullscreenActive: boolean) => boolean
  hasCursorUpViewportYankBug: () => boolean
  regionScrollTrustedNow: () => boolean
}

const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedWt = process.env.WT_SESSION
delete process.env.WT_SESSION

section('§1 the one owner, forced win32: fullscreen paints, inline suppresses')
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
try {
  check('the ALTERNATE screen paints the tail (no scrollback to yank into)', streamingRevealSuppressed(false, true) === false)
  check('the INLINE surface keeps the conhost suppression', streamingRevealSuppressed(false, false) === true)
  check('reduced motion suppresses on the alternate screen too', streamingRevealSuppressed(true, true) === true)
  check('reduced motion suppresses inline', streamingRevealSuppressed(true, false) === true)

  section('§2 the capability keeps its platform truth (the region-scroll control)')
  check('hasCursorUpViewportYankBug stays true for all of win32 (the platform fact is untouched)', hasCursorUpViewportYankBug() === true)
  check('regionScrollTrustedNow stays false on win32 — ConPTY re-synthesizes region scrolls on BOTH screens (never surface-split)', regionScrollTrustedNow() === false)
} finally {
  Object.defineProperty(process, 'platform', platformDesc)
}

section('§3 non-win32 without WT_SESSION: no suppression on either surface')
{
  check('fullscreen paints', streamingRevealSuppressed(false, true) === false)
  check('inline paints', streamingRevealSuppressed(false, false) === false)
  check('reduced motion still suppresses (the operator word outranks the surface)', streamingRevealSuppressed(true, true) === true)
  const wtDesc = process.env.WT_SESSION
  process.env.WT_SESSION = '1'
  try {
    check('WT_SESSION (WSL through conhost) splits by surface exactly like win32', streamingRevealSuppressed(false, true) === false && streamingRevealSuppressed(false, false) === true)
  } finally {
    if (wtDesc === undefined) delete process.env.WT_SESSION
    else process.env.WT_SESSION = wtDesc
  }
}

section('§4 source pins — the consumers ride the one owner')
{
  const repl = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')
  check(
    'the REPL computes streamingSuppressed through the owner with its surface fact',
    repl.includes('const streamingSuppressed = streamingRevealSuppressed(reducedMotion, fullscreen);'),
  )
  check(
    'no bare yank-bug read remains in the REPL (the owner is the only road)',
    !repl.includes('hasCursorUpViewportYankBug()'),
  )
  check(
    'showSpinner stands the verb row up when the reveal is suppressed',
    repl.includes('!textActive || isBriefOnly || streamingSuppressed'),
  )
  check(
    'the three transcript arms mount the focused tail on every surface (its quiet-stream line paints where the text is suppressed — FN-016 R12)',
    (repl.match(/streamingTail=\{focusedTail\}/g) ?? []).length === 3,
  )
  check(
    'the three transcript arms share the one gate — it suppresses the tail\'s TEXT half',
    (repl.match(/streamingTextSuppressed=\{streamingSuppressed\}/g) ?? []).length === 3,
  )
}

if (savedWt === undefined) delete process.env.WT_SESSION
else process.env.WT_SESSION = savedWt

console.log(failures === 0 ? '\nprove-streaming-reveal-surface: ALL LAWS HOLD' : `\nprove-streaming-reveal-surface: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
