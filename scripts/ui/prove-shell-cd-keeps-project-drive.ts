#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { grabScreens, requireDist, runArtifactArena } from '../streaming/artifactArena.ts'

requireDist()

const CAPTURE_DIR = process.env.MERCURY_SHELL_CD_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const flat = (rows: string[]): string => rows.map(r => r.replace(/\s+$/, '')).join('\n')
const rowsWith = (rows: string[], needle: string): string => rows.filter(r => r.includes(needle)).map(r => r.trim().slice(0, 140)).join(' | ') || `(no row carries "${needle}")`
function dump(label: string, rows: string[] | undefined): void {
  if (!CAPTURE_DIR || rows === undefined) return
  writeFileSync(join(CAPTURE_DIR, `${label}.txt`), flat(rows) + '\n')
}

const ENTER_SCRATCH = 'Enter the scratch folder'
const PRINT_FOLDER = 'Leave a marker in the shell folder'
const MARKER = 'here.txt'
const CLOSING = 'All done here.'
const FILE = 'notes.txt'

section("§1 the model's cd moves the shell, never the session: the FILES rail and the folder chip keep the project, the Edit card names the file from the project, and the Bash card still says where the command runs")
const run = await runArtifactArena({
  cols: 120,
  rows: 50,
  seedCwd: { [FILE]: 'alpha line\n' },
  turns: cwd => [
    { kind: 'tool_use', preText: 'Entering the scratch folder.\n', name: 'Bash', input: { command: 'mkdir -p scratch && cd scratch && pwd', description: ENTER_SCRATCH } },
    { kind: 'tool_use', name: 'Read', input: { file_path: join(cwd, FILE) } },
    { kind: 'tool_use', name: 'Edit', input: { file_path: join(cwd, FILE), old_string: 'alpha', new_string: 'beta' } },
    { kind: 'tool_use', name: 'Bash', input: { command: `pwd && touch ${MARKER}`, description: PRINT_FOLDER } },
    { kind: 'text', text: CLOSING },
  ],
  sends: [
    { awaitText: 'Type a prompt', text: 'go' },
    { awaitText: '❯ go', text: '\r' },
    { awaitText: ENTER_SCRATCH, afterPrevMs: 600, text: '1' },
    { awaitText: 'make this edit', afterPrevMs: 600, text: '1' },
    { awaitText: PRINT_FOLDER, afterPrevMs: 600, text: '1' },
    { awaitText: CLOSING, afterPrevMs: 1000, text: '' },
  ],
  anchor: null,
  seconds: 40,
  keep: true,
})
try {
  const project = basename(run.paths.cwd)
  const sent = run.sendLog.map(s => Buffer.from(s.b64, 'base64').toString('latin1'))
  check('the drive delivered every send (three cards answered, the turn settled)', sent.length === 6, `${sent.length} sends: ${JSON.stringify(sent)} · ${run.driverOut.slice(-300)}`)
  const editCard = run.sendLog[3]?.screen
  const pwdCard = run.sendLog[4]?.screen
  const settled = run.sendLog[5]?.screen
  dump('edit-card', editCard)
  dump('pwd-card', pwdCard)
  dump('settled', settled)
  if (editCard !== undefined && pwdCard !== undefined && settled !== undefined) {
    const editText = flat(editCard)
    const titleAt = editCard.findIndex(r => r.includes('Edit file'))
    const pathRow = (editCard[titleAt + 1] ?? '').replace(/│/g, '').trim()
    check(`after the cd the Edit card names the file from the project — "${FILE}", not a ../ path`, titleAt >= 0 && pathRow === FILE && !editText.includes(`../${FILE}`), `path row ${JSON.stringify(pathRow)} · ${rowsWith(editCard, FILE)}`)
    check('the FILES rail still names the project while the shell sits in scratch', editCard.some(r => r.includes('FILES ·') && r.includes(project.slice(0, 12))) && !editCard.some(r => r.includes('FILES · scratch')), rowsWith(editCard, 'FILES'))
    const cwdAt = pwdCard.findIndex(row => /^\s*│\s+in /.test(row))
    const cwdEnd = pwdCard.findIndex((row, index) => index > cwdAt && row.includes('Do you want to proceed?'))
    const printedCwd = pwdCard.slice(cwdAt, cwdEnd).map(row => row.replace(/^\s*│\s*|\s*│\s*$/g, '')).join('').replace(/^in /, '')
    check('the Bash card says where its command runs — the shell\'s folder, scratch', cwdAt >= 0 && cwdEnd > cwdAt && printedCwd === join(run.paths.cwd, 'scratch'), printedCwd)
    check('the folder chip on the status row keeps the project, not scratch', pwdCard.some(r => /esc interrupts|⇧← back/.test(r) && r.includes(project.slice(0, 12)) && !/\bscratch\b/.test(r)), rowsWith(pwdCard, '⇧← back'))
    const settledText = flat(settled)
    check('the turn settled (the closing text landed)', settledText.includes(CLOSING), rowsWith(settled, 'done'))
    check('the turn settled with the folder chip on the project', settled.some(r => r.includes('ready') && r.includes(project.slice(0, 12)) && !/\bscratch\b/.test(r)), rowsWith(settled, 'ready'))
  }
  check('the shell\'s folder persisted between the two commands: the marker landed in scratch, not in the project root', existsSync(join(run.paths.cwd, 'scratch', MARKER)) && !existsSync(join(run.paths.cwd, MARKER)), `${join(run.paths.cwd, 'scratch', MARKER)} exists=${existsSync(join(run.paths.cwd, 'scratch', MARKER))}`)
  const [final] = grabScreens(run, 120, 50, [-1])
  dump('final', final!.rows)
  check('the session root never moved: the FILES rail reads the project at the end', final!.rows.some(r => r.includes('FILES ·') && r.includes(project.slice(0, 12))), rowsWith(final!.rows, 'FILES'))
} finally {
  run.cleanup()
}

console.log(`\n${failures === 0 ? '✅ shell-cd-keeps-project PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
