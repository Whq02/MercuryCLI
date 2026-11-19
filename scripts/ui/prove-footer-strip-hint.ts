#!/usr/bin/env bun
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
const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.js')
const footerModule = (await import('../../src/components/PromptInput/PromptInputFooter.js')) as { footerStripHint?: (hint: string) => string }
const footerStripHint = footerModule.footerStripHint ?? ((hint: string): string => hint)

section('§1 the derivation — both worlds, through the real strip owners')
{
  const full = stripStops({ concourseEnabled: true, chatBoot: false, chatPresent: true })
  check('full world stops = menu · concourse · chat', full.join(',') === 'boot-settings,concourse,repl', full.join(','))
  check('the chat footer hint reads "⇧← concourse" (host-spelled)', stripKeyMapHintOf('repl', full) === keyHintLabel('⇧← concourse'), stripKeyMapHintOf('repl', full))

  const plainChat = stripStops({ concourseEnabled: true, chatBoot: true, chatPresent: true })
  const plainOff = stripStops({ concourseEnabled: false, chatBoot: false, chatPresent: true })
  check('plain world (--chat) stops = menu · chat', plainChat.join(',') === 'boot-settings,repl', plainChat.join(','))
  check('plain world (concourse off) stops = menu · chat', plainOff.join(',') === 'boot-settings,repl', plainOff.join(','))
  check('the plain-world hint reads "⇧← boot face" (host-spelled)', stripKeyMapHintOf('repl', plainChat) === keyHintLabel('⇧← boot face'), stripKeyMapHintOf('repl', plainChat))
  check('…in both plain spellings', stripKeyMapHintOf('repl', plainOff) === keyHintLabel('⇧← boot face'))

  check('no stops ⇒ empty hint', stripKeyMapHintOf('repl', []) === '', JSON.stringify(stripKeyMapHintOf('repl', [])))
}


section('§3 the footer spells the chord in its own row\'s grammar: "shift + ←", beside "shift + ↵ for a new line", on every host')
{
  check('the concourse present: "shift + ← concourse"', footerStripHint('⇧← concourse') === 'shift + ← concourse', footerStripHint('⇧← concourse'))
  check('the off-mac spelling folds to the same words (Windows reads the same row)', footerStripHint(keyHintLabel('⇧← concourse', 'windows')) === 'shift + ← concourse', footerStripHint(keyHintLabel('⇧← concourse', 'windows')))
  check('the plain world: "shift + ← boot face"', footerStripHint('⇧← boot face') === 'shift + ← boot face')
  check('no stop ⇒ still nothing', footerStripHint('') === '')
  check('the stop name stays router-derived (only the chord is respelled)', footerStripHint('⇧← anything') === 'shift + ← anything')
  check('no ⇧ survives into the footer row', !footerStripHint(stripKeyMapHintOf('repl', stripStops({ concourseEnabled: true, chatBoot: false, chatPresent: true }))).includes('⇧'))
  check('the row reads one grammar: both hints open with "shift + "', footerStripHint('⇧← concourse').startsWith('shift + ') && 'shift + ↵ for a new line'.startsWith('shift + '))
}

if (failures > 0) {
  console.error(`\n❌ ${failures} FOOTER-STRIP-HINT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL FOOTER-STRIP-HINT PROOFS PASS')
