#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startScriptedFixture } from '../lib/scriptedTurn.ts'
import { dist, quote, sessionFilesOf, type Row } from './lib/runDoor.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
const check = (label: string, good: boolean, detail = ''): void => {
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
if (!existsSync(dist)) {
  console.log(`FAIL — ${dist} is missing; build first`)
  process.exit(1)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-broken-settings-')))
const home = join(root, 'home')
const cwd = join(root, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(join(cwd, '.mercury'), { recursive: true })
seedFirstRun(home, [cwd])
const note = join(cwd, 'note.txt')
writeFileSync(note, 'the note\n')
const marks = join(root, 'marks.txt')
const projectFile = join(cwd, '.mercury', 'settings.json')
const GOOD = { events: { hooks: { 'tool.before': [{ name: 'guard', match: 'Read', run: `echo "$MERCURY_HOOK_EVENT" >> ${quote(marks)}` }] } } }
const BROKEN = '{ "events": { "hooks": { "tool.before": [ { "name": "guard", "match": "Read", "run": "echo never", }, ] } }'
writeFileSync(projectFile, JSON.stringify(GOOD, null, 2))
const marksCount = (): number => (existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean).length : 0)

const fixture = await startScriptedFixture(req => (req.step === 0 ? [{ type: 'tool_use', name: 'Read', input: { file_path: note } }] : [{ type: 'text', text: req.ask.includes('again') ? 'second answer' : 'first answer' }]))
const child = spawn('node', [dist, 'run', '--input', 'rows', '--format', 'rows'], {
  cwd,
  env: {
    ...process.env,
    HOME: home,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
    ANTHROPIC_BASE_URL: fixture.base,
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
const rows: Row[] = []
const waiters: Array<() => void> = []
child.stdout.on('data', bytes => {
  stdout += String(bytes)
  const lines = stdout.split('\n')
  stdout = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line) as Row)
    } catch {
      rows.push({ bad: line })
    }
  }
  for (const wake of waiters.splice(0)) wake()
})
child.stderr.on('data', bytes => { stderr += String(bytes) })
const guard = setTimeout(() => child.kill('SIGKILL'), 120_000)
const closed = new Promise<number | null>(resolve => child.once('close', resolve))
const outcomes = (): Row[] => rows.filter(row => row.type === 'outcome')
const waitForOutcomes = async (n: number, budgetMs: number): Promise<boolean> => {
  const until = Date.now() + budgetMs
  while (outcomes().length < n && Date.now() < until) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 250)
      waiters.push(() => { clearTimeout(timer); resolve() })
    })
  }
  return outcomes().length >= n
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

child.stdin.write(`${JSON.stringify({ type: 'prompt', content: 'read the note' })}\n`)
const firstDone = await waitForOutcomes(1, 60_000)
check('turn 1 completes with the hook file intact', firstDone && outcomes()[0]?.status === 'completed', JSON.stringify(outcomes()[0]) + stderr.slice(0, 300))
const marksAfterFirst = marksCount()
check('the project tool.before hook fired for the first Read', marksAfterFirst === 1, `${marksAfterFirst} mark(s)`)
check('no settings fault was named at the start: the file was good', !/settings: /.test(stderr), stderr.slice(0, 300))

writeFileSync(projectFile, BROKEN)
await sleep(4_000)
child.stdin.write(`${JSON.stringify({ type: 'prompt', content: 'read the note again' })}\n`)
const secondDone = await waitForOutcomes(2, 60_000)
child.stdin.end()
const code = await closed
clearTimeout(guard)
await fixture.close()

check('turn 2 completes after the file was broken mid-session', secondDone && outcomes()[1]?.status === 'completed' && code === 0, `${code} ${JSON.stringify(outcomes()[1])} ${stderr.slice(0, 300)}`)
const marksAfterSecond = marksCount()
check('the hook still fired for the second Read: a one-character slip in the file does not switch the guard off', marksAfterSecond === 2, `${marksAfterSecond} mark(s) after two Reads`)
const sessionRows = sessionFilesOf(home)
const saidInChat = sessionRows.filter(row => JSON.stringify(row).includes('the last good settings stay in force'))
check('the chat was told once: one row names the file, the malformed JSON and what stands', saidInChat.length === 1 && JSON.stringify(saidInChat[0]).includes('settings.json · The settings file contains malformed JSON (or is empty) — the file cannot be read; the last good settings stay in force'), `${saidInChat.length} row(s): ${JSON.stringify(saidInChat).slice(0, 400)}`)
check('the hook fired without a word of failure', !rows.some(row => row.type === 'notice' && /hook/.test(String(row.text))), JSON.stringify(rows.filter(row => row.type === 'notice')))

rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\nprove-hooks-survive-broken-settings: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-hooks-survive-broken-settings: all green')
