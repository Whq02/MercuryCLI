#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-brief-headless.ts
//  REGRESSION GUARD for the "empty but billed `-p`" bug.
//
//  Root cause (fixed): brief / assistant mode is default-ON, so
//  it leaked into a plain non-interactive `-p`/SDK run — where there is NO
//  chatroom and stdout (the result text) IS the channel. The brief stop-hook
//  then nagged "you didn't call SendUserMessage" (a FALSE statement in `-p`),
//  burned a 2nd API turn, and left a synthetic USER message as the terminal
//  message ⇒ QueryEngine read result='' ⇒ blank, billed output.
//
//  The fix is two parts, both off-dist (asserted STRUCTURALLY — BriefTool reaches
//  feature()/native deps so it is not bun-run loadable; see the loadability note):
//    1. isBriefEntitled(): the fork DEFAULT-ON does NOT grant brief in a
//       non-interactive session absent explicit opt-in (MERCURY_BRIEF=1 /
//       a pre-set userMsgOptIn / an active assistant session). Interactive REPL unaffected.
//       Uses NO scribe-ROLE term (mode-not-role invariant; the inert-env class).
//    2. QueryEngine result extraction reads the LAST TEXT block (robust to a
//       trailing thinking/tool_use/synthetic block), not merely the last block.
//
//  Run: ~/.bun/bin/bun run scripts/scribe/prove-brief-headless.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Headless `-p` brief-suppression — regression guard')
console.log('============================================================')

const brief = src('tools', 'BriefTool', 'BriefTool.ts')

section('isBriefEntitled() — non-interactive brief suppression')
check(
  'imports getIsNonInteractiveSession from bootstrap/state',
  // away-scope: the import also carries isAssistantSessionActive —
  // pin the members, not the exact order/width.
  /import \{[^}]*getIsNonInteractiveSession[^}]*getUserMsgOptIn[^}]*\} from '\.\.\/\.\.\/bootstrap\/state\.js'/.test(brief),
)
check(
  'defines explicitBriefOptIn = userMsgOptIn / MERCURY_BRIEF=1 / assistant-session (the one registered spelling)',
  /const explicitBriefOptIn =[\s\S]{0,80}getUserMsgOptIn\(\)[\s\S]{0,80}flagEnv\('MERCURY_BRIEF'\) === '1'[\s\S]{0,80}isAssistantSessionActive\(\)/.test(brief),
)
check(
  'non-interactive + no explicit opt-in ⇒ brief NOT entitled (the fix)',
  /if \(getIsNonInteractiveSession\(\) && !explicitBriefOptIn\) \{[\s\S]{0,40}return false/.test(brief),
)
check(
  'the suppression sits AFTER the Implementer early-return ',
  /isImplementerRole[\s\S]{0,2500}if \(getIsNonInteractiveSession\(\) && !explicitBriefOptIn\)/.test(brief),
)
check(
  'MERCURY_BRIEF=0 hard-kill still present (above the suppression, alias-read)',
  /if \(flagEnv\('MERCURY_BRIEF'\) === '0'\) return false[\s\S]{0,2500}if \(getIsNonInteractiveSession\(\)/.test(brief),
)

section('mode-not-role invariant — the suppression must NOT use isScribeRole')
check(
  'scribeGates import is the exact 3-symbol form (no isScribeRole re-introduced)',
  /import \{ isImplementerRole, scribeChatroomEnabled, scribeModeEnabled \} from '\.\.\/\.\.\/utils\/scribe\/scribeGates\.js'/.test(brief),
)
check(
  'isScribeRole is NOT imported into BriefTool',
  !/import \{[^}]*\bisScribeRole\b[^}]*\} from/.test(brief),
)

section('QueryEngine result extraction — last TEXT block, not last block')
// The extraction lives in the turn machine since the run-core landing.
const tm = src('run-core', 'turn-machine.ts')
check(
  'filters assistant content to text blocks',
  /const textBlocks = lastAssistantMessage\.message\.content\.filter\(\s*\n?\s*block => block\.type === 'text',/.test(tm),
)
check('takes the LAST text block (textBlocks.at(-1))', /const lastTextBlock = textBlocks\.at\(-1\)/.test(tm))
check(
  'the fragile "last content block must be text" extraction is gone',
  !/lastContent\?\.type === 'text'/.test(tm) && !/lastContent\?\.type === 'text'/.test(src('QueryEngine.ts')),
)

console.log('\n' + '═'.repeat(76))
if (failures === 0) {
  console.log('✅ ALL HEADLESS-BRIEF REGRESSION CHECKS PASS')
  console.log('═'.repeat(76))
  process.exit(0)
} else {
  console.log(`❌ ${failures} HEADLESS-BRIEF CHECK(S) FAILED`)
  console.log('═'.repeat(76))
  process.exit(1)
}
