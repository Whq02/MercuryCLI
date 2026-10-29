#!/usr/bin/env bun
// gate-watch: src/components/messages/CollapsedReadSearchContent* src/components/MessageRow* src/components/Messages*
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grabScreens, requireDist, runArtifactArena, sendStamp } from '../streaming/artifactArena.ts'

requireDist()

const CAPTURE_DIR = process.env.MERCURY_PENDING_CARD_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const NEEDLE = 'Do you want to proceed'
const CTRL_F = '\\x06'
const ESC = '\\x1b'
const MARKER = 'card-a.txt'
const RAN = /Ran 1 bash command/
const RUNNING = /Running 1 bash command/
const BLOCKED = /Blocked 1 bash command/
const DECLINED = 'The operator declined this tool call'

const flat = (rows: string[]): string => rows.map(r => r.replace(/\s+$/, '')).join('\n')
const transcriptRow = (rows: string[]): string => rows.find(r => /bash command/i.test(r))?.trim() ?? '(no bash-command row on the frame)'
function dump(label: string, rows: string[]): void {
  if (!CAPTURE_DIR) return
  writeFileSync(join(CAPTURE_DIR, `${label}.txt`), flat(rows) + '\n')
}

section('§1 a Bash card waits for the operator — the folded row never says "Ran" for a command that has not run')
const run = await runArtifactArena({
  cols: 120,
  rows: 50,
  turns: () => [
    { kind: 'tool_use', preText: 'Touching the file.\n', name: 'Bash', input: { command: `touch ${MARKER}`, description: 'Create an empty marker file' } },
    { kind: 'text', text: 'Done.' },
  ],
  sends: [
    'after:Type a prompt:300:hello',
    'after:hello:400:\\r',
    `after:${NEEDLE}:1500:${CTRL_F}`,
    `after:${NEEDLE}:4500:${ESC}`,
  ],
  anchor: { needle: NEEDLE, atMs: 8000 },
  seconds: 22,
  keep: true,
})
try {
  const chord = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('latin1') === '\x06')
  const esc = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString('latin1') === '\x1b')
  check('the card painted its question and both witnessed sends were delivered', chord !== undefined && esc !== undefined, run.driverOut.slice(-300))
  if (chord !== undefined && esc !== undefined) {
    const [open] = grabScreens(run, 120, 50, [sendStamp(run, chord) + 600])
    const openRows = open!.rows
    dump('card-open', openRows)
    const openText = flat(openRows)
    check('the card is on the frame while the call waits', openText.includes(NEEDLE) && openText.includes(`touch ${MARKER}`), transcriptRow(openRows))
    check('the row above the waiting card does NOT say "Ran 1 bash command"', !RAN.test(openText), transcriptRow(openRows))
    check('the row says the command is still running (unsettled), never settled', RUNNING.test(openText), transcriptRow(openRows))
    check('the card names the folder the command runs in', /\bin \S*flux-arena-cwd/.test(openText), openRows.filter(r => r.includes(' in ')).join(' | ').slice(0, 200))

    const [after] = grabScreens(run, 120, 50, [-1])
    const afterRows = after!.rows
    dump('after-decline', afterRows)
    const afterText = flat(afterRows)
    check('the card is gone after esc', !afterText.includes(NEEDLE))
    check('the declined call is counted as blocked, never as ran', BLOCKED.test(afterText) && !RAN.test(afterText), transcriptRow(afterRows))
    check('the decline line rides under the row', afterText.includes(DECLINED), afterRows.filter(r => r.includes('└')).join(' | ').slice(0, 200))
    check('the turn settled (the fixture\'s closing text landed)', afterText.includes('Done.'), transcriptRow(afterRows))
  }
  check('the canary holds — the marker file was never created, so nothing ran', !existsSync(join(run.paths.cwd, MARKER)))
} finally {
  run.cleanup()
}

console.log(`\n${failures === 0 ? '✅ pending-card-not-ran PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
