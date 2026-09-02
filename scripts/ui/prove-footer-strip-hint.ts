#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-footer-strip-hint.ts — THE FOOTER TEACHES THE STRIP
//  (chat-feel item 4): the chat's key hints name the surface chord beside
//  "shift+↵ new line", STOP-DERIVED from the router — never a literal.
//
//  THE LAW: the hint is stripKeyMapHintOf('repl', presentStripStops()) —
//  the same derivation the face and the board paint. The concourse present
//  ⇒ "⇧← concourse"; the plain world (--chat, or the concourse switched
//  off) ⇒ "⇧← boot face"; no registered stop ⇒ nothing. POISON: a literal
//  "concourse"/"boot face" string in the footer — a world where the stop
//  vanished would keep teaching a dead chord, and the plain world would
//  name a surface that does not exist.
//
//    §1 THE DERIVATION (driven, pure) — both worlds, through the real
//       stripStops + stripKeyMapHintOf composition.
//    §2 THE FOOTER'S WIRING (source locks) — subscribed derivation, the
//       fullscreen gate (CB-10: the strip refuses inline boots), and NO
//       surface-name literal in the footer's source.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-footer-strip-hint.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { stripKeyMapHintOf, stripStops } = await import('../../src/context/surfaceRoute.js')
// The derivation folds the chord to the host's spelling at its one composer
// (identity on macOS, 'shift+←' words elsewhere) — the pins spell their
// expectations through the same owner so they are byte-exact on EVERY host.
const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.js')

section('§1 the derivation — both worlds, through the real strip owners')
{
  // The full world: concourse on, a chat focused. From the chat, the one
  // move left is the concourse.
  const full = stripStops({ concourseEnabled: true, chatBoot: false, chatPresent: true })
  check('full world stops = menu · concourse · chat', full.join(',') === 'boot-settings,concourse,repl', full.join(','))
  check('the chat footer hint reads "⇧← concourse" (host-spelled)', stripKeyMapHintOf('repl', full) === keyHintLabel('⇧← concourse'), stripKeyMapHintOf('repl', full))

  // The plain world (--chat, or the concourse switched off): the move left
  // lands on the boot face — the label the brief promises.
  const plainChat = stripStops({ concourseEnabled: true, chatBoot: true, chatPresent: true })
  const plainOff = stripStops({ concourseEnabled: false, chatBoot: false, chatPresent: true })
  check('plain world (--chat) stops = menu · chat', plainChat.join(',') === 'boot-settings,repl', plainChat.join(','))
  check('plain world (concourse off) stops = menu · chat', plainOff.join(',') === 'boot-settings,repl', plainOff.join(','))
  check('the plain-world hint reads "⇧← boot face" (host-spelled)', stripKeyMapHintOf('repl', plainChat) === keyHintLabel('⇧← boot face'), stripKeyMapHintOf('repl', plainChat))
  check('…in both plain spellings', stripKeyMapHintOf('repl', plainOff) === keyHintLabel('⇧← boot face'))

  // No registered stop to the left ⇒ the hint is EMPTY (the footer appends
  // nothing — never a dead chord).
  check('no stops ⇒ empty hint', stripKeyMapHintOf('repl', []) === '', JSON.stringify(stripKeyMapHintOf('repl', [])))
}

section('§2 the footer wiring (source locks)')
{
  const footer = readFileSync(
    join(import.meta.dir, '../../src/components/PromptInput/PromptInputFooter.tsx'),
    'utf8',
  )
  check(
    'the footer derives from stripKeyMapHintOf over presentStripStops',
    footer.includes("stripKeyMapHintOf('repl', presentStripStops())"),
  )
  check('the derivation is SUBSCRIBED (repaints on stop presence)', footer.includes('subscribeSurfaceRoute'))
  check(
    'the hint is fullscreen-gated (CB-10: the strip refuses inline boots)',
    /fullscreen && stripHint !== ''/.test(footer),
  )
  check(
    'POISON: no surface-name literal in the footer source',
    !/['"`][^'"`]*(?:concourse|boot face)[^'"`]*['"`]/i.test(footer.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
  )
  check(
    'the strip hint rides the newline row (one hints row, kit-joined)',
    /getNewlineInstructions\(\)\}\s*\{fullscreen && stripHint/.test(footer),
  )
}

if (failures > 0) {
  console.error(`\n❌ ${failures} FOOTER-STRIP-HINT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL FOOTER-STRIP-HINT PROOFS PASS')
