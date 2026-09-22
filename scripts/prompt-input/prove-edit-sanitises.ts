#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.TMPDIR ?? '/private/tmp/mw', 'edit-sanitises-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const pending = await import('../../src/input-core/pending-input.ts')
const drafts = await import('../../src/utils/promptDraft.ts')

console.log('============================================================')
console.log(' the composer\'s one edit path strips what no road may carry')
console.log(' (an editor return, a history line, a seed, a draft from disk)')
console.log('============================================================')

const cases: Array<[string, string, string]> = [
  ['an SGR colour run', 'see \x1b[31mred\x1b[0m words', 'see red words'],
  ['an OSC title sequence with its BEL', 'before\x1b]0;title\x07after', 'beforeafter'],
  ['an OSC 52 clipboard write with its ST', 'x\x1b]52;c;aGVsbG8=\x1b\\y', 'xy'],
  ['a cursor motion and an erase', 'a\x1b[2Kb\x1b[3Ac', 'abc'],
  ['C0 controls between letters', 'a\x01b\x07c\x1fd', 'abcd'],
  ['a DEL byte', 'ab\x7fc', 'abc'],
  ['an 8-bit C1 introducer leaves the next letter intact', 'a\u009bmb', 'amb'],
  ['CRLF and a lone CR become line breaks', 'one\r\ntwo\rthree', 'one\ntwo\nthree'],
  ['a tab becomes four spaces, as a paste\'s does', 'a\tb', 'a    b'],
  ['clean text with a newline and wide glyphs stays byte for byte', 'plain 世界 text\nline two', 'plain 世界 text\nline two'],
]

for (const [label, raw, want] of cases) {
  pending.resetPendingInputForTests()
  pending.edit(raw)
  const got = pending.text()
  check(`edit(): ${label}`, got === want, `text=${JSON.stringify(got)}`)
}

pending.resetPendingInputForTests()
pending.edit('seed ')
pending.append('\x1b[1mbold\x1b[22m')
check('append(): a seed rides the same strip', pending.text() === 'seed bold', JSON.stringify(pending.text()))

pending.resetPendingInputForTests()
drafts.saveDraftDebounced('disk-session', { text: 'from \x1b[7mdisk\x1b[27m\x07', cursorOffset: 4, mode: 'prompt', pastedContents: {} })
await drafts.flushDraftSaves()
check('control: the raw draft is on disk with its escape bytes', drafts.readDraftSync('disk-session')?.text.includes('\x1b') === true)
pending.initSession('disk-session', '')
check('initSession(): a draft restored from disk is stripped', pending.text() === 'from disk', JSON.stringify(pending.text()))

pending.resetPendingInputForTests()
pending.initSession('other-session', '')
await pending.rekeyToSession('disk-session')
check('rekeyToSession(): a draft restored by the hop is stripped', pending.text() === 'from disk', JSON.stringify(pending.text()))

pending.resetPendingInputForTests()
pending.initSession('early-session', 'early \x1b[4mwords\x1b[24m')
check('initSession(): early input is stripped', pending.text() === 'early words', JSON.stringify(pending.text()))

await pending.flushDrafts()
console.log(failures === 0 ? '\nGREEN: every road into the composer is stripped at the one edit path' : `\nRED: ${failures} check(s) show a road that carries escape bytes into the composer`)
process.exit(failures === 0 ? 0 : 1)
