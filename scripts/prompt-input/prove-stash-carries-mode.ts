#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.TMPDIR ?? '/private/tmp/mw', 'stash-mode-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const pending = await import('../../src/input-core/pending-input.ts')

console.log('============================================================')
console.log(' ctrl+s stash of a shell-mode line: the mode rides the pocket')
console.log('============================================================')

pending.resetPendingInputForTests()
pending.setMode('bash')
pending.edit('ls -la')
pending.setPastedContents({ 1: { id: 1, type: 'text', content: 'pasted body' } })
check('control: a shell line is drafted in shell mode', pending.mode() === 'bash' && pending.text() === 'ls -la')

pending.stashDraft(6)
const stashed = pending.stashedPrompt()
console.log(`  observed after the stash: text=${JSON.stringify(pending.text())} mode=${pending.mode()} record=${JSON.stringify(stashed)}`)
check('the stash record names the mode the line was typed in', stashed?.mode === 'bash', `record=${JSON.stringify(stashed)}`)
check('the stash record keeps the text, the cursor and the pastes', stashed?.text === 'ls -la' && stashed?.cursorOffset === 6 && stashed?.pastedContents[1]?.content === 'pasted body')
check('the emptied composer is back in prompt mode (the next words are a prompt, not a command)', pending.text() === '' && pending.mode() === 'prompt', `mode=${pending.mode()}`)
check('the emptied composer carries no pastes', Object.keys(pending.pastedContents()).length === 0)

pending.edit('a prompt typed meanwhile')
pending.edit('')
const restored = pending.popStash()
console.log(`  observed after the restore: text=${JSON.stringify(pending.text())} mode=${pending.mode()}`)
check('the restored line comes back as a shell line', pending.mode() === 'bash' && pending.text() === 'ls -la', `mode=${pending.mode()}: the line would be sent as a chat message`)
check('the pop hands back the record and empties the pocket', restored?.cursorOffset === 6 && pending.stashedPrompt() === undefined)
check('the restored pastes ride the pocket', pending.pastedContents()[1]?.content === 'pasted body')
check('a second pop finds nothing', pending.popStash() === undefined)

pending.resetPendingInputForTests()
pending.edit('plain words')
pending.stashDraft(3)
check('a prompt-mode line is pocketed in prompt mode', pending.stashedPrompt()?.mode === 'prompt' && pending.mode() === 'prompt')
pending.popStash()
check('a prompt-mode line comes back in prompt mode', pending.mode() === 'prompt' && pending.text() === 'plain words')

pending.resetPendingInputForTests()
pending.edit('durable cursor')
pending.reportCursor(4)
pending.stashDraft()
check('the pocket reads the durable cursor when none is handed in', pending.stashedPrompt()?.cursorOffset === 4)

await pending.flushDrafts()
console.log(failures === 0 ? '\nGREEN: the stash round-trips the composer mode' : `\nRED: ${failures} check(s) show the stash drops the shell mode`)
process.exit(failures === 0 ? 0 : 1)
