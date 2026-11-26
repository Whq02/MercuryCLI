#!/usr/bin/env bun
export {}

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond && fix) console.log(`      fix: ${fix}`)
}
const stopsFix = 'change stripStops in src/screen/routes/surfaceRoute.ts so the stops match the expected world'
const strippedHintFix = 'change stripKeyMapHintOf in src/screen/routes/surfaceRoute.ts so the hint names the next stop (concourse or boot face) through keyHintLabel'
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { stripKeyMapHintOf, stripStops } = await import('../../src/screen/routes/surfaceRoute.js')
const { keyHintLabel } = await import('../../src/screen/widgets/keyHintLabel.js')
section('§1 the derivation — both worlds, through the real strip owners')
{
  const full = stripStops({ concourseEnabled: true, chatBoot: false, chatPresent: true })
  check('full world stops = menu · concourse · chat', full.join(',') === 'boot-settings,concourse,repl', full.join(','), stopsFix)
  check('the chat footer hint reads "⇧← concourse" (host-spelled)', stripKeyMapHintOf('repl', full) === keyHintLabel('⇧← concourse'), stripKeyMapHintOf('repl', full), strippedHintFix)

  const plainChat = stripStops({ concourseEnabled: true, chatBoot: true, chatPresent: true })
  const plainOff = stripStops({ concourseEnabled: false, chatBoot: false, chatPresent: true })
  check('plain world (--chat) stops = menu · chat', plainChat.join(',') === 'boot-settings,repl', plainChat.join(','), stopsFix)
  check('plain world (concourse off) stops = menu · chat', plainOff.join(',') === 'boot-settings,repl', plainOff.join(','), stopsFix)
  check('the plain-world hint reads "⇧← boot face" (host-spelled)', stripKeyMapHintOf('repl', plainChat) === keyHintLabel('⇧← boot face'), stripKeyMapHintOf('repl', plainChat), strippedHintFix)
  check('…in both plain spellings', stripKeyMapHintOf('repl', plainOff) === keyHintLabel('⇧← boot face'), '', strippedHintFix)

  check('no stops ⇒ empty hint', stripKeyMapHintOf('repl', []) === '', JSON.stringify(stripKeyMapHintOf('repl', [])), 'make stripKeyMapHintOf in src/screen/routes/surfaceRoute.ts return an empty string when there are no stops')
}
if (failures > 0) {
  console.error(`\n❌ ${failures} FOOTER-STRIP-HINT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL FOOTER-STRIP-HINT PROOFS PASS')
