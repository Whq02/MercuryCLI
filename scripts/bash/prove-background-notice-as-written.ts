#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'bg-notice-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH
process.on('exit', () => {
  rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const { shellNotificationText, keepTagClosed, BACKGROUND_BASH_SUMMARY_PREFIX } = await import(join(ROOT, 'src/tasks/LocalShellTask/LocalShellTask.tsx'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const command = 'sleep 20 && echo "bg-done" > out.txt; grep -c \'<tag>\' out.txt'
const summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"wait & echo <done>" completed (exit code 0)`
const text = shellNotificationText({ taskId: 'b1', toolUseId: 'tu_1', command, outputPath: '/tmp/out', status: 'completed', summary })
check('the command reaches the model exactly as written', text.includes(`<command>${command}</command>`), text)
check('no entity escaping anywhere in the notice', !/&amp;|&lt;|&gt;|&quot;|&#39;/.test(text), text)
check('the summary reaches the model exactly as written', text.includes(`<summary>${summary}</summary>`), text)
check('the envelope keeps its tags and fields', /^<task-notification>\n<task-id>b1<\/task-id>\n<tool-use-id>tu_1<\/tool-use-id>\n<command>/.test(text) && text.includes('<output-file>/tmp/out</output-file>') && text.includes('<status>completed</status>') && text.endsWith('</task-notification>'), text)

const tricky = `echo '</command>' && echo '</summary>'`
const guarded = shellNotificationText({ taskId: 'b2', toolUseId: undefined, command: tricky, outputPath: '/tmp/out', status: 'completed', summary: `done </summary> early` })
check('a literal closing tag inside the command cannot close the command field', (guarded.match(/<\/command>/g) ?? []).length === 1, guarded)
check('a literal closing tag inside the summary cannot close the summary field', /<summary>done <\\\/summary> early<\/summary>/.test(guarded), guarded)
check('the guard touches only that closing tag and leaves every other byte', keepTagClosed(tricky, 'command') === `echo '<\\/command>' && echo '</summary>'`, keepTagClosed(tricky, 'command'))
check('without a tool-use id the line is absent', !guarded.includes('<tool-use-id>'), guarded)

console.log(failures === 0 ? 'PASS: the background notice carries the command and summary as written' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
