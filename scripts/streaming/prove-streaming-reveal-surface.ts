#!/usr/bin/env bun
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const caps = await import(join(ROOT, 'src/screen/renderer/terminal-session/capabilities.ts'))
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
  check('the ALTERNATE screen paints the tail (no scrollback to yank into)', streamingRevealSuppressed(false, true) === false, 'change streamingRevealSuppressed in src/screen/renderer/terminal-session/capabilities.ts so the fullscreen surface is never suppressed by the platform yank bug')
  check('the INLINE surface keeps the conhost suppression', streamingRevealSuppressed(false, false) === true, 'change streamingRevealSuppressed in src/screen/renderer/terminal-session/capabilities.ts so the inline surface stays suppressed when hasCursorUpViewportYankBug() is true')
  check('reduced motion suppresses on the alternate screen too', streamingRevealSuppressed(true, true) === true, 'change streamingRevealSuppressed in src/screen/renderer/terminal-session/capabilities.ts so reducedMotion suppresses whatever the screen')
  check('reduced motion suppresses inline', streamingRevealSuppressed(true, false) === true, 'change streamingRevealSuppressed in src/screen/renderer/terminal-session/capabilities.ts so reducedMotion suppresses the inline surface')

  section('§2 the capability keeps its platform truth (the region-scroll control)')
  check('hasCursorUpViewportYankBug stays true for all of win32 (the platform fact is untouched)', hasCursorUpViewportYankBug() === true, 'hasCursorUpViewportYankBug in src/screen/renderer/terminal-session/capabilities.ts must stay true on win32')
  check('regionScrollTrustedNow stays false on win32 — ConPTY re-synthesizes region scrolls on BOTH screens (never surface-split)', regionScrollTrustedNow() === false, 'regionScrollTrustedNow in src/screen/renderer/terminal-session/capabilities.ts must stay the negation of hasCursorUpViewportYankBug, with no surface argument')
} finally {
  Object.defineProperty(process, 'platform', platformDesc)
}

section('§3 non-win32 without WT_SESSION: no suppression on either surface')
{
  check('fullscreen paints', streamingRevealSuppressed(false, true) === false, 'streamingRevealSuppressed in src/screen/renderer/terminal-session/capabilities.ts must be false for fullscreen off win32 without WT_SESSION')
  check('inline paints', streamingRevealSuppressed(false, false) === false, 'streamingRevealSuppressed in src/screen/renderer/terminal-session/capabilities.ts must be false inline when hasCursorUpViewportYankBug() is false')
  check('reduced motion still suppresses (the operator word outranks the surface)', streamingRevealSuppressed(true, true) === true, 'streamingRevealSuppressed in src/screen/renderer/terminal-session/capabilities.ts must return true whenever reducedMotion is true')
  const wtDesc = process.env.WT_SESSION
  process.env.WT_SESSION = '1'
  try {
    check('WT_SESSION (WSL through conhost) splits by surface exactly like win32', streamingRevealSuppressed(false, true) === false && streamingRevealSuppressed(false, false) === true, 'hasCursorUpViewportYankBug in src/screen/renderer/terminal-session/capabilities.ts must treat WT_SESSION like win32')
  } finally {
    if (wtDesc === undefined) delete process.env.WT_SESSION
    else process.env.WT_SESSION = wtDesc
  }
}

section('§4 source pins — the consumers ride the one owner')
{
  {
    const { openStatusPart } = await import('../ui/chatScenarios.ts')
    const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
    const status = await openStatusPart('streaming-reveal-status', { keepHome: true })
    const row = (): string => (status.handed.spinner !== null ? 'the verb row' : status.handed.hold !== null ? 'the hold row' : 'no row')
    await status.plant({ seatLive: { ...IDLE_LIVE, inFlight: true, phase: 'responding' }, textActive: true, streamingSuppressed: false })
    const revealed = row()
    await status.plant({ streamingSuppressed: true })
    const suppressed = row()
    await status.close()
    check('showSpinner stands the verb row up when the reveal is suppressed', revealed === 'the hold row' && suppressed === 'the verb row', `prose streaming: ${revealed}; with the reveal suppressed: ${suppressed}; the streamingSuppressed prop must reach showSpinner in src/screen/chat/useChatStatus.tsx`)
  }
}

if (savedWt === undefined) delete process.env.WT_SESSION
else process.env.WT_SESSION = savedWt

console.log(failures === 0 ? '\nprove-streaming-reveal-surface: ALL LAWS HOLD' : `\nprove-streaming-reveal-surface: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
