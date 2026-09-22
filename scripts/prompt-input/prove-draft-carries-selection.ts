#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.TMPDIR ?? '/private/tmp/mw', 'draft-selection-'))
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
console.log(' the editor\'s selection rides the draft: set, taken with the words, back with them')
console.log('============================================================')

const selection = { lineCount: 3, text: 'const a = 1\nconst b = 2\nconst c = 3', filePath: '/w/src/a.ts', lineStart: 10 }

pending.resetPendingInputForTests()
pending.initSession('sel-session', '')
pending.edit('explain these lines')
pending.setSelection(selection)
check('the draft carries the selection the editor reported', pending.selection()?.lineStart === 10 && pending.selection()?.lineCount === 3, JSON.stringify(pending.selection()))

pending.clearForSubmit('explain these lines')
const staged = pending.stagedSubmit()
console.log(`  observed after the submit: draft selection=${JSON.stringify(pending.selection())} staged=${JSON.stringify(staged)}`)
check('the submit moves the selection into the staged record with its words', staged?.text === 'explain these lines' && staged?.selection?.filePath === '/w/src/a.ts', JSON.stringify(staged))
check('the taken draft holds no selection', pending.selection() === undefined, JSON.stringify(pending.selection()))

const back = pending.restoreStaged()
console.log(`  observed after the restore: text=${JSON.stringify(pending.text())} selection=${JSON.stringify(pending.selection())}`)
check('the words come back into the composer with their selection', back !== null && pending.text() === 'explain these lines' && pending.selection()?.lineStart === 10, JSON.stringify(pending.selection()))
check('the staged record settles on the restore', pending.stagedSubmit() === null)
check('a second restore finds nothing', pending.restoreStaged() === null)

pending.setSelection(undefined)
check('the editor clearing its selection clears the draft\'s', pending.selection() === undefined)

pending.setSelection(selection)
pending.edit('')
check('emptying the composer keeps the live selection (it is the editor\'s report, not the words\')', pending.selection()?.lineStart === 10)

pending.clearForSubmit('other words')
pending.clearStaged()
check('a settled staged record carries nothing back', pending.restoreStaged() === null && pending.text() === '')

pending.resetPendingInputForTests()
pending.edit('sent words')
pending.setSelection(selection)
pending.clearForSubmit('sent words')
pending.edit('')
check('a refused send asking for other words restores nothing (a stale record never comes back)', pending.restoreStaged('later words') === null && pending.text() === '' && pending.selection() === undefined)
check('a refused send asking for its own words gets them back with their selection', pending.restoreStaged('sent words')?.text === 'sent words' && pending.text() === 'sent words' && pending.selection()?.filePath === '/w/src/a.ts')

const repl = readFileSync(new URL('../../src/screens/REPL.tsx', import.meta.url), 'utf8')
check('the refused-send road restores the staged record by its own words', repl.includes("if (pendingInput.restoreStaged(input) === null) setInputValue(input);"))
check('the stash pop after a seat command restores the pocket whole', repl.includes('pendingInput.popStash();') && !repl.includes('setInputValue(stash.text)'))
check('the editor\'s reported selection is written to the store by the one setter', repl.includes('pendingInput.setSelection(next);'))

await pending.flushDrafts()
const onDisk = drafts.readDraftSync('sel-session')
check('the selection never reaches the disk draft (a live editor report is not a page)', onDisk === null || !('selection' in onDisk), JSON.stringify(onDisk))

console.log(failures === 0 ? '\nGREEN: the selection rides the draft through the submit and back' : `\nRED: ${failures} check(s) show the selection dropped on the round trip`)
process.exit(failures === 0 ? 0 : 1)
